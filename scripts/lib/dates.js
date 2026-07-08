// Date utilities (Vietnam timezone, UTC-safe arithmetic) — ported from PM Assistant's utils/dates.js

export function todayVN() {
  return dateFromUnixVN(Date.now() / 1000);
}

// Unix seconds (e.g. a Slack message `ts`) → YYYY-MM-DD in Vietnam time —
// using UTC slicing here would misdate messages sent late at night VN time
// (UTC lags VN by 7h, so e.g. 00:30 VN on day N is 17:30 UTC on day N-1).
export function dateFromUnixVN(unixSeconds) {
  const d = new Date(new Date(unixSeconds * 1000).toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh" }));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function addDays(dateISO, n) {
  const d = new Date(dateISO + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function workdaysInRange(fromISO, toISO) {
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

export function mondayOfWeek(today) {
  const d = new Date(today + "T12:00:00Z");
  const dow = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - (dow === 0 ? 6 : dow - 1));
  return d.toISOString().slice(0, 10);
}

export function toJiraStarted(dateISO) {
  return `${dateISO}T09:00:00.000+0700`;
}

export function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

// yearMonth: "YYYY-MM" → { from, to, year, month, days }
export function monthRange(yearMonth) {
  const [year, month] = yearMonth.split("-").map(Number);
  const days = daysInMonth(year, month);
  return {
    from: `${yearMonth}-01`,
    to:   `${yearMonth}-${String(days).padStart(2, "0")}`,
    year, month, days,
  };
}

export const MONTH_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
export const MONTH_FULL  = ["January","February","March","April","May","June","July","August","September","October","November","December"];

// yearMonth: "YYYY-MM", delta: integer months to shift (±) — handles
// year rollover in both directions (Dec+1 → next Jan, Jan-1 → prev Dec).
export function shiftMonth(yearMonth, delta) {
  const [y, m] = yearMonth.split("-").map(Number);
  const total = y * 12 + (m - 1) + delta;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${ny}-${String(nm).padStart(2, "0")}`;
}

// "thisMonth"/"lastMonth"/"nextMonth" → "YYYY-MM" — computed here (not left
// to Claude to eyeball) so the December/January rollover in either
// direction is never miscounted by hand. Shared by export_report.js
// ("Create timesheet" task) and set_hae_misc.js.
export function resolveMonthPeriod(period, today) {
  const thisMonth = today.slice(0, 7);
  switch (period) {
    case "thisMonth": return thisMonth;
    case "lastMonth": return shiftMonth(thisMonth, -1);
    case "nextMonth": return shiftMonth(thisMonth, 1);
    default: return null;
  }
}

export const PERIOD_LABELS = { thisWeek: "tuần này", lastWeek: "tuần trước", thisMonth: "tháng này", lastMonth: "tháng trước", nextMonth: "tháng sau" };

// The 4 period presets `hr_menu`'s "Check time log" / "Check Company time
// log" tasks offer — computed here (not left to Claude to eyeball from
// "today") so week/month rollovers across month or year boundaries are
// never miscounted by hand. Shared by logtime.js and missing_logtime.js.
export function resolvePeriod(period, today) {
  const monday = mondayOfWeek(today);
  switch (period) {
    case "thisWeek": return { from: monday, to: today };
    case "lastWeek": { const m = addDays(monday, -7); return { from: m, to: addDays(m, 6) }; }
    case "thisMonth": return { from: `${today.slice(0, 7)}-01`, to: today };
    case "lastMonth": {
      const [y, m] = today.slice(0, 7).split("-").map(Number);
      const py = m === 1 ? y - 1 : y;
      const pm = m === 1 ? 12 : m - 1;
      return monthRange(`${py}-${String(pm).padStart(2, "0")}`);
    }
    default: return null;
  }
}
