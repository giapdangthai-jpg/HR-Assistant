// Monthly setup for the HAE "Holidays & Events" ticket (one perpetual
// ticket) and the per-month MISC "Absence" ticket, then announce them on
// Slack.
//
// Flow (HR-facing, driven by Claude):
//   1. action="status" — report what already exists and ask HR the
//      branching questions. Never writes to Jira.
//        • MISC tháng này: đã/chưa có (+ tên)
//        • HAE: đã/chưa có (+ tên)
//        • If MISC tháng này CHƯA có  → hỏi "tạo mới cho tháng này?"
//          If MISC tháng này ĐÃ có    → hỏi "tạo mới cho tháng sau?"
//        • Rồi hỏi "tạo mới HAE không?"
//   2. action="create", createMisc=<bool>, createHae=<bool> — actually
//      create (or adopt an existing same-title ticket). Must be preceded
//      by action="status" (guards against a blind create). MISC and HAE
//      are independent — HR can create either, both, or neither.
//   3. action="notify" — preview then send the Slack announcement, same
//      preview→confirm discipline as the other Slack tools.

import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { loadConfig, updateConfig } from "./lib/store.js";
import { findIssueByExactSummary, createSimpleIssue, jiraDomain } from "./lib/jira.js";
import { patchAbsenceCacheKeys } from "./lib/absence_cache.js";
import { resolveSlackChannel, postAndGetLink } from "./lib/slack.js";
import { todayVN, monthRange, MONTH_SHORT, MONTH_FULL, shiftMonth } from "./lib/dates.js";

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

// Resolve an existing key from config first, then (bootstrap) an
// exact-same-title ticket already in Jira — so a ticket created manually
// before this tool existed (HAE-17/MISC-51) is adopted, never duplicated.
async function resolveMiscKey(cfg, month) {
  return cfg.hr?.miscIssueByMonth?.[month]
    || await findIssueByExactSummary(MISC_PROJECT_KEY, miscTitleForMonth(month));
}
async function resolveHaeKey(cfg) {
  return cfg.hr?.haeIssue
    || await findIssueByExactSummary(HAE_PROJECT_KEY, HAE_TITLE);
}

// ── STATUS ────────────────────────────────────────────────────────
async function statusHaeMisc() {
  const today     = todayVN();
  const thisMonth = today.slice(0, 7);
  const cfg       = loadConfig();

  const miscThisKey = await resolveMiscKey(cfg, thisMonth);
  const haeKey      = await resolveHaeKey(cfg);

  // MISC target: if this month already has one, the next thing HR would
  // create is next month's; otherwise it's this month's.
  const miscTargetMonth = miscThisKey ? shiftMonth(thisMonth, 1) : thisMonth;
  const miscTargetKey   = miscThisKey ? await resolveMiscKey(cfg, miscTargetMonth) : null;

  saveRun({ miscTargetMonth, miscTitle: miscTitleForMonth(miscTargetMonth), haeTitle: HAE_TITLE });

  const lines = [`📋 **Set HAE & MISC — trạng thái**`, ``];
  lines.push(`• MISC tháng này (${thisMonth}): ${miscThisKey ? `✅ đã có **${miscThisKey}**` : "⬜ **chưa có**"}`);
  lines.push(`• HAE: ${haeKey ? `✅ đã có **${haeKey}**` : "⬜ **chưa có**"}`);
  lines.push(``, `**Hỏi HR lần lượt (chờ trả lời từng câu, đừng tự quyết):**`);

  if (miscThisKey) {
    lines.push(`1. MISC tháng này đã có (**${miscThisKey}**) — bạn có muốn tạo mới MISC cho **tháng sau (${miscTargetMonth})** không?`
      + (miscTargetKey ? ` _(tháng sau đã có **${miscTargetKey}** — nếu đồng ý sẽ dùng lại, không tạo trùng)_` : ``));
  } else {
    lines.push(`1. MISC tháng này **chưa có** — bạn có muốn tạo mới MISC cho **tháng này (${miscTargetMonth})** không?`);
  }
  lines.push(`2. Bạn có muốn tạo mới HAE không?`
    + (haeKey ? ` _(HAE đã có **${haeKey}** — nếu đồng ý sẽ dùng lại, không tạo trùng)_` : ``));

  lines.push(``, `Sau khi HR trả lời, gọi: action="create", month="${miscTargetMonth}", createMisc=<true/false>, createHae=<true/false>.`);
  return lines.join("\n");
}

// ── CREATE ────────────────────────────────────────────────────────
async function createHaeMisc({ month, createMisc = false, createHae = false, miscTitle } = {}) {
  const run = loadRun();
  if (!month) return '❌ Thiếu `month`. Gọi action="status" trước để xem trạng thái và lấy tháng mục tiêu.';
  if (run?.miscTargetMonth !== month) {
    return `❌ Chưa xem trạng thái cho tháng ${month}. Hãy gọi action="status" trước (để HR xác nhận đúng tháng) rồi mới create.`;
  }
  if (!createMisc && !createHae) {
    return 'HR không chọn tạo gì (createMisc=false, createHae=false) — không tạo ticket nào. Nếu muốn gửi thông báo bằng ticket sẵn có, gọi action="notify".';
  }

  const cfg = loadConfig();
  const results = [];
  const patch = { hr: {} };

  let miscKey = null;
  if (createMisc) {
    const title = miscTitle || run.miscTitle || miscTitleForMonth(month);
    // Adopt an existing ticket by the SAME title we'd create (config
    // first) — searching by the exact title HR chose, so a custom-titled
    // ticket that already exists isn't missed and duplicated.
    let existing = cfg.hr?.miscIssueByMonth?.[month] || await findIssueByExactSummary(MISC_PROJECT_KEY, title);
    let created = false;
    if (!existing) {
      try {
        existing = await createSimpleIssue({ projectKey: MISC_PROJECT_KEY, summary: title });
        created = true;
      } catch (e) {
        return [`❌ MISC: tạo thất bại — ${e.message}`, `_(Chưa lưu gì. Kiểm tra quyền "Create Issues" trên project MISC rồi thử lại.)_`].join("\n");
      }
    }
    miscKey = existing;
    patch.hr.miscIssueByMonth = { [month]: miscKey };
    results.push(`✅ MISC (${month}): ${created ? "đã tạo" : "dùng lại"} **${miscKey}** — ${title}`);
  }

  let haeKey = null;
  if (createHae) {
    let existing = await resolveHaeKey(cfg);
    let created = false;
    if (!existing) {
      try {
        existing = await createSimpleIssue({ projectKey: HAE_PROJECT_KEY, summary: HAE_TITLE, extraFields: HAE_EXTRA_FIELDS });
        created = true;
      } catch (e) {
        // MISC may already have been created above — persist that before returning.
        if (miscKey) { updateConfig(patch); patchAbsenceCacheKeys(month, { miscKey }); }
        return [...results, `❌ HAE: tạo thất bại — ${e.message}`, `_(MISC ở trên (nếu có) đã được lưu. Kiểm tra quyền "Create Issues" trên project HAE rồi thử lại createHae.)_`].join("\n");
      }
    }
    haeKey = existing;
    patch.hr.haeIssue = haeKey;
    results.push(`✅ HAE: ${created ? "đã tạo" : "dùng lại"} **${haeKey}** — ${HAE_TITLE}`);
  }

  updateConfig(patch);

  // Pull the full picture from config (so notify has both keys even if
  // only one was created this run — e.g. HAE already existed).
  const after = loadConfig();
  const runHae  = after.hr?.haeIssue || null;
  const runMisc = after.hr?.miscIssueByMonth?.[month] || null;
  patchAbsenceCacheKeys(month, { haeKey: runHae, miscKey: runMisc });
  saveRun({ miscTargetMonth: month, month, haeTitle: HAE_TITLE, miscTitle: run.miscTitle, haeKey: runHae, miscKey: runMisc, confirmedAt: todayVN() });

  results.push(``, `✅ Đã lưu vào config.json — logtime sẽ tự dùng các ticket này.`);
  results.push(`Muốn gửi thông báo lên Slack? Gọi action="notify".`);
  return results.join("\n");
}

// ── NOTIFY ────────────────────────────────────────────────────────
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
  if (!run?.month || !run?.haeKey || !run?.miscKey) {
    const miss = !run?.haeKey ? "HAE" : "MISC";
    return `❌ Chưa đủ ticket để thông báo (thiếu ${miss}). Hãy gọi action="create" tạo/xác nhận cả HAE và MISC trước.`;
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

export async function setHaeMisc({ action = "status", month, createMisc, createHae, miscTitle, message, confirm = false } = {}) {
  if (action === "status") return statusHaeMisc();
  if (action === "create") return createHaeMisc({ month, createMisc, createHae, miscTitle });
  if (action === "notify") return notifyHaeMisc({ message, confirm });
  return '❌ Cần `action`: "status", "create" hoặc "notify".';
}
