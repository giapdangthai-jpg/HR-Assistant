// Explicit, on-demand refresh of the absence cache for one day, plus a
// quick "who declared đi muộn/về sớm/xin nghỉ today" readout — the single
// named entry point for warming absence_cache.json, so HR has one place
// to point at instead of it happening invisibly inside whichever check
// task happens to run first each day. logtime.js / missing_logtime.js
// keep auto-refreshing on their own when the cache is stale (unchanged) —
// this task is for proactively looking at today's activity, not a gate.

import { loadConfig } from "./lib/store.js";
import { getMonthAbsenceData } from "./lib/absence_cache.js";
import { getSlackUserEmail, resolveSlackChannel } from "./lib/slack.js";
import { findJiraUserByEmail } from "./lib/jira.js";
import { todayVN } from "./lib/dates.js";
import { mentionsDate, ABSENCE_KEYWORDS, ABSENCE_EXCLUDE } from "./lib/worklog.js";

export async function updateAbsenceInfo({ date, force = false } = {}) {
  const cfg = loadConfig();
  const today = todayVN();
  const targetDate = date || today;
  const yearMonth = targetDate.slice(0, 7);
  const { id: channelId, name: channelName } = resolveSlackChannel(cfg.hr?.absenceChannel || "vn-absence");

  const md = await getMonthAbsenceData(yearMonth, channelId, today, { force });

  const byAuthor = new Map(); // slackUserId -> [text, ...]
  for (const msg of md.messages || []) {
    if (!msg.text || !msg.user) continue;
    if (ABSENCE_EXCLUDE.test(msg.text)) continue;
    if (!ABSENCE_KEYWORDS.test(msg.text)) continue;
    const msgDate = msg.ts ? new Date(parseFloat(msg.ts) * 1000).toISOString().slice(0, 10) : "";
    const relevant = msgDate === targetDate || mentionsDate(msg.text, targetDate);
    if (!relevant) continue;
    if (!byAuthor.has(msg.user)) byAuthor.set(msg.user, []);
    byAuthor.get(msg.user).push(msg.text);
  }

  const entries = [];
  for (const [slackId, texts] of byAuthor) {
    const email = await getSlackUserEmail(slackId);
    const jiraUser = email ? await findJiraUserByEmail(email) : null;
    entries.push({ slackId, name: jiraUser?.displayName || null, texts });
  }

  const lines = [`**Update Absence Information — ${targetDate}**`, ``];
  lines.push(`✅ Đã cập nhật absence cache tháng ${yearMonth} (HAE: ${md.haeKey || "chưa có"} | MISC: ${md.miscKey || "chưa có"}).`, ``);

  if (!entries.length) {
    lines.push(`Không có ai xin đi muộn/về sớm/nghỉ trong #${channelName} ngày ${targetDate}.`);
  } else {
    lines.push(`**Xin đi muộn/về sớm/nghỉ ngày ${targetDate} (#${channelName}):**`);
    entries.forEach((e, i) => {
      const who = e.name || `<@${e.slackId}>`;
      lines.push(`${i + 1}. ${who}: ${e.texts.join(" | ")}`);
    });
  }

  return lines.join("\n");
}
