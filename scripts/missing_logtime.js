// Company-wide missing-logtime scan + Slack notification to the absence
// channel. Same governed flow as PM Assistant's po_plan/sprint_report/
// overtime_log tools: scan (read-only) -> notify (preview only) ->
// notify confirm=true (actually sends). Never skip the preview step.
//
// Two exported functions, no process.exit (matches PM Assistant's tool
// convention — this runs inside an MCP server where exiting the process
// kills every other tool call too).

import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { loadConfig } from "./lib/store.js";
import { getJiraUser } from "./lib/jira.js";
import { fetchCompanyWorklogsInRange, normalizeTempoWorklog } from "./lib/tempo.js";
import { getMonthAbsenceData } from "./lib/absence_cache.js";
import { resolveSlackChannel, lookupUserByEmail, postAndGetLink } from "./lib/slack.js";
import { todayVN, mondayOfWeek, workdaysInRange, MONTH_SHORT, resolvePeriod, PERIOD_LABELS } from "./lib/dates.js";
import { WORK_HOURS, hoursToJira, detectAbsenceClaim } from "./lib/worklog.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const RUN_JSON = resolve(__dir, "../config/missing_logtime_run.json");

function loadRun() {
  if (!existsSync(RUN_JSON)) return null;
  try { return JSON.parse(readFileSync(RUN_JSON, "utf8")); } catch { return null; }
}
function saveRun(run) {
  writeFileSync(RUN_JSON, JSON.stringify(run, null, 2), "utf8");
}

function dayLabel(dateISO) {
  const [, m, d] = dateISO.split("-").map(Number);
  return `${d}/${MONTH_SHORT[m - 1]}`;
}

export async function missingLogtimeScan({ period, from: fromArg, to: toArg } = {}) {
  const cfg = loadConfig();
  const today = todayVN();
  let periodRange = null;
  if (period) {
    periodRange = resolvePeriod(period, today);
    if (!periodRange) return `❌ period không hợp lệ: "${period}". Dùng một trong: thisWeek, lastWeek, thisMonth, lastMonth.`;
  }
  const from = periodRange?.from || fromArg || mondayOfWeek(today);
  const to   = periodRange?.to   || toArg   || today;

  const { id: absenceChannelId, name: absenceChannelName } = resolveSlackChannel(cfg.hr?.absenceChannel || "vn-absence");
  const slackIdOverrides = cfg.hr?.slackIdByJiraName || {};

  // Same per-month cache logtime.js uses (config.json first, else scan
  // #vn-absence and cache the result) — `messages` here is EVERY message
  // in the channel that month from any author, not filtered to one HR.
  const months = [...new Set(workdaysInRange(from, to).map(d => d.slice(0, 7)))];
  let haeKey = null;
  const miscKeyByMonth = {};
  const allMessages = [];
  const holidays = new Set();
  for (const yearMonth of months) {
    const md = await getMonthAbsenceData(yearMonth, absenceChannelId, today);
    if (md.haeKey)  haeKey = md.haeKey;
    if (md.miscKey) miscKeyByMonth[yearMonth] = md.miscKey;
    allMessages.push(...(md.messages || []));
    for (const hd of (md.holidayDates || [])) holidays.add(hd);
  }

  const expectedDays = workdaysInRange(from, to).filter(d => d <= today && !holidays.has(d));

  if (!expectedDays.length) {
    saveRun({ from, to, generatedAt: today, people: [], wrongAbsence: [], slackPreview: null });
    return `Không có ngày làm việc nào cần kiểm tra trong ${from} → ${to} (đã trừ ngày lễ).`;
  }

  const rawWorklogs = await fetchCompanyWorklogsInRange(from, to);
  const worklogs = await Promise.all(rawWorklogs.map(normalizeTempoWorklog));

  const byAccount = new Map(); // accountId -> { byDay: {date: totalHours}, byDayTicket: {date: {ticket: hours}} }
  for (const w of worklogs) {
    if (!w.accountId) continue;
    if (!byAccount.has(w.accountId)) byAccount.set(w.accountId, { byDay: {}, byDayTicket: {} });
    const acc = byAccount.get(w.accountId);
    acc.byDay[w.date] = (acc.byDay[w.date] || 0) + w.hours;
    if (!acc.byDayTicket[w.date]) acc.byDayTicket[w.date] = {};
    acc.byDayTicket[w.date][w.issueKey] = (acc.byDayTicket[w.date][w.issueKey] || 0) + w.hours;
  }

  // Resolve every logged-time account's Jira+Slack identity IN PARALLEL —
  // sequential (a plain for-loop with awaits) was a real performance bug:
  // the wrongAbsence check below needs identity for every account, not
  // just the ones missing logtime, so a company-wide scan awaiting each
  // one-by-one meant 60-90+ round-trips in series and pushed a single
  // scan well past 60 seconds. Jira's own GET concurrency limiter (in
  // lib/jira.js) still caps how many of these run at once, so this
  // Promise.all doesn't reintroduce the rate-limit burst problem.
  const accountResults = await Promise.all([...byAccount.entries()].map(async ([accountId, acc]) => {
    const missingDays = expectedDays.filter(d => (acc.byDay[d] || 0) < WORK_HOURS - 0.1);

    const user = await getJiraUser(accountId);
    if (!user) return null;
    // Jira → Slack normally bridges via email. But some accounts hide
    // their email in Jira (privacy setting → getJiraUser returns email
    // null), so lookupByEmail can't run at all. For those, fall back to a
    // manual map in config.json (`hr.slackIdByJiraName`, keyed by trimmed
    // Jira display name) that HR fills in once — without it those people
    // show as plain "@Name" text and don't get a real Slack mention.
    let slackId = user.email ? await lookupUserByEmail(user.email) : null;
    if (!slackId) slackId = slackIdOverrides[(user.displayName || "").trim()] || null;

    let wrongDays = [];
    // Cross-check: did this person post an absence claim (đi muộn/về
    // sớm/xin nghỉ/wfh...) in #vn-absence for a day that ISN'T already
    // flagged missing (i.e. their total hours look fine), but didn't
    // actually log matching hours to that month's MISC ticket? That's
    // invisible to the total-hours check above — someone can log a full
    // 7h to an unrelated ticket and never touch MISC at all.
    if (slackId) {
      wrongDays = expectedDays
        .filter(d => !missingDays.includes(d))
        .map(d => {
          const claim = detectAbsenceClaim(d, allMessages, slackId);
          if (!claim) return null;
          const miscKey = miscKeyByMonth[d.slice(0, 7)];
          if (!miscKey) return null;
          const actualMisc = acc.byDayTicket[d]?.[miscKey] || 0;
          return actualMisc < claim.hours - 0.1 ? { d, expectedHours: claim.hours, actualMisc, miscKey } : null;
        })
        .filter(Boolean);
    }

    return { accountId, name: user.displayName, slackId, missingDays, wrongDays };
  }));

  const people = [];
  const wrongAbsence = [];
  for (const r of accountResults) {
    if (!r) continue;
    if (r.missingDays.length) people.push({ accountId: r.accountId, name: r.name, slackId: r.slackId, missingDays: r.missingDays });
    if (r.wrongDays.length) wrongAbsence.push({ accountId: r.accountId, name: r.name, slackId: r.slackId, wrongDays: r.wrongDays });
  }

  saveRun({ from, to, generatedAt: today, haeKey, people, wrongAbsence, slackPreview: null });

  const periodSuffix = period ? ` — ${PERIOD_LABELS[period] || period}` : "";
  const lines = [`**Missing Logtime Scan — ${from} → ${to}${periodSuffix}**`, ``];
  if (haeKey) lines.push(`Ngày lễ (HAE: ${haeKey}): ${holidays.size ? [...holidays].join(", ") : "không có"}`, ``);

  if (people.length) {
    lines.push("**Thiếu log time:**");
    people.forEach((p, i) => lines.push(`${i + 1}. ${p.name}${p.slackId ? "" : " ⚠️ (chưa resolve Slack ID)"}: thiếu ngày ${p.missingDays.map(dayLabel).join(", ")}`));
  } else {
    lines.push("✅ Không ai thiếu log time trong khoảng này.");
  }

  if (wrongAbsence.length) {
    lines.push(``, "**Đã khai nghỉ/đi muộn/về sớm trên Slack nhưng chưa log đủ vào MISC:**");
    wrongAbsence.forEach((p, i) => {
      const detail = p.wrongDays.map(w => `${dayLabel(w.d)} (khai ${hoursToJira(w.expectedHours)}, đã log ${hoursToJira(w.actualMisc)} vào ${w.miscKey})`).join("; ");
      lines.push(`${i + 1}. ${p.name}: ${detail}`);
    });
  }

  lines.push(``, (people.length || wrongAbsence.length) ? `Muốn gửi thông báo lên #${absenceChannelName}? Gọi action="notify".` : "");
  return lines.filter(Boolean).join("\n");
}

function buildMessage(run) {
  const lines = [
    `Please review your time logs for the period from ${run.from} to ${run.to}.`,
    `These records are used for payroll calculations. To avoid any discrepancies, please ensure your time logs are complete and accurate.`,
      ``,
  ];
  let i = 0;
  (run.people || []).forEach(p => {
    i++;
    const mention = p.slackId ? `<@${p.slackId}>` : `@${p.name}`;
    lines.push(`${i}. ${mention}: missing time log on ${p.missingDays.map(dayLabel).join(", ")}`);
  });
  (run.wrongAbsence || []).forEach(p => {
    i++;
    const mention = p.slackId ? `<@${p.slackId}>` : `@${p.name}`;
    const detail = p.wrongDays.map(w => `${dayLabel(w.d)} (declared ${hoursToJira(w.expectedHours)}, logged ${hoursToJira(w.actualMisc)} on ${w.miscKey})`).join("; ");
    lines.push(`${i}. ${mention}: declared leave/late/early on Slack but hasn't logged enough to MISC — ${detail}`);
  });
  lines.push(``, `Thank you!`);
  return lines.join("\n");
}

export async function missingLogtimeNotify({ message, confirm = false } = {}) {
  const run = loadRun();
  if (!run) return '❌ Chưa có data scan. Hãy gọi action="scan" trước.';
  if (!run.people?.length && !run.wrongAbsence?.length) return "❌ Lần scan gần nhất không có ai thiếu/log sai — không có gì để gửi.";

  const cfg = loadConfig();
  const { id: absenceChannelId, name: absenceChannelName } = resolveSlackChannel(cfg.hr?.absenceChannel || "vn-absence");

  if (confirm && !run.slackPreview) {
    return [
      "❌ Bạn chưa xem preview.",
      'Hãy gọi action="notify" (không có confirm=true) trước để xem nội dung.',
    ].join("\n");
  }

  const generated = buildMessage(run);

  if (!confirm) {
    if (message) run.slackPreview = message;
    else if (!run.slackPreview) run.slackPreview = generated;
    saveRun(run);
    return [
      `📋 **Missing Logtime Notify Preview** — #${absenceChannelName}`,
      `**Range:** ${run.from} → ${run.to}  |  **Missing log:** ${run.people?.length || 0}  |  **Declared but under-logged:** ${run.wrongAbsence?.length || 0}`,
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
