// Personal logtime for one HR user — same detection logic as PM Assistant's
// src/tools/log_time.js (Slack absence messages + HAE/MISC ticket detection),
// pointed at this HR's own Jira ticket instead of a PM's.
//
// Exports one function, dispatched by `action`, matching PM Assistant's own
// log_time.js convention: never calls process.exit — every outcome (success
// or error) is a returned string, since this runs inside an MCP server
// where exiting the process would kill every other tool call too.

import { loadConfig, updateConfig, isConfigured } from "./lib/store.js";
import { addWorklog, getWorklogs, deleteWorklog, getMyself, jiraPost, jiraGet } from "./lib/jira.js";
import { lookupUserByEmail, getSelfUserId, resolveSlackChannel } from "./lib/slack.js";
import { todayVN, resolvePeriod, PERIOD_LABELS } from "./lib/dates.js";
import { getMonthAbsenceData } from "./lib/absence_cache.js";
import { WORK_HOURS, hoursToJira, detectAbsenceClaim } from "./lib/worklog.js";

// ─── Date helpers ─────────────────────────────────────────────────

function workdaysInRange(fromISO, toISO) {
  const days = [];
  const cur = new Date(fromISO + "T12:00:00Z");
  const end = new Date(toISO   + "T12:00:00Z");
  while (cur <= end) {
    const dow = cur.getUTCDay();
    if (dow !== 0 && dow !== 6) days.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return days;
}

function mondayOfWeek(today) {
  const d = new Date(today + "T12:00:00Z");
  const dow = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - (dow === 0 ? 6 : dow - 1));
  return d.toISOString().slice(0, 10);
}

function toJiraStarted(dateISO) {
  return `${dateISO}T09:00:00.000+0700`;
}

function detectEntries(dateISO, { isHoliday, haeKey, miscKey, defaultIssue, defaultComment, myId, messages }) {
  if (isHoliday) {
    return [{ ticket: haeKey, hours: WORK_HOURS, comment: "Vietnamese Holiday / Company Event", reason: "Ngày lễ" }];
  }

  const miscTicket = miscKey || "MISC";
  const claim = detectAbsenceClaim(dateISO, messages, myId);

  if (claim) {
    if (!claim.fullDay) {
      const absLog  = claim.hours;
      const workLog = parseFloat((WORK_HOURS - absLog).toFixed(1));
      const entries = [{ ticket: miscTicket, hours: absLog, comment: "Leave / Absence", reason: `Nghỉ ${hoursToJira(absLog)}` }];
      if (workLog > 0) entries.push({ ticket: defaultIssue, hours: workLog, comment: defaultComment, reason: "Làm việc còn lại" });
      return entries;
    }
    return [{ ticket: miscTicket, hours: WORK_HOURS, comment: "Leave / Absence", reason: "Nghỉ cả ngày (không ghi giờ)" }];
  }

  return [{ ticket: defaultIssue, hours: WORK_HOURS, comment: defaultComment, reason: "Ngày làm việc" }];
}

// ─── Setup ──────────────────────────────────────────────────────────

// Partial update: only overwrites the fields actually passed in, keeping
// whatever was configured before for the rest — e.g. changing just the
// comment must not silently reset the ticket back to nothing, or vice
// versa. `issueKey` is only required the very first time (no prior config).
function runSetup({ issueKey, comment, absenceChannel, absenceChannelId } = {}) {
  const existing = loadConfig();
  const finalIssueKey = issueKey || existing.hr?.autoLogIssue;
  if (!finalIssueKey) return "❌ Cần `issueKey` (ticket cá nhân để log time hằng ngày) — chưa có cấu hình nào từ trước.";
  const patch = {
    hr: {
      autoLogIssue: finalIssueKey,
      autoLogComment: comment || existing.hr?.autoLogComment || "HR administrative work",
    },
  };
  if (absenceChannel) {
    patch.hr.absenceChannel = { name: absenceChannel, id: absenceChannelId || "" };
  }
  const cfg = updateConfig(patch);
  return [
    `✅ Đã lưu config: autoLogIssue=${cfg.hr.autoLogIssue}, comment="${cfg.hr.autoLogComment}"`,
    `   Sửa lại bất kỳ lúc nào bằng: logtime action=setup issueKey=... comment=... (chỉ truyền field muốn đổi, field khác giữ nguyên)`,
  ].join("\n");
}

// ─── Main ─────────────────────────────────────────────────────────

export async function logTime({
  action = "check", issueKey, comment, absenceChannel, absenceChannelId,
  period, date, from: fromArg, to: toArg, dates, entries: manualEntries, confirm = false,
} = {}) {
  if (action === "setup") return runSetup({ issueKey, comment, absenceChannel, absenceChannelId });

  if (!isConfigured()) {
    return [
      "❌ Chưa cấu hình ticket cá nhân cho logtime.",
      'Gọi tool hr_config để dẫn user qua bước cấu hình, hoặc gọi trực tiếp action="setup", issueKey="<TICKET>", comment="..."',
    ].join("\n");
  }

  const cfg   = loadConfig();
  const key   = cfg.hr.autoLogIssue;
  const note  = cfg.hr.autoLogComment || "HR administrative work";
  const today = todayVN();
  const { id: absenceChannelIdCfg, name: absenceChannelName } = resolveSlackChannel(cfg.hr?.absenceChannel || "vn-absence");
  const jiraEmail = process.env.JIRA_EMAIL;

  // ── VIEW ──────────────────────────────────────────────────────
  if (action === "view") {
    const data = await getWorklogs(key);
    const logs = (data?.worklogs || []).slice(-30);
    if (!logs.length) return `**${key}**: Chưa có worklog nào.`;
    const total = logs.reduce((s, l) => s + (l.timeSpentSeconds || 0), 0);
    const lines = logs.map(l => {
      const day = l.started?.slice(0, 10) || "?";
      const txt = l.comment?.content?.[0]?.content?.[0]?.text || "";
      return `  - ${day} | ${l.timeSpent || "?"}${txt ? ` — ${txt}` : ""}`;
    });
    return `## ⏱ Worklogs — ${key}\n\n${lines.join("\n")}\n\n**Tổng**: ${(total / 3600).toFixed(1)}h`;
  }

  let periodRange = null;
  if (period) {
    periodRange = resolvePeriod(period, today);
    if (!periodRange) return `❌ period không hợp lệ: "${period}". Dùng một trong: thisWeek, lastWeek, thisMonth, lastMonth.`;
  }
  const from     = periodRange?.from || date || fromArg || mondayOfWeek(today);
  const to       = periodRange?.to   || date || toArg   || today;
  const workdays = workdaysInRange(from, to).filter(d => d <= today);

  if (!workdays.length) return `Không có ngày làm việc nào trong khoảng ${from} → ${to}.`;

  const loggedByDate = {};
  const worklogIds   = {};
  // Guards against double-counting the SAME logical worklog. Keyed by
  // `issueKey|started|timeSpentSeconds` — this company's Jira worklogs are
  // Tempo-synced, and a single logged block can surface as two Jira
  // worklog rows (the user's own + a Tempo-bot mirror) with the exact same
  // start timestamp and duration. Because the personal-ticket merge counts
  // both `isMine` and Tempo-bot (`isProxy`) entries, those mirrors were
  // being summed twice — a real 7h day read as 14h/17h (reported bug on
  // TBO-347, 2026-06-29/30). Two worklogs sharing an exact start AND exact
  // duration on one ticket are definitionally a duplicate, never a
  // legitimate split, so counting them once is safe.
  const seenWorklog = new Set();

  let myAccountId = null;
  try { myAccountId = (await getMyself()).accountId || null; } catch {}

  function isProxyEntry(l) { return l.author?.accountId?.startsWith("557058:"); }

  // Records a worklog. The worklog id is ALWAYS tracked (so a later
  // add/delete cleanly removes every row, duplicates included), but its
  // hours are added to the day total only once per unique
  // `issueKey|started|timeSpentSeconds` — so an exact-duplicate mirror row
  // inflates neither the displayed total nor the auto-fix decision, yet
  // still gets deleted when the day is rewritten. Shared by mergeWorklogs
  // and the JQL fallback so both paths behave identically.
  function recordWorklog(wDate, issueKey, l) {
    if (!worklogIds[wDate]) worklogIds[wDate] = [];
    worklogIds[wDate].push({ issueKey, id: l.id });

    const dedupeKey = `${issueKey}|${l.started}|${l.timeSpentSeconds || 0}`;
    if (seenWorklog.has(dedupeKey)) return;
    seenWorklog.add(dedupeKey);
    if (!loggedByDate[wDate]) loggedByDate[wDate] = {};
    loggedByDate[wDate][issueKey] = (loggedByDate[wDate][issueKey] || 0) + (l.timeSpentSeconds || 0) / 3600;
  }

  // Does NOT swallow errors — a failed fetch must never look identical to
  // "fetched successfully, found 0 worklogs". Callers decide how critical
  // a given ticket's fetch is (see below): the personal ticket is fatal if
  // it fails, HAE/MISC/JQL-fallback are merely surfaced as a warning.
  async function mergeWorklogs(ticketKey, isPersonalTicket = false) {
    if (!ticketKey) return;
    const d = await getWorklogs(ticketKey);
    for (const l of d?.worklogs || []) {
      const wDate = l.started?.slice(0, 10);
      if (!wDate || !workdays.includes(wDate)) continue;
      const isMine = myAccountId
        ? l.author?.accountId === myAccountId
        : jiraEmail && l.author?.emailAddress === jiraEmail;
      const isProxy = isProxyEntry(l);
      if (isMine || (isProxy && isPersonalTicket)) {
        recordWorklog(wDate, ticketKey, l);
      }
    }
  }

  // Fatal: without the personal ticket's real worklogs, every day would
  // wrongly classify as "missing" (0 logged) instead of "couldn't check".
  try {
    await mergeWorklogs(key, true);
  } catch (e) {
    return [
      `❌ Không lấy được worklog từ Jira cho ${key} — kết quả check sẽ không đáng tin cậy (mọi ngày sẽ trông như "chưa log" dù có thể đã log).`,
      `Lỗi: ${e.message}`,
      `Nếu đây là do mạng bị chặn (ví dụ sandbox không cho gọi ra ngoài tới Jira), hãy chạy lại ở môi trường có quyền truy cập Jira/Atlassian.`,
    ].join("\n");
  }

  let haeKey = null, miscKey = null, myId = null;
  let messages = [];
  let isHolidayFn = () => false;
  let slackError = null;

  try {
    if (jiraEmail) myId = await lookupUserByEmail(jiraEmail);
    if (!myId) myId = await getSelfUserId();
    const months   = [...new Set(workdays.map(d => d.slice(0, 7)))];
    const holidays = new Set();
    for (const yearMonth of months) {
      const md = await getMonthAbsenceData(yearMonth, absenceChannelIdCfg, today);
      if (md.haeKey)  haeKey  = md.haeKey;
      if (md.miscKey) miscKey = md.miscKey;
      messages.push(...(md.messages || []).filter(m => m.user === myId));
      for (const hd of (md.holidayDates || [])) holidays.add(hd);
    }
    isHolidayFn = (dateISO) => holidays.has(dateISO);
    await Promise.all([mergeWorklogs(haeKey, false), mergeWorklogs(miscKey, false)]);
  } catch (e) { slackError = e.message; }

  let jqlFallbackError = null;
  if (myAccountId) {
    try {
      const processedKeys = new Set([key, haeKey, miscKey].filter(Boolean));
      const res = await jiraPost("/rest/api/3/search/jql", {
        jql: `worklogDate >= "${from}" AND worklogDate <= "${to}" AND worklogAuthor = "${myAccountId}"`,
        fields: ["worklog"],
        maxResults: 50,
      });
      for (const issue of res?.issues || []) {
        if (processedKeys.has(issue.key)) continue;
        const wl = issue.fields?.worklog || {};
        let worklogs = wl.worklogs || [];
        if ((wl.total || 0) > worklogs.length) {
          const startedAfterMs = new Date(from + "T00:00:00.000+0700").getTime();
          const full = await jiraGet(`/rest/api/3/issue/${issue.key}/worklog?maxResults=100&startedAfter=${startedAfterMs}`);
          worklogs = full?.worklogs || [];
        }
        for (const l of worklogs) {
          const wDate = l.started?.slice(0, 10);
          if (!wDate || !workdays.includes(wDate)) continue;
          if (l.author?.accountId !== myAccountId) continue;
          recordWorklog(wDate, issue.key, l);
        }
        processedKeys.add(issue.key);
      }
    } catch (e) { jqlFallbackError = e.message; }
  }

  const ctx = { haeKey, miscKey, defaultIssue: key, defaultComment: note, myId, messages };

  function classifyDay(d) {
    const actual   = loggedByDate[d] || {};
    const totalH   = Object.values(actual).reduce((s, h) => s + h, 0);
    const expected = detectEntries(d, { ...ctx, isHoliday: isHolidayFn(d) });

    if (totalH === 0) return { status: "missing", actual, totalH, expected };

    // Safety valve: after de-duping, a day still totalling well over a
    // working day almost certainly means messy source data (e.g. genuine
    // overlapping worklogs the dedupe can't safely merge), not a normal
    // wrong-split. Never auto-fix these — deleting-and-rewriting could
    // erase real logged hours. Surface them for manual review instead.
    if (totalH > WORK_HOURS + 2) return { status: "suspicious", actual, totalH, expected };

    if (totalH >= WORK_HOURS - 0.1) {
      const splitOk = expected.every(e => Math.abs((actual[e.ticket] || 0) - e.hours) <= 0.1)
        && Object.keys(actual).every(t => expected.some(e => e.ticket === t));
      if (splitOk) return { status: "ok", actual, totalH, expected };
      return { status: "wrong", actual, totalH, expected };
    }
    return { status: "wrong", actual, totalH, expected };
  }

  // ── CHECK ─────────────────────────────────────────────────────
  if (action === "check") {
    const periodSuffix = period ? ` — ${PERIOD_LABELS[period] || period}` : "";
    const lines = [`**Log Time — ${key}**  (${from} → ${to}${periodSuffix})`];

    if (slackError) {
      lines.push(`⚠️ Slack/Jira (HAE/MISC #${absenceChannelName}): lỗi — ${slackError}`);
      lines.push(`   _(nghỉ/lễ trong khoảng này có thể không được phát hiện đúng — không phải do bạn chưa log)_`);
    } else {
      const slackStatus = haeKey || miscKey
        ? `✅ #${absenceChannelName} — HAE: ${haeKey || "N/A"} | MISC: ${miscKey || "N/A"} | ${messages.length} message(s)`
        : `⚠️ #${absenceChannelName} — không tìm thấy HAE/MISC ticket (${messages.length} message(s))`;
      lines.push(slackStatus);
    }
    if (jqlFallbackError) {
      lines.push(`⚠️ Jira (tìm ticket khác ngoài ${key}/HAE/MISC): lỗi — ${jqlFallbackError}`);
      lines.push(`   _(có thể còn worklog trên ticket khác chưa được tính vào kết quả dưới đây)_`);
    }
    lines.push("");

    const classified = workdays.map(d => ({ d, ...classifyDay(d) }));
    const okDays         = classified.filter(x => x.status === "ok");
    const wrongDays      = classified.filter(x => x.status === "wrong");
    const missingDays    = classified.filter(x => x.status === "missing");
    const suspiciousDays = classified.filter(x => x.status === "suspicious");

    if (suspiciousDays.length) {
      lines.push("**⚠️ Cần kiểm tra thủ công (tổng giờ bất thường — KHÔNG auto-fix):**");
      suspiciousDays.forEach(({ d, actual, totalH }) => {
        const breakdown = Object.entries(actual).map(([t, h]) => `${t}: ${hoursToJira(h)}`).join(" + ");
        lines.push(`  🔍 ${d} — tổng ${hoursToJira(totalH)} (${breakdown})`);
      });
      lines.push(`     _(Tổng vượt xa 1 ngày công. Có thể worklog trên Jira/Tempo bị trùng hoặc chồng lấn — hãy mở Jira/Tempo kiểm tra & sửa tay. Tool cố ý KHÔNG đưa các ngày này vào auto-fix để tránh xóa nhầm worklog thật.)_`);
      lines.push("");
    }

    if (okDays.length) {
      lines.push("**Đã log đúng:**");
      okDays.forEach(({ d, actual }) => {
        const breakdown = Object.entries(actual).map(([t, h]) => `${t}: ${hoursToJira(h)}`).join(" + ");
        lines.push(`  ✅ ${d} — ${breakdown}`);
      });
      lines.push("");
    }

    if (wrongDays.length) {
      lines.push("**Cần sửa lại:**");
      wrongDays.forEach(({ d, actual, expected }) => {
        const actualStr   = Object.entries(actual).map(([t, h]) => `${t}: ${hoursToJira(h)}`).join(" + ");
        const expectedStr = expected.map(e => `${e.ticket}: ${hoursToJira(e.hours)}`).join(" + ");
        lines.push(`  ⚠️ ${d}`);
        lines.push(`     Đã log:  ${actualStr}`);
        lines.push(`     Nên log: ${expectedStr}  _(${expected[0]?.reason || ""})_`);
      });
      lines.push("");
      const wrongDates = wrongDays.map(x => x.d);
      lines.push(`Confirm sửa: gọi lại action="add", dates=${JSON.stringify(wrongDates)}, sau đó thêm confirm=true`);
      lines.push("_(Tool sẽ xóa worklog cũ và log lại đúng)_");
      lines.push("");
    }

    if (missingDays.length) {
      lines.push("**Chưa log:**");
      missingDays.forEach(({ d, expected }) => {
        const breakdown = expected.map(e => `${e.ticket}: ${hoursToJira(e.hours)}`).join(" + ");
        lines.push(`  ⬜ ${d} → ${breakdown}  _(${expected[0]?.reason || ""})_`);
      });
      lines.push("");
      const missingDates = missingDays.map(x => x.d);
      lines.push(`Confirm log missing: gọi lại action="add", dates=${JSON.stringify(missingDates)}, sau đó thêm confirm=true`);
    }

    if (!wrongDays.length && !missingDays.length && !suspiciousDays.length) lines.push("Tất cả ngày đã log đúng.");

    return lines.join("\n");
  }

  const confirmDates = Array.isArray(dates) ? dates : String(dates || "").split(",").map(s => s.trim()).filter(Boolean);
  if (!confirmDates.length) return '❌ Cần `dates` (array các ngày YYYY-MM-DD) để log/xóa time.';

  // ── DELETE ────────────────────────────────────────────────────
  if (action === "delete") {
    if (!confirm) {
      const lines = [`🗑️ **Delete Worklog Preview**`, ``];
      for (const d of confirmDates) {
        const existing = loggedByDate[d] || {};
        const existingH = Object.values(existing).reduce((s, h) => s + h, 0);
        if (existingH === 0) lines.push(`⏭️ **${d}** — không có worklog, bỏ qua`);
        else {
          const bd = Object.entries(existing).map(([t, h]) => `${t}: ${hoursToJira(h)}`).join(" + ");
          lines.push(`🗑️ **${d}** — xóa: ${bd}`);
        }
      }
      lines.push(``, `Confirm xóa: gọi lại với confirm=true`);
      return lines.join("\n");
    }
    const results = [];
    for (const d of confirmDates) {
      const ids = worklogIds[d] || [];
      if (!ids.length) { results.push(`⏭️ ${d} — không có worklog`); continue; }
      await Promise.all(ids.map(({ issueKey, id }) => deleteWorklog(issueKey, id).catch(() => {})));
      results.push(`🗑️ ${d} — đã xóa ${ids.length} worklog`);
    }
    return [`**Delete Worklog — ${key}**`, "", ...results].join("\n");
  }

  // ── ADD ───────────────────────────────────────────────────────
  let parsedManualEntries = null;
  if (manualEntries) {
    parsedManualEntries = Array.isArray(manualEntries) ? manualEntries : JSON.parse(manualEntries);
    const totalManual = parsedManualEntries.reduce((s, e) => s + (e.hours || 0), 0);
    if (totalManual <= 0) return "❌ `entries` phải có tổng giờ > 0.";
  }

  const plan = confirmDates.map(d => {
    const existing  = loggedByDate[d] || {};
    const existingH = Object.values(existing).reduce((s, h) => s + h, 0);
    const dayEntries = parsedManualEntries?.length
      ? parsedManualEntries.map(e => ({ ticket: e.ticket || key, hours: e.hours, comment: e.comment || note, reason: "Override thủ công" }))
      : detectEntries(d, { ...ctx, isHoliday: isHolidayFn(d) });
    const alreadyCorrect = !parsedManualEntries?.length && existingH > 0
      && dayEntries.every(e => Math.abs((existing[e.ticket] || 0) - e.hours) <= 0.1)
      && Object.keys(existing).every(t => dayEntries.some(e => e.ticket === t));
    return { d, existing, existingH, entries: dayEntries, alreadyCorrect };
  });

  if (!confirm) {
    const lines = [`📋 **Log Time Preview** — ${key}`, ``];
    if (parsedManualEntries?.length) lines.push(`_⚠️ Dùng entries thủ công (bỏ qua auto-detect từ Slack)_`, ``);
    for (const { d, existing, existingH, entries: dayEntries, alreadyCorrect } of plan) {
      if (alreadyCorrect) {
        const bd = Object.entries(existing).map(([t, h]) => `${t}: ${hoursToJira(h)}`).join(" + ");
        lines.push(`⏭️ **${d}** — đã đúng (${bd}), bỏ qua`);
      } else {
        const newBd = dayEntries.map(e => `${e.ticket}: ${hoursToJira(e.hours)}`).join(" + ");
        lines.push(`📅 **${d}**`);
        if (existingH > 0) {
          const oldBd = Object.entries(existing).map(([t, h]) => `${t}: ${hoursToJira(h)}`).join(" + ");
          lines.push(`  ❌ Xóa cũ: ${oldBd}`);
        }
        lines.push(`  ✅ Log mới: ${newBd}  _(${dayEntries[0]?.reason || ""})_`);
      }
    }
    lines.push(``, `Confirm: gọi lại với confirm=true`);
    if (!parsedManualEntries?.length) lines.push(`Override thủ công: thêm entries=[{ticket, hours, comment}]`);
    return lines.join("\n");
  }

  const results = [];
  for (const { d, existing, existingH, entries: dayEntries, alreadyCorrect } of plan) {
    if (alreadyCorrect) {
      const breakdown = Object.entries(existing).map(([t, h]) => `${t}: ${hoursToJira(h)}`).join(" + ");
      results.push(`⏭️ ${d} — đã log đúng (${breakdown}), bỏ qua`);
      continue;
    }
    if (existingH > 0) {
      const ids = worklogIds[d] || [];
      await Promise.all(ids.map(({ issueKey, id }) => deleteWorklog(issueKey, id).catch(() => {})));
    }
    const dayLines = [];
    for (const entry of dayEntries) {
      try {
        await addWorklog({ issue_key: entry.ticket, time_spent: hoursToJira(entry.hours), comment: entry.comment, started: toJiraStarted(d) });
        dayLines.push(`${entry.ticket} ${hoursToJira(entry.hours)} ✅`);
      } catch (e) {
        dayLines.push(`${entry.ticket} ❌ ${e.message}`);
      }
    }
    results.push(`${d}: ${dayLines.join(" + ")}`);
  }
  return [`**Log Time — ${key}**`, "", ...results].join("\n");
}
