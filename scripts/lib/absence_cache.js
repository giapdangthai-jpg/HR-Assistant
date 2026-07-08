// Per-month HAE/MISC ticket + holiday + absence-channel-message cache.
// Shared by logtime.js (personal check), missing_logtime.js (company-wide
// check), and set_hae_misc.js (which seeds haeKey/miscKey directly from
// real ticket creation instead of waiting for a Slack mention to be
// scraped).

import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { loadConfig } from "./store.js";
import { getIssue } from "./jira.js";
import { getChannelHistory } from "./slack.js";
import { extractADFText, parseTicketKeys } from "./worklog.js";

const __dir = dirname(fileURLToPath(import.meta.url));
export const ABSENCE_CACHE_JSON = resolve(__dir, "../../config/absence_cache.json");

export function loadAbsenceCache() {
  if (!existsSync(ABSENCE_CACHE_JSON)) return {};
  try { return JSON.parse(readFileSync(ABSENCE_CACHE_JSON, "utf8")); }
  catch { return {}; }
}

export function saveAbsenceCache(cache) {
  writeFileSync(ABSENCE_CACHE_JSON, JSON.stringify(cache, null, 2), "utf8");
}

// Merge {haeKey, miscKey} into a month's cache entry without touching
// `fetchedAt` — the next getMonthAbsenceData() call for that month still
// refreshes normally (re-scans Slack, recomputes holidayDates), just
// starting from these keys instead of null.
export function patchAbsenceCacheKeys(yearMonth, { haeKey, miscKey }) {
  const cache = loadAbsenceCache();
  const entry = cache[yearMonth] || {};
  cache[yearMonth] = {
    ...entry,
    haeKey:  haeKey  || entry.haeKey  || null,
    miscKey: miscKey || entry.miscKey || null,
  };
  saveAbsenceCache(cache);
  return cache[yearMonth];
}

async function fetchHolidayDatesFromKey(haeKey, yearMonth) {
  if (!haeKey) return [];
  try {
    const issue = await getIssue(haeKey);
    const text  = extractADFText(issue.fields?.description) + " " + (issue.fields?.summary || "");
    const [year, month] = yearMonth.split("-").map(Number);
    const days = new Date(year, month, 0).getDate();
    const M    = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const holidays = [];
    for (let d = 1; d <= days; d++) {
      const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      if ([
        new RegExp(`\\b${d}/${month}\\b`),
        new RegExp(`\\b${String(d).padStart(2,"0")}/${String(month).padStart(2,"0")}\\b`),
        new RegExp(`\\b${d}\\s+${M[month-1]}\\b`, "i"),
        new RegExp(`\\b${M[month-1]}\\s+${d}\\b`, "i"),
      ].some(r => r.test(text))) holidays.push(dateStr);
    }
    return holidays;
  } catch { return []; }
}

// Current month: refresh once per day. Past months: cache forever.
// `config.json` (`hr.haeIssue` / `hr.miscIssueByMonth`) is the primary
// source for the ticket keys — set by set_hae_misc.js once it creates or
// adopts them — so a value recorded there is authoritative and can't be
// overridden by a stray Slack mention. Falling back to regex-scanning the
// channel's messages only covers months from before that config existed.
//
// `messages` in the returned/cached entry is EVERY message in the channel
// that month, from any author (not filtered to one person) — company-wide
// callers (missing_logtime.js) need every employee's own absence claims,
// not just one HR's; personal callers (logtime.js) filter this list down
// to their own Slack user id themselves.
export async function getMonthAbsenceData(yearMonth, channelId, today, { force = false } = {}) {
  const cache = loadAbsenceCache();
  const entry = cache[yearMonth] || {};
  const isCurrentMonth = today.startsWith(yearMonth);

  const cfg = loadConfig();
  const configHaeKey  = cfg.hr?.haeIssue || null;
  const configMiscKey = cfg.hr?.miscIssueByMonth?.[yearMonth] || null;

  // `entry.messages` (present, even if `[]`) distinguishes the current
  // schema from an older cache entry that only stored `myMessages`
  // (filtered to one person) — treat that as stale so it's re-fetched
  // under the new schema instead of silently looking like "no messages".
  if (!force && entry.fetchedAt && entry.messages && (!isCurrentMonth || entry.fetchedAt === today)) {
    // Even a cache hit should reflect a config value set/changed after
    // this entry was last fetched (e.g. set_hae_misc ran today too).
    if ((configHaeKey && configHaeKey !== entry.haeKey) || (configMiscKey && configMiscKey !== entry.miscKey)) {
      return { ...entry, haeKey: configHaeKey || entry.haeKey, miscKey: configMiscKey || entry.miscKey };
    }
    return entry;
  }

  const [year, month] = yearMonth.split("-").map(Number);
  const oldest = Math.floor((Date.UTC(year, month - 1, 1) - 7 * 3600 * 1000) / 1000);
  const latestMs = isCurrentMonth
    ? new Date(today + "T23:59:59+0700").getTime()
    : Date.UTC(year, month, 1) - 7 * 3600 * 1000 - 1;

  let messages = [];
  try { messages = await getChannelHistory(channelId, oldest, Math.floor(latestMs / 1000)); } catch {}

  let haeKey  = configHaeKey  || entry.haeKey  || null;
  let miscKey = configMiscKey || entry.miscKey || null;
  if (!configHaeKey || !configMiscKey) {
    for (const msg of messages) {
      if (!msg.text) continue;
      if (/HAE-\d+|MISC-\d+/i.test(msg.text)) {
        const keys = parseTicketKeys(msg.text);
        if (keys.hae  && !configHaeKey)  haeKey  = keys.hae;
        if (keys.misc && !configMiscKey) miscKey = keys.misc;
      }
    }
  }

  const holidayDates = await fetchHolidayDatesFromKey(haeKey, yearMonth);

  const newEntry = {
    haeKey,
    miscKey,
    holidayDates,
    messages: messages.map(m => ({ text: m.text || "", ts: m.ts, user: m.user || null })),
    fetchedAt: today,
  };
  cache[yearMonth] = newEntry;
  saveAbsenceCache(cache);
  return newEntry;
}
