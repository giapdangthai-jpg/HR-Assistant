let _jiraCreds = null;
function jiraCredentials() {
  if (_jiraCreds) return _jiraCreds;
  const domain = process.env.JIRA_DOMAIN;
  const email  = process.env.JIRA_EMAIL;
  const token  = process.env.JIRA_API_TOKEN;
  if (!domain || !email || !token) throw new Error("JIRA_DOMAIN, JIRA_EMAIL hoặc JIRA_API_TOKEN chưa được set trong .env.");
  _jiraCreds = { domain, email, auth: "Basic " + Buffer.from(`${email}:${token}`).toString("base64") };
  return _jiraCreds;
}

export function jiraDomain() {
  return jiraCredentials().domain;
}

function jiraHeaders() {
  return {
    Authorization: jiraCredentials().auth,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Retries GET only, and only on errors that are genuinely transient (rate
// limit / 5xx / network blip) — confirmed as a real production issue:
// company-wide scans fire dozens of concurrent GET lookups (one per
// distinct Jira issue id that period), and Jira occasionally rate-limits
// or briefly errors on a handful of them. Without a retry, that one
// lookup's caller (resolveIssueKey in tempo.js) permanently mislabels a
// real ticket, which made a real MISC-logged worklog invisible to
// missing_logtime.js's absence cross-check. Never extend this retry to
// POST/DELETE — retrying a write after a lost response could silently
// duplicate a Jira ticket or worklog, which is worse than failing once.
async function req(method, path, body, attempt = 0) {
  const canRetry = method === "GET" && attempt < 3;
  let res;
  try {
    res = await fetch(`https://${jiraDomain()}${path}`, {
      method,
      headers: jiraHeaders(),
      body: body != null ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    if (canRetry) { await sleep(300 * (attempt + 1)); return req(method, path, body, attempt + 1); }
    throw e;
  }
  if (res.status === 204) return null;
  if (canRetry && (res.status === 429 || res.status >= 500)) {
    const retryAfter = Number(res.headers.get("Retry-After"));
    await sleep((retryAfter > 0 ? retryAfter : (attempt + 1) * 0.5) * 1000);
    return req(method, path, body, attempt + 1);
  }
  const data = await res.json();
  if (!res.ok) {
    const msg = data.errorMessages?.join(", ") || JSON.stringify(data.errors) || res.statusText;
    throw new Error(`Jira ${res.status}: ${msg}`);
  }
  return data;
}

// Caps concurrent GETs — company-wide scans resolve dozens of distinct
// Jira identities/issue keys via one `Promise.all`, which without this
// fires that many simultaneous requests at once. Confirmed as a real
// contributor to the transient rate-limit/5xx errors the retry above
// recovers from; throttling here means fewer retries are needed at all,
// and avoids the opposite failure mode of retry-with-backoff piling up
// under an unbounded burst (measured against real data: an unthrottled
// burst plus per-request retry backoff pushed one company-wide scan well
// past 60s). Centralized here (not in each caller) so every GET call
// site benefits automatically — don't reintroduce a per-caller limiter.
function createLimiter(max) {
  let active = 0;
  const queue = [];
  return async function run(fn) {
    if (active >= max) await new Promise(resolve => queue.push(resolve));
    active++;
    try { return await fn(); }
    finally {
      active--;
      const next = queue.shift();
      if (next) next();
    }
  };
}
const limitGet = createLimiter(10);

export const jiraGet    = (path)       => limitGet(() => req("GET", path));
export const jiraPost   = (path, body) => req("POST",   path, body);
export const jiraDelete = (path)       => req("DELETE", path);

export function toADF(text) {
  if (!text) return null;
  return {
    type: "doc",
    version: 1,
    content: text.split(/\n{2,}/).filter(Boolean).map(para => ({
      type: "paragraph",
      content: [{ type: "text", text: para }],
    })),
  };
}

export async function getMyself() {
  return jiraGet("/rest/api/3/myself");
}

// Case/whitespace-insensitive exact-summary match within a project — used
// by set_hae_misc.js to avoid creating a duplicate HAE/MISC ticket if one
// with the exact intended title already exists (HAE's title never changes
// month to month, so without this every run would create a new one).
export async function findIssueByExactSummary(projectKey, summary) {
  const norm = s => (s || "").trim().toLowerCase();
  try {
    const res = await jiraPost("/rest/api/3/search/jql", {
      jql: `project = ${projectKey} ORDER BY created DESC`,
      fields: ["summary"],
      maxResults: 100,
    });
    const match = (res?.issues || []).find(i => norm(i.fields?.summary) === norm(summary));
    return match?.key || null;
  } catch { return null; }
}

export async function createSimpleIssue({ projectKey, summary, extraFields }) {
  const fields = {
    project: { key: projectKey },
    summary,
    issuetype: { name: "Task" },
    ...(extraFields || {}),
  };
  const created = await jiraPost("/rest/api/3/issue", { fields });
  return created.key;
}

export async function getIssue(issueKey) {
  return jiraGet(`/rest/api/3/issue/${issueKey}?fields=summary,description,status`);
}

export async function addWorklog({ issue_key, time_spent, comment, started }) {
  const body = { timeSpent: time_spent, started };
  if (comment) body.comment = toADF(comment);
  return jiraPost(`/rest/api/3/issue/${issue_key}/worklog`, body);
}

export async function getWorklogs(issue_key) {
  return jiraGet(`/rest/api/3/issue/${issue_key}/worklog?maxResults=5000`);
}

export async function deleteWorklog(issue_key, worklog_id) {
  return jiraDelete(`/rest/api/3/issue/${issue_key}/worklog/${worklog_id}`);
}

const _userCache = new Map();

// Resolve a Jira accountId (as seen in Tempo worklog `author.accountId`) to
// { displayName, email }, cached — company-wide report/scan discovers
// everyone straight from worklogs, then just needs identity info per
// accountId found. `email` is used to resolve the matching Slack user for
// @mentions in missing_logtime.js.
export async function getJiraUser(accountId) {
  if (!accountId) return null;
  if (_userCache.has(accountId)) return _userCache.get(accountId);
  let user = null;
  try {
    const d = await jiraGet(`/rest/api/3/user?accountId=${encodeURIComponent(accountId)}`);
    user = d.displayName ? { displayName: d.displayName, email: d.emailAddress || null } : null;
  } catch { user = null; }
  _userCache.set(accountId, user);
  return user;
}

const _emailToUserCache = new Map();

// Reverse of getJiraUser: resolve a Slack user's email (from
// getSlackUserEmail) to their Jira { accountId, displayName }. Jira's
// user/search query matches email as well as display name — verified
// directly against real accounts.
export async function findJiraUserByEmail(email) {
  if (!email) return null;
  if (_emailToUserCache.has(email)) return _emailToUserCache.get(email);
  let user = null;
  try {
    const d = await jiraGet(`/rest/api/3/user/search?query=${encodeURIComponent(email)}&maxResults=5`);
    if (Array.isArray(d) && d.length) {
      const exact = d.find(u => (u.emailAddress || "").toLowerCase() === email.toLowerCase());
      const u = exact || d[0];
      user = { accountId: u.accountId, displayName: u.displayName };
    }
  } catch { user = null; }
  _emailToUserCache.set(email, user);
  return user;
}

