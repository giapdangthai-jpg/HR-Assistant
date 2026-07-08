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

export function parseAbsenceHours(text) {
  if (/full.?day|cả ngày|nghỉ nguyên ngày/i.test(text)) return WORK_HOURS;
  if (/half.?day|nửa ngày/i.test(text)) return WORK_HOURS / 2;
  const m = text.match(/(\d+(?:[.,]\d+)?)\s*(?:h\b|giờ\b|tiếng\b|hour)/i);
  return m ? parseFloat(m[1].replace(",", ".")) : null;
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
    if (/overtime|sprint on track|request overtime/i.test(msg.text)) continue;
    if (!/nghỉ|leave|absence|off\b|wfh|work.?from.?home|về sớm|đến muộn|xin phép/i.test(msg.text)) continue;

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
