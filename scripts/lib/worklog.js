// Ported verbatim from PM Assistant's utils/worklog.js — keep in sync so
// personal logtime behaves identically across both tools.

export const WORK_HOURS = 7;

export function hoursToJira(h) {
  const hrs  = Math.floor(h);
  const mins = Math.round((h - hrs) * 60);
  return mins > 0 ? `${hrs}h ${mins}m` : `${hrs}h`;
}

export function extractADFText(node) {
  if (!node) return "";
  if (node.type === "text") return node.text || "";
  if (Array.isArray(node.content)) return node.content.map(extractADFText).join(" ");
  return "";
}

export function parseTicketKeys(text) {
  return {
    hae:  text.match(/\b(HAE-\d+)\b/i)?.[1]?.toUpperCase()  || null,
    misc: text.match(/\b(MISC-\d+)\b/i)?.[1]?.toUpperCase() || null,
  };
}

// Keywords that mark a message as an absence/late/early/WFH request.
// Single source of truth — imported by update_absence.js and used by
// detectAbsenceClaim below, so all three call sites (personal check,
// company-wide check, on-demand refresh) recognize the exact same set of
// phrasings. Covers both Vietnamese and the English wordings people
// actually use in #vn-absence ("be late", "leave early", "day off",
// "off this morning", "out of office", "sick", ...).
export const ABSENCE_KEYWORDS = /nghỉ|xin phép|về sớm|đến muộn|đi muộn|đi trễ|leave|absence|\boff\b|day ?off|wfh|work.?from.?home|\blate\b|\bsick\b|out of office|\booo\b/i;
export const ABSENCE_EXCLUDE  = /overtime|sprint on track|request overtime/i;

export function parseAbsenceHours(text) {
  if (/full.?day|cả ngày|nghỉ nguyên ngày/i.test(text)) return WORK_HOURS;
  if (/half.?day|nửa ngày/i.test(text)) return WORK_HOURS / 2;
  const h = text.match(/(\d+(?:[.,]\d+)?)\s*(?:h\b|giờ\b|tiếng\b|hour)/i);
  if (h) return parseFloat(h[1].replace(",", "."));
  // Minutes ("30 mins", "30 phút", "20'" apostrophe notation) — without
  // this, "be late 30 mins" / "late 20'" would fall through to null and
  // get treated as a full-day (7h) absence.
  const min = text.match(/(\d+)\s*(?:m\b|min|mins|minute|minutes|phút|['’])/i);
  if (min) return parseFloat((parseInt(min[1], 10) / 60).toFixed(2));
  // Half-day by session, when no explicit hours/minutes are given
  // ("off this morning", "leave this afternoon"). Same convention as the
  // WFH parser (morning = 3h, afternoon = 4h). Checked AFTER explicit
  // hours/minutes above, so "leave early 1h this afternoon" still returns
  // 1h, not 4h. Only reached for messages already confirmed to be absence
  // requests (parseAbsenceHours is called only after the ABSENCE_KEYWORDS
  // filter in detectAbsenceClaim), so "meeting this morning" never lands
  // here.
  if (/\bmorning\b|buổi sáng|sáng nay/i.test(text)) return 3;
  if (/\bafternoon\b|buổi chiều|chiều nay/i.test(text)) return 4;
  return null;
}

// dateISO: "YYYY-MM-DD" string
export function mentionsDate(text, dateISO) {
  const [y, m, d] = dateISO.split("-").map(Number);
  const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  const SHORT  = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return [
    new RegExp(`\\b${d}[/\\-]${m}\\b`),
    new RegExp(`\\b${String(d).padStart(2,"0")}[/\\-]${String(m).padStart(2,"0")}\\b`),
    new RegExp(`\\b${d}[/\\-]${m}[/\\-]${y}\\b`),
    new RegExp(`\\b${MONTHS[m-1]}\\s+${d}\\b`, "i"),
    new RegExp(`\\b${SHORT[m-1]}\\s+${d}\\b`, "i"),
    new RegExp(`\\b${d}\\s+${SHORT[m-1]}\\b`, "i"),
  ].some(r => r.test(text));
}

// Does `authorId` have an absence-type message (đi muộn/về sớm/xin nghỉ/
// wfh/leave) in `messages` that applies to `dateISO`? Shared by logtime.js
// (checking one HR against their own messages) and missing_logtime.js
// (checking every employee against their own messages, company-wide) —
// keep both call sites' absence detection behaving identically.
// Returns { hours, fullDay } if a claim is found (explicit hours parsed,
// or a full day when none is stated), else null.
export function detectAbsenceClaim(dateISO, messages, authorId) {
  for (const msg of messages) {
    if (!msg.text) continue;
    if (ABSENCE_EXCLUDE.test(msg.text)) continue;
    if (!ABSENCE_KEYWORDS.test(msg.text)) continue;

    const fromAuthor = authorId && msg.user === authorId;
    if (!fromAuthor) continue;
    const msgDate = msg.ts ? new Date(parseFloat(msg.ts) * 1000).toISOString().slice(0, 10) : "";
    const relevant = msgDate === dateISO || mentionsDate(msg.text, dateISO);
    if (!relevant) continue;

    const absHours = parseAbsenceHours(msg.text);
    return absHours != null
      ? { hours: parseFloat(Math.min(absHours, WORK_HOURS).toFixed(1)), fullDay: false }
      : { hours: WORK_HOURS, fullDay: true };
  }
  return null;
}
