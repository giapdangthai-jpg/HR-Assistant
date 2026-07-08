// Tempo Timesheets REST API client.
//
// Why this exists: this company's Jira worklogs are synced through the Tempo
// Timesheets app. Every Tempo-synced worklog's Jira `author` field is the
// Tempo integration bot account, not the real employee — confirmed by
// direct inspection (worklogAuthor=<employee> matches zero issues that the
// employee clearly logged time on; worklogAuthor=<Tempo bot> matches them).
// The real author is only recoverable via Tempo's own API.
//
// Docs: https://apidocs.tempo.io/ — generate a token in Jira under
// Apps → Tempo → Settings → API Integration, then set TEMPO_API_TOKEN.

import { jiraGet } from "./jira.js";

const BASE = "https://api.tempo.io/4";

function tempoToken() {
  const t = process.env.TEMPO_API_TOKEN;
  if (!t) throw new Error("TEMPO_API_TOKEN chưa được set — cần token này cho export company-wide (Jira → Apps → Tempo → API Integration).");
  return t;
}

async function tempoReq(pathOrUrl) {
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${BASE}${pathOrUrl}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${tempoToken()}`, Accept: "application/json" } });
  const data = await res.json();
  if (!res.ok) {
    const msg = data.errors?.map(e => e.message).join(", ") || res.statusText;
    throw new Error(`Tempo ${res.status}: ${msg}`);
  }
  return data;
}

// Every Tempo worklog company-wide in [fromISO, toISO] — no per-employee
// roster needed at all, this endpoint already covers everyone who logged
// any time in the period (verified: a full month returns every real
// employee, paginated correctly via metadata.next).
export async function fetchCompanyWorklogsInRange(fromISO, toISO) {
  const out = [];
  let next = `/worklogs?from=${fromISO}&to=${toISO}&limit=1000`;
  while (next) {
    const d = await tempoReq(next);
    out.push(...(d.results || []));
    next = d.metadata?.next || null;
  }
  return out;
}

const _issueKeyCache = new Map();

// Tempo's worklog payload only carries the Jira issue id, not its key —
// resolve and cache it (shared MISC/HAE/personal tickets repeat a lot).
// Only successful lookups are cached — a transient Jira API failure must
// never be memorized as "this issue has no key" for the rest of the
// server process's lifetime. Confirmed as a real bug: a single momentary
// failure resolving a MISC worklog's id permanently mislabeled it as
// `ISSUE-<id>` for that whole session, making a real MISC log invisible
// to missing_logtime.js's "logged to MISC?" check and export_report.js's
// absence-ticket matching — both silently treated it as "not MISC" from
// then on. Retrying on every call until it succeeds is deliberate, not a
// missed optimization.
export async function resolveIssueKey(issueId) {
  if (!issueId) return null;
  if (_issueKeyCache.has(issueId)) return _issueKeyCache.get(issueId);
  try {
    const d = await jiraGet(`/rest/api/3/issue/${issueId}?fields=key`);
    if (d.key) _issueKeyCache.set(issueId, d.key);
    return d.key || null;
  } catch {
    // Don't cache the failure — one issue's transient lookup error must
    // not abort the whole `Promise.all` batch this runs inside (company-
    // wide scans resolve 100+ ids per call), but leaving the cache empty
    // means the very next lookup of this same id retries for real instead
    // of reusing a permanently-poisoned negative result.
    return null;
  }
}

// Overtime is tracked via a Tempo work attribute ("Overtime", key `_Overtime_`,
// a checkbox the user ticks while logging time) — NOT inferable from the
// ticket key or comment text. Verified directly against real worklogs:
// ticked entries carry `{ key: "_Overtime_", value: "true" }` in `attributes.values`.
export function isOvertimeWorklog(w) {
  return (w.attributes?.values || []).some(a => a.key === "_Overtime_" && (a.value === "true" || a.value === true));
}

// Normalize a Tempo worklog into a simple shape: { accountId, date, issueKey, hours, comment, overtime }
export async function normalizeTempoWorklog(w) {
  const issueKey = w.issue?.key || await resolveIssueKey(w.issue?.id);
  return {
    accountId: w.author?.accountId || null,
    date: w.startDate,
    issueKey: issueKey || `ISSUE-${w.issue?.id}`,
    hours: (w.timeSpentSeconds || 0) / 3600,
    comment: w.description || "",
    overtime: isOvertimeWorklog(w),
  };
}
