// WFH request detection from the "wfh-request" Slack channel (verified
// channel: C0ALU4JK2UF — NOT vn-overtime-request, which only contains OT
// requests, confirmed by scanning 6 months of that channel and finding
// zero WFH mentions).
//
// Real message shape (sampled from the actual channel):
//   "I would like to WFH today afternoon (7/7) for personal matters."
//   "I would like to request WFH today (July 7th) due to health matter."
//   "I would like to request WFH on Thursday morning (July 9th) due to..."
//   "I'd like to request WFH tomorrow due to health matter."
// Always first-person (the requester is the message author, never posted
// on someone else's behalf like the OT-request channel's messages are).
//
// Hour mapping (given by HR, not inferred): morning = 3h, afternoon = 4h,
// full day (no morning/afternoon keyword) = 7h.
//
// Caching: scanning the whole channel on every report run would be slow
// and wasteful. `config/wfh_cache.json` stores every parsed entry plus a
// `lastScannedTs` checkpoint — subsequent scans only fetch messages newer
// than that checkpoint. The cache file is plain, readable JSON so HR can
// also just ask Claude questions about it directly without a re-scan.

import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { getChannelHistory } from "./slack.js";
import { dateFromUnixVN, addDays } from "./dates.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const WFH_CACHE_JSON = resolve(__dir, "../../config/wfh_cache.json");

const MONTH_ABBR = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];

export function isWfhMessage(text) {
  return /\bwfh\b/i.test(text || "");
}

export function parseWfhHours(text) {
  if (/\bmorning\b|\bsáng\b/i.test(text)) return 3;
  if (/\bafternoon\b|\bchiều\b/i.test(text)) return 4;
  return 7;
}

function monthIndexFromName(name) {
  return MONTH_ABBR.indexOf(name.slice(0, 3).toLowerCase());
}

// Explicit parenthesized date mentions only — e.g. "(7/7)", "(7th/7)",
// "(July 7th)", "(6 July)", "(June 30)". Day-first for the numeric form,
// matching this org's convention seen throughout (worklog.js's mentionsDate
// does the same).
function extractExplicitDate(text, year) {
  let m = text.match(/\((\d{1,2})(?:st|nd|rd|th)?\s*\/\s*(\d{1,2})\)/);
  if (m) return isoFromDayMonth(Number(m[1]), Number(m[2]), year);

  m = text.match(/\((\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,})\)/);
  if (m) {
    const mi = monthIndexFromName(m[2]);
    if (mi >= 0) return isoFromDayMonth(Number(m[1]), mi + 1, year);
  }

  m = text.match(/\(([A-Za-z]{3,})\s+(\d{1,2})(?:st|nd|rd|th)?\)/);
  if (m) {
    const mi = monthIndexFromName(m[1]);
    if (mi >= 0) return isoFromDayMonth(Number(m[2]), mi + 1, year);
  }

  return null;
}

function isoFromDayMonth(day, month, year) {
  if (!day || !month || month < 1 || month > 12) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// Which date does this WFH request apply to? Explicit parenthesized date
// wins; otherwise "tomorrow" shifts by one day; anything else ("today",
// "this morning/afternoon", or no date mentioned at all) defaults to the
// day the message was sent.
export function extractWfhDate(text, messageDateISO) {
  const year = Number(messageDateISO.slice(0, 4));
  const explicit = extractExplicitDate(text, year);
  if (explicit) return explicit;
  if (/\btomorrow\b/i.test(text)) return addDays(messageDateISO, 1);
  return messageDateISO;
}

function loadWfhCache() {
  if (!existsSync(WFH_CACHE_JSON)) return { lastScannedTs: null, entries: [] };
  try { return JSON.parse(readFileSync(WFH_CACHE_JSON, "utf8")); }
  catch { return { lastScannedTs: null, entries: [] }; }
}

function saveWfhCache(cache) {
  writeFileSync(WFH_CACHE_JSON, JSON.stringify(cache, null, 2), "utf8");
}

// Incrementally scan the WFH channel: only fetches messages newer than the
// last checkpoint, parses new WFH-mentioning ones, appends to the cache,
// and returns the FULL cached entry list (old + new).
export async function scanWfhChannel(channelId) {
  const cache = loadWfhCache();
  const oldest = cache.lastScannedTs ? parseFloat(cache.lastScannedTs) + 0.000001 : 0;
  const messages = await getChannelHistory(channelId, oldest, undefined);

  let maxTs = cache.lastScannedTs;
  const newEntries = [];
  for (const msg of messages) {
    if (!msg.text || !msg.user) continue;
    if (!maxTs || parseFloat(msg.ts) > parseFloat(maxTs)) maxTs = msg.ts;
    if (!isWfhMessage(msg.text)) continue;
    const messageDateISO = dateFromUnixVN(parseFloat(msg.ts));
    newEntries.push({
      ts: msg.ts,
      slackUserId: msg.user,
      date: extractWfhDate(msg.text, messageDateISO),
      hours: parseWfhHours(msg.text),
      text: msg.text.slice(0, 300),
    });
  }

  cache.entries = [...cache.entries, ...newEntries];
  cache.lastScannedTs = maxTs;
  saveWfhCache(cache);
  return cache.entries;
}
