// Monthly setup: create (or reuse) the HAE "Holidays & Events" ticket and
// this month's MISC "Absence" ticket, wire their keys into the absence
// cache logtime.js reads, then announce both to the company on Slack.
//
// Same governed flow as the rest of this project: action="plan" first
// shows a preview of both titles (and whether each will be created new or
// reused) — never writes to Jira until confirm=true. action="notify"
// mirrors missing_logtime.js's scan→notify pattern: preview the Slack
// message first, allow edits, only send with confirm=true.

import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { loadConfig, updateConfig } from "./lib/store.js";
import { findIssueByExactSummary, createSimpleIssue, jiraDomain } from "./lib/jira.js";
import { patchAbsenceCacheKeys } from "./lib/absence_cache.js";
import { resolveSlackChannel, postAndGetLink } from "./lib/slack.js";
import { todayVN, monthRange, MONTH_SHORT, MONTH_FULL, shiftMonth, resolveMonthPeriod } from "./lib/dates.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const RUN_JSON = resolve(__dir, "../config/set_hae_misc_run.json");

function loadRun() {
  if (!existsSync(RUN_JSON)) return null;
  try { return JSON.parse(readFileSync(RUN_JSON, "utf8")); } catch { return null; }
}
function saveRun(run) {
  writeFileSync(RUN_JSON, JSON.stringify(run, null, 2), "utf8");
}

const HAE_PROJECT_KEY  = "HAE";
const MISC_PROJECT_KEY = "MISC";
const HAE_TITLE = "[TORILAB] Holidays & Events";

// HAE's project schema requires these two fields on create. Both values
// mirror the only pre-existing HAE ticket (HAE-17): `components` has just
// one allowed option ("Holidays and Events"), and "Feature" reuses the
// same classification that ticket already used ("[Adhoc] Management").
const HAE_EXTRA_FIELDS = {
  components: [{ id: "10676" }],
  customfield_10502: { id: "10435" },
};

function miscTitleForMonth(yearMonth) {
  const { year, month, days } = monthRange(yearMonth);
  const mon = MONTH_SHORT[month - 1];
  return `[HR] [${mon} ${year}] Absence (1 ${mon} ${year} - ${days} ${mon} ${year})`;
}

// `period` is required (not defaulted) so Claude is forced to ask HR
// "tháng này hay tháng sau" before ever touching Jira — an explicit
// `month` override is still accepted for the rare case outside those two.
async function planHaeMisc({ month, period, haeTitle, miscTitle, confirm = false } = {}) {
  const today = todayVN();
  const targetMonth = month || (period && resolveMonthPeriod(period, today));
  if (!targetMonth) {
    const thisMonth = today.slice(0, 7);
    return [
      `❓ Tạo ticket HAE/MISC cho tháng nào?`,
      `Hỏi HR rồi gọi lại action="plan" với period="thisMonth" (tháng này: ${thisMonth}) hoặc period="nextMonth" (tháng sau: ${shiftMonth(thisMonth, 1)}).`,
    ].join("\n");
  }

  // config.json is the source of truth for "already set up" — checked
  // BEFORE anything else so a month that's already configured never
  // triggers a Jira call, let alone a duplicate ticket.
  const cfg = loadConfig();
  const cfgHaeKey  = cfg.hr?.haeIssue || null;
  const cfgMiscKey = cfg.hr?.miscIssueByMonth?.[targetMonth] || null;

  if (cfgHaeKey && cfgMiscKey) {
    saveRun({ month: targetMonth, haeKey: cfgHaeKey, miscKey: cfgMiscKey });
    return [
      `✅ Tháng ${targetMonth} đã có đủ ticket trong config — không tạo mới:`,
      `   HAE: ${cfgHaeKey}`,
      `   MISC: ${cfgMiscKey}`,
      ``,
      `Muốn gửi thông báo lên Slack? Gọi action="notify".`,
    ].join("\n");
  }

  const prevRun = loadRun();
  // Only reuse a previous preview's title as the fallback when it was
  // generated for this SAME target month — otherwise switching months
  // would silently carry over the wrong (previous month's) MISC title.
  const sameMonthRun = prevRun?.month === targetMonth ? prevRun : null;
  const useHaeTitle  = haeTitle  || sameMonthRun?.haeTitle  || HAE_TITLE;
  const useMiscTitle = miscTitle || sameMonthRun?.miscTitle || miscTitleForMonth(targetMonth);

  if (confirm && !sameMonthRun) {
    return '❌ Bạn chưa xem preview cho tháng này. Hãy gọi action="plan" (không có confirm) trước.';
  }

  // Bootstrap safety net: config doesn't have the key yet, but a ticket
  // with this exact title might already exist in Jira (e.g. created
  // manually before this tool existed — true for HAE-17/MISC-51 today) —
  // adopt it instead of creating a duplicate.
  const haeJiraKey  = cfgHaeKey  || await findIssueByExactSummary(HAE_PROJECT_KEY, useHaeTitle);
  const miscJiraKey = cfgMiscKey || await findIssueByExactSummary(MISC_PROJECT_KEY, useMiscTitle);

  if (!confirm) {
    saveRun({ month: targetMonth, haeTitle: useHaeTitle, miscTitle: useMiscTitle });
    const lines = [`📋 **Set HAE & MISC Preview** — ${targetMonth}`, ``];
    lines.push(`**HAE**: ${useHaeTitle}`);
    lines.push(cfgHaeKey
      ? `   ↳ đã có trong config: **${cfgHaeKey}** — dùng lại, không tạo mới`
      : haeJiraKey
        ? `   ↳ đã có ticket **${haeJiraKey}** trùng tên trong Jira — sẽ lưu lại, không tạo mới`
        : `   ↳ chưa có — sẽ tạo ticket mới trong project HAE`);
    lines.push(``);
    lines.push(`**MISC**: ${useMiscTitle}`);
    lines.push(cfgMiscKey
      ? `   ↳ đã có trong config: **${cfgMiscKey}** — dùng lại, không tạo mới`
      : miscJiraKey
        ? `   ↳ đã có ticket **${miscJiraKey}** trùng tên trong Jira — sẽ lưu lại, không tạo mới`
        : `   ↳ chưa có — sẽ tạo ticket mới trong project MISC`);
    lines.push(``);
    lines.push(`✏️ Sửa tên: gọi lại action="plan" với haeTitle="..." và/hoặc miscTitle="..." (kèm lại month/period)`);
    lines.push(`✅ Confirm tạo: gọi lại action="plan" với confirm=true`);
    return lines.join("\n");
  }

  let haeKey = haeJiraKey, haeCreated = false;
  if (!haeKey) {
    haeKey = await createSimpleIssue({ projectKey: HAE_PROJECT_KEY, summary: useHaeTitle, extraFields: HAE_EXTRA_FIELDS });
    haeCreated = true;
  }

  let miscKey = miscJiraKey, miscCreated = false;
  if (!miscKey) {
    try {
      miscKey = await createSimpleIssue({ projectKey: MISC_PROJECT_KEY, summary: useMiscTitle });
      miscCreated = true;
    } catch (e) {
      if (haeKey) {
        updateConfig({ hr: { haeIssue: haeKey } });
        patchAbsenceCacheKeys(targetMonth, { haeKey });
      }
      saveRun({ month: targetMonth, haeTitle: useHaeTitle, miscTitle: useMiscTitle, haeKey });
      return [
        `✅ HAE: ${haeCreated ? "đã tạo" : "dùng lại"} ticket **${haeKey}**`,
        `❌ MISC: tạo thất bại — ${e.message}`,
        `_(Chưa lưu MISC vào config vì thiếu key — sửa lỗi trên rồi gọi lại action="plan" với confirm=true)_`,
      ].join("\n");
    }
  }

  const patch = { hr: { miscIssueByMonth: { [targetMonth]: miscKey } } };
  if (haeKey) patch.hr.haeIssue = haeKey;
  updateConfig(patch);
  patchAbsenceCacheKeys(targetMonth, { haeKey, miscKey });
  saveRun({ month: targetMonth, haeTitle: useHaeTitle, miscTitle: useMiscTitle, haeKey, miscKey, confirmedAt: todayVN() });

  return [
    `✅ HAE: ${haeCreated ? "đã tạo" : "dùng lại"} ticket **${haeKey}** — ${useHaeTitle}`,
    `✅ MISC: ${miscCreated ? "đã tạo" : "dùng lại"} ticket **${miscKey}** — ${useMiscTitle}`,
    `✅ Đã lưu vào config.json (tháng ${targetMonth}) — logtime sẽ tự dùng 2 ticket này.`,
    ``,
    `Muốn gửi thông báo lên Slack? Gọi action="notify".`,
  ].join("\n");
}

function buildAnnounceMessage(run) {
  const { year, month } = monthRange(run.month);
  const monthFull = `${MONTH_FULL[month - 1]} ${year}`;
  const domain = jiraDomain();
  const link = key => domain ? `<https://${domain}/browse/${key}|${key}>` : key;
  return [
    `Dear <!channel>`,
    `Back Office would like to send the link to Jira Holidays and Events and Jira Absence for ${monthFull}.`,
    `Please ensure that you log in Jira Holidays and Events when you are absent due to Vietnamese holidays or attending company events.`,
    `If you are absent due to personal matters, please help log in Jira Absence as usual.`,
    `Here is the link to the Jira Holidays and Events: ${link(run.haeKey)}`,
    `Here is the link to the Jira Absence for ${monthFull}: ${link(run.miscKey)}`,
    `Thank you!`,
  ].join("\n");
}

async function notifyHaeMisc({ message, confirm = false } = {}) {
  const run = loadRun();
  if (!run?.haeKey || !run?.miscKey) {
    return '❌ Chưa có ticket HAE/MISC đã tạo. Hãy gọi action="plan" với confirm=true trước.';
  }

  const cfg = loadConfig();
  const { id: absenceChannelId, name: absenceChannelName } = resolveSlackChannel(cfg.hr?.absenceChannel || "vn-absence");

  if (confirm && !run.slackPreview) {
    return '❌ Bạn chưa xem preview. Hãy gọi action="notify" (không có confirm) trước.';
  }

  const generated = buildAnnounceMessage(run);

  if (!confirm) {
    if (message) run.slackPreview = message;
    else if (!run.slackPreview) run.slackPreview = generated;
    saveRun(run);
    return [
      `📋 **Set HAE & MISC — Slack Announce Preview** — #${absenceChannelName}`,
      `**HAE:** ${run.haeKey}  |  **MISC:** ${run.miscKey}  |  **Tháng:** ${run.month}`,
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

export async function setHaeMisc({ action = "plan", month, period, haeTitle, miscTitle, message, confirm = false } = {}) {
  if (action === "plan")   return planHaeMisc({ month, period, haeTitle, miscTitle, confirm });
  if (action === "notify") return notifyHaeMisc({ message, confirm });
  return '❌ Cần `action`: "plan" hoặc "notify".';
}
