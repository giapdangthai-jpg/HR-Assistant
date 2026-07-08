// Company-wide monthly report — copies the master template into the target
// Drive folder (once per month, skipped if it already exists) and writes
// real Jira/Tempo data into its "Jira log", "Jira absence", "Jira OT" tabs.
// The "Timesheet ", "OT", "MISC" tabs read from those three via formulas
// (VLOOKUP by CODE/JIRA name) and each has its own Month (F1) / Year (H1)
// cell driving a cascading date row from E5 onward (E5 = DATE(H1,F1,1),
// every following cell = previous+1) — those two cells get updated to the
// target month/year on every run so the date row and VLOOKUPs line up with
// the data just written. It also writes each employee's WFH total for the
// target month into the "WFH" tab's matching month column (see
// scripts/lib/wfh.js — that tab has no Jira/Tempo equivalent at all).
//
// No employee roster is needed for the Jira-derived tabs: Tempo's
// company-wide worklogs endpoint already reports everyone who logged any
// time in the period, so every person is discovered straight from actual
// worklog data.
//
// Exports one function per action — no process.exit, matching PM
// Assistant's tool convention (this runs inside an MCP server where
// exiting the process kills every other tool call too).

import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { loadConfig, updateConfig } from "./lib/store.js";
import { getJiraUser, findJiraUserByEmail } from "./lib/jira.js";
import { fetchCompanyWorklogsInRange, normalizeTempoWorklog } from "./lib/tempo.js";
import { monthRange, MONTH_SHORT, MONTH_FULL, workdaysInRange, todayVN, resolveMonthPeriod } from "./lib/dates.js";
import { driveFindFileByName, driveCopyFile, sheetsReplaceSheetContents, sheetsUpdateValues, sheetsGetValues } from "./lib/gsheets.js";
import { resolveSlackChannel, getSlackUserEmail, postAndGetLink } from "./lib/slack.js";
import { scanWfhChannel } from "./lib/wfh.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const RUN_JSON = resolve(__dir, "../config/export_report_run.json");

function loadRun() {
  if (!existsSync(RUN_JSON)) return null;
  try { return JSON.parse(readFileSync(RUN_JSON, "utf8")); } catch { return null; }
}
function saveRun(run) {
  writeFileSync(RUN_JSON, JSON.stringify(run, null, 2), "utf8");
}

function ordinalSuffix(n) {
  if (n % 100 >= 11 && n % 100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

function extractDriveId(url) {
  const m = url.match(/\/(?:spreadsheets\/d|folders)\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : url;
}

// Partial update: setting only one of templateUrl/folderUrl must not wipe
// out the other one that was already configured — needed for the
// one-field-at-a-time config wizard flow (hr_config).
export function exportReportConfigure({ templateUrl, folderUrl } = {}) {
  if (!templateUrl && !folderUrl) return "❌ Cần `templateUrl` và/hoặc `folderUrl`.";
  const patch = {};
  if (templateUrl) patch.templateFileId = extractDriveId(templateUrl);
  if (folderUrl)   patch.driveFolderId  = extractDriveId(folderUrl);
  updateConfig({ companyTimesheet: patch });
  const lines = [];
  if (templateUrl) lines.push(`✅ Đã lưu template: ${templateUrl}`);
  if (folderUrl)   lines.push(`✅ Đã lưu folder: ${folderUrl}`);
  return lines.join("\n");
}

// ── Per-employee row builders ─────────────────────────────────────

function pad2(n) { return String(n).padStart(2, "0"); }

// Shape shared by "Jira log" and "Jira absence": a Tempo Team-Timesheet-Report
// export (Full name, User Account ID, Logged/Billable/Planned/Required
// Hours+Seconds, Progress, Period, then one column per day).
function buildTimesheetReportRows(entries, dayList, requiredHours) {
  const header = [
    "Full name", "User Account ID", "Logged Hours", "Logged Seconds",
    "Billable Hours", "Billable Seconds", "Planned Hours", "Planned Seconds",
    "Required Hours", "Required Seconds", "Progress", "Period",
    ...dayList,
  ];
  const rows = [header];
  for (const { accountId, name, byDay, total } of entries) {
    if (total <= 0) continue; // matches the template's own behavior: zero-activity rows are omitted
    const progress = requiredHours > 0 ? Math.round((total / requiredHours) * 100) : 0;
    rows.push([
      name, accountId,
      total.toFixed(2), Math.round(total * 3600),
      total.toFixed(2), Math.round(total * 3600), // Billable mirrors Logged — no separate billable flag observed in source data
      0, 0,
      requiredHours.toFixed(2), Math.round(requiredHours * 3600),
      progress,
      "", // "Period" holds a submission/approval status in the template (e.g. "Ready to submit") — not computable from Jira/Tempo, left blank rather than guessed
      ...dayList.map(d => (byDay[d] || 0).toFixed(2)),
    ]);
  }
  return rows;
}

// Shape for "Jira OT": User, Overtime, Key, Logged, then one column per day
// — blank (not 0) for days with no OT, matching the template exactly.
function buildOvertimeRows(entries, dayList) {
  const header = ["User", "Overtime", "Key", "Logged", ...dayList];
  const rows = [header];
  for (const { name, byDay, total } of entries) {
    if (total <= 0) continue;
    rows.push([
      name, "Overtime", "", total,
      ...dayList.map(d => (byDay[d] ? byDay[d] : "")),
    ]);
  }
  return rows;
}

const WFH_MONTH_COLUMNS = ["E","F","G","H","I","J","K","L","M","N","O","P"]; // Jan..Dec

// The "WFH" tab has one row per employee (keyed by CODE, same static list
// the template's "Timesheet " tab has) and one column per month holding a
// plain hour total (NOT a formula, unlike Timesheet /OT/MISC) — so unlike
// the other three tabs, this one is a direct value write keyed by CODE, not
// something derivable from Jira/Tempo at all. Source of truth is the
// "wfh-request" Slack channel; see scripts/lib/wfh.js for why + how.
//
// Scans Slack + resolves Jira identities ONCE — this result gets written
// to multiple target sheets (the per-month copy AND, for this one tab
// only, the template — see exportReportRun). Computing it once and
// reusing it is required for correctness, not just efficiency: scanning
// live twice per target let two real WFH Slack messages that arrived in
// the few seconds between calls get counted in the second scan but not
// the first, so the two sheets ended up with slightly different totals
// for the exact same month — verified against real data (one person's
// total differed by exactly one 4h entry between two back-to-back runs).
async function computeWfhHours(cfg, month_) {
  const wfhChannelCfg = cfg.hr?.wfhChannel;
  if (!wfhChannelCfg) return { error: `⚠️ Chưa cấu hình hr.wfhChannel trong config.json — bỏ qua update sheet "WFH".` };
  const { id: wfhChannelId } = resolveSlackChannel(wfhChannelCfg);

  const entries = await scanWfhChannel(wfhChannelId);
  const monthPrefix = `${month_}-`;
  const monthEntries = entries.filter(e => e.date.startsWith(monthPrefix));

  const hoursBySlackUser = new Map();
  for (const e of monthEntries) hoursBySlackUser.set(e.slackUserId, (hoursBySlackUser.get(e.slackUserId) || 0) + e.hours);

  // Jira display names are matched by exact string against the
  // Timesheet's own JIRA column, but at least one real account has a
  // data-quality glitch — a leading space in its displayName ("
  // Ryan (The Anh) - Android - VN" vs "Ryan (The Anh) - Android - VN" in
  // the sheet) — that silently broke the match despite the person genuinely
  // having a CODE row. Trim both sides so whitespace alone can't cause a
  // false "not in CODE list" report.
  const hoursByJiraName = new Map();
  const unresolvedSlackUsers = [];
  for (const [slackUserId, hours] of hoursBySlackUser) {
    const email = await getSlackUserEmail(slackUserId);
    const jiraUser = email ? await findJiraUserByEmail(email) : null;
    if (!jiraUser) { unresolvedSlackUsers.push(slackUserId); continue; }
    hoursByJiraName.set(jiraUser.displayName.trim(), hours);
  }

  return { hoursByJiraName, unresolvedSlackUsers };
}

// Writes an already-computed WFH result into one target sheet — its own
// CODE list is read per-fileId since that can legitimately differ between
// targets (e.g. a new hire added to the template after older per-month
// copies were already made from it). Returns a list of report lines.
async function writeWfhToSheet(fileId, wfhResult, month) {
  if (wfhResult.error) return [wfhResult.error];
  const { hoursByJiraName, unresolvedSlackUsers } = wfhResult;

  // "Timesheet " is the canonical CODE -> JIRA-display-name list (a static
  // roster baked into the template, not something this server generates).
  const timesheetRows = await sheetsGetValues(fileId, "'Timesheet '!A7:C1000");
  const jiraNameByCode = new Map(timesheetRows.filter(r => r[0]).map(r => [r[0], (r[2] || "").trim()]));

  const wfhCodes = (await sheetsGetValues(fileId, "'WFH'!A2:A1000")).map(r => r[0]).filter(Boolean);
  if (!wfhCodes.length) return [];

  const monthCol = WFH_MONTH_COLUMNS[month - 1];
  const values = wfhCodes.map(code => {
    const jiraName = jiraNameByCode.get(code);
    return [jiraName && hoursByJiraName.has(jiraName) ? hoursByJiraName.get(jiraName) : 0];
  });
  await sheetsUpdateValues(fileId, `'WFH'!${monthCol}2:${monthCol}${1 + wfhCodes.length}`, values);

  const matchedJiraNames = new Set(wfhCodes.map(c => jiraNameByCode.get(c)).filter(Boolean));
  const unmatchedJiraNames = [...hoursByJiraName.keys()].filter(n => !matchedJiraNames.has(n));
  const totalHours = [...hoursByJiraName.values()].reduce((s, h) => s + h, 0);
  const lines = [`   WFH: ${hoursByJiraName.size} người, tổng ${totalHours}h.`];
  if (unresolvedSlackUsers.length) lines.push(`⚠️ WFH: không resolve được Jira cho ${unresolvedSlackUsers.length} Slack user: ${unresolvedSlackUsers.join(", ")}`);
  if (unmatchedJiraNames.length) lines.push(`⚠️ WFH: ${unmatchedJiraNames.length} người không có trong danh sách CODE của "Timesheet ": ${unmatchedJiraNames.join(", ")}`);
  return lines;
}

export async function exportReportRun({ month: monthArg, period } = {}) {
  let monthStr = monthArg;
  if (period) {
    monthStr = resolveMonthPeriod(period, todayVN());
    if (!monthStr) return `❌ period không hợp lệ: "${period}". Dùng một trong: thisMonth, lastMonth.`;
  }
  if (!monthStr) return "❌ Cần `month` (YYYY-MM) hoặc `period` (thisMonth/lastMonth).";

  const cfg = loadConfig();
  const ct  = cfg.companyTimesheet || {};
  if (!ct.templateFileId || !ct.driveFolderId) {
    return '❌ Chưa cấu hình template/folder. Gọi tool hr_config để dẫn user qua bước cấu hình, hoặc gọi trực tiếp action="configure" với templateUrl, folderUrl.';
  }

  const { from, to, days } = monthRange(monthStr);
  const [year, month] = monthStr.split("-").map(Number);
  const dayList = Array.from({ length: days }, (_, i) => `${monthStr}-${pad2(i + 1)}`);
  const requiredHours = workdaysInRange(from, to).length * 7;

  const miscRe = ct.miscTicketPattern ? new RegExp(ct.miscTicketPattern, "i") : /MISC-\d+/i;
  const haeRe  = ct.haeTicketPattern  ? new RegExp(ct.haeTicketPattern,  "i") : /HAE-\d+/i;

  // ── Discover everyone from real worklogs, no roster needed ───────
  const rawWorklogs = await fetchCompanyWorklogsInRange(from, to);
  const worklogs = await Promise.all(rawWorklogs.map(normalizeTempoWorklog));

  const byAccount = new Map(); // accountId -> { logByDay, absByDay, otByDay, logTotal, absTotal, otTotal }
  for (const w of worklogs) {
    if (!w.accountId) continue;
    if (!byAccount.has(w.accountId)) {
      byAccount.set(w.accountId, { logByDay: {}, absByDay: {}, otByDay: {}, logTotal: 0, absTotal: 0, otTotal: 0 });
    }
    const acc = byAccount.get(w.accountId);
    acc.logByDay[w.date] = (acc.logByDay[w.date] || 0) + w.hours;
    acc.logTotal += w.hours;
    if (miscRe.test(w.issueKey) || haeRe.test(w.issueKey)) {
      acc.absByDay[w.date] = (acc.absByDay[w.date] || 0) + w.hours;
      acc.absTotal += w.hours;
    }
    if (w.overtime) {
      acc.otByDay[w.date] = (acc.otByDay[w.date] || 0) + w.hours;
      acc.otTotal += w.hours;
    }
  }

  const unresolvedNames = [];
  const logEntries = [], absenceEntries = [], otEntries = [];
  for (const [accountId, acc] of byAccount) {
    const user = await getJiraUser(accountId);
    if (!user) { unresolvedNames.push(accountId); continue; }
    const { displayName: name } = user;
    logEntries.push({ accountId, name, byDay: acc.logByDay, total: acc.logTotal });
    absenceEntries.push({ accountId, name, byDay: acc.absByDay, total: acc.absTotal });
    otEntries.push({ accountId, name, byDay: acc.otByDay, total: acc.otTotal });
  }

  // ── Find or copy the month's report file ──────────────────────
  const title = `Timesheet ${MONTH_SHORT[month - 1]} ${year}`;
  let file = await driveFindFileByName(title, ct.driveFolderId);
  let created = false;
  if (!file) {
    file = await driveCopyFile(ct.templateFileId, title, ct.driveFolderId);
    created = true;
  }

  await sheetsReplaceSheetContents(file.id, "Jira log",     buildTimesheetReportRows(logEntries, dayList, requiredHours));
  await sheetsReplaceSheetContents(file.id, "Jira absence", buildTimesheetReportRows(absenceEntries, dayList, requiredHours));
  await sheetsReplaceSheetContents(file.id, "Jira OT",      buildOvertimeRows(otEntries, dayList));

  // "Timesheet "/"OT"/"MISC" derive their whole date row (E5 onward) and
  // every VLOOKUP from these two cells — set them to the target month so
  // those tabs line up with the data just written above.
  for (const sheetName of ["Timesheet ", "OT", "MISC"]) {
    await sheetsUpdateValues(file.id, `'${sheetName}'!F1`, [[month]]);
    await sheetsUpdateValues(file.id, `'${sheetName}'!H1`, [[year]]);
  }

  // Scan Slack + resolve identities ONCE, write the SAME computed hours to
  // both targets — computing it separately per target would let a real
  // Slack message that arrives between the two calls get counted in one
  // but not the other (verified against real data: a person's monthly
  // total differed by exactly one 4h entry between two back-to-back
  // live scans of the same month).
  const wfhResult = await computeWfhHours(cfg, monthStr);
  const wfhLines = await writeWfhToSheet(file.id, wfhResult, month);

  // Per explicit HR request: the template's own "WFH" tab also gets this
  // month's hours written in, on top of the per-month copy — normally this
  // server never touches the master template (every other tab/cell write
  // above only ever targets the per-month copy), so this is a deliberate,
  // narrow exception scoped to exactly one tab's one month-column, not a
  // general "write to template" pattern. Reads the template's own CODE
  // list independently (can differ from the per-month copy's, e.g. a new
  // hire added to the template after older months were already copied
  // from it), but reuses the same `wfhResult` computed above.
  const templateWfhLines = await writeWfhToSheet(ct.templateFileId, wfhResult, month);

  const lines = [
    `${created ? "✅ Đã tạo" : "✅ Đã update"} "${title}"`,
    `🔗 https://docs.google.com/spreadsheets/d/${file.id}/edit`,
    `   ${logEntries.filter(e => e.total > 0).length} người có log, ${absenceEntries.filter(e => e.total > 0).length} người có absence, ${otEntries.filter(e => e.total > 0).length} người có OT.`,
    ...wfhLines,
    `✅ Đã update sheet "WFH" của file template gốc (cùng dữ liệu tháng ${monthStr}):`,
    ...templateWfhLines.map(l => `   ${l}`),
  ];
  if (unresolvedNames.length) {
    lines.push(`⚠️ Không resolve được tên cho ${unresolvedNames.length} accountId (bị bỏ qua): ${unresolvedNames.join(", ")}`);
  }

  saveRun({ month: monthStr, year, monthIndex: month, fileId: file.id, link: `https://docs.google.com/spreadsheets/d/${file.id}/edit`, generatedAt: todayVN(), slackPreview: null });
  lines.push(``, `Muốn gửi thông báo lên Slack cho toàn công ty biết timesheet đã sẵn sàng? Gọi action="notify".`);

  return lines.join("\n");
}

function buildTimesheetAnnounceMessage(run) {
  const today = todayVN();
  const [ty, , td] = today.split("-").map(Number);
  const monthFull = MONTH_FULL[run.monthIndex - 1];
  const todayLabel = `${MONTH_SHORT[Number(today.slice(5, 7)) - 1]} ${ordinalSuffix(td)}`;
  return [
    `Dear <!channel>`,
    `[TIMESHEET ${monthFull.toUpperCase()} ${run.year}]`,
    `Back Office would like to send timesheet for ${monthFull} ${run.year}.`,
    `Kindly check your timesheet before 17:00 today ${todayLabel}.`,
    `Please note:`,
    ``,
    `Remained paid leave ${ty - 1} will be expired on 1st Jul ${ty}`,
    `Work from home: 7 hours of WFH are accrued each month and may only be used after they have been earned.`,
    `Employees with a negative WFH balance cannot use additional WFH hours until their balance is positive.`,
    `Thank you for your cooperation!`,
  ].join("\n");
}

export async function exportReportNotify({ message, confirm = false } = {}) {
  const run = loadRun();
  if (!run) return '❌ Chưa có report nào vừa tạo. Hãy gọi action="run" trước.';

  const cfg = loadConfig();
  const { id: absenceChannelId, name: absenceChannelName } = resolveSlackChannel(cfg.hr?.absenceChannel || "vn-absence");

  if (confirm && !run.slackPreview) {
    return [
      "❌ Bạn chưa xem preview.",
      'Hãy gọi action="notify" (không có confirm=true) trước để xem nội dung.',
    ].join("\n");
  }

  const generated = buildTimesheetAnnounceMessage(run);

  if (!confirm) {
    if (message) run.slackPreview = message;
    else if (!run.slackPreview) run.slackPreview = generated;
    saveRun(run);
    return [
      `📋 **Timesheet Announce Preview** — #${absenceChannelName}`,
      `**Tháng:** ${run.month}  |  **File:** ${run.link}`,
      message ? `_✏️ Đã áp dụng nội dung chỉnh sửa_` : ``,
      ``, `---`, run.slackPreview, `---`, ``,
      `✅ Gửi: gọi lại action="notify" với confirm=true`,
      `✏️ Sửa: gọi lại action="notify" với message="...nội dung mới..."`,
      `⛔ Không dùng Slack MCP tool trực tiếp cho việc này.`,
    ].filter(Boolean).join("\n");
  }

  const finalMessage = message || run.slackPreview || generated;
  const link = await postAndGetLink(absenceChannelId, finalMessage);
  return [`✅ Đã gửi tới #${absenceChannelName}`, link ? `🔗 ${link}` : ""].filter(Boolean).join("\n");
}
