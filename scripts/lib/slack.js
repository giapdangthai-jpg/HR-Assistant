// Subset of PM Assistant's utils/slack.js — reading (absence detection in
// logtime.js, missing-logtime scan) and sending (missing-logtime notify,
// governed by the same preview-then-confirm discipline as PM Assistant's
// Slack tools — never call these without a preview step first).

const API = "https://slack.com/api";

function token() {
  const t = process.env.SLACK_USER_TOKEN;
  if (!t) throw new Error("SLACK_USER_TOKEN chưa được set.");
  return t;
}

export function resolveSlackChannel(cfg) {
  if (!cfg) return { id: "", name: "" };
  if (typeof cfg === "object") return { id: cfg.id || "", name: cfg.name || cfg.id || "" };
  return { id: cfg, name: cfg };
}

export async function lookupUserByEmail(email) {
  try {
    const res = await fetch(`${API}/users.lookupByEmail?email=${encodeURIComponent(email)}`, {
      headers: { Authorization: `Bearer ${token()}` },
    });
    const d = await res.json();
    return d.ok ? (d.user?.id || null) : null;
  } catch { return null; }
}

let _authCache = null;
async function getAuthInfo() {
  if (_authCache) return _authCache;
  try {
    const res = await fetch(`${API}/auth.test`, { headers: { Authorization: `Bearer ${token()}` } });
    const d = await res.json();
    if (d.ok) _authCache = { user_id: d.user_id || null, url: d.url || null };
  } catch {}
  return _authCache || { user_id: null, url: null };
}

export async function getSelfUserId() {
  return (await getAuthInfo()).user_id;
}

const _userEmailCache = new Map();

// Resolve a Slack user ID (e.g. a WFH request's message author) to their
// email, cached — needed to cross-reference against Jira identity.
export async function getSlackUserEmail(userId) {
  if (!userId) return null;
  if (_userEmailCache.has(userId)) return _userEmailCache.get(userId);
  let email = null;
  try {
    const res = await fetch(`${API}/users.info?user=${userId}`, { headers: { Authorization: `Bearer ${token()}` } });
    const d = await res.json();
    email = d.ok ? (d.user?.profile?.email || null) : null;
  } catch { email = null; }
  _userEmailCache.set(userId, email);
  return email;
}

export async function getChannelHistory(channelId, oldestUnix, latestUnix) {
  const messages = [];
  let cursor = "";
  while (true) {
    const params = new URLSearchParams({
      channel: channelId, limit: "200", oldest: String(oldestUnix),
      ...(latestUnix && { latest: String(latestUnix) }),
      ...(cursor && { cursor }),
    });
    try {
      const res = await fetch(`${API}/conversations.history?${params}`, {
        headers: { Authorization: `Bearer ${token()}` },
      });
      const d = await res.json();
      if (!d.ok) break;
      messages.push(...(d.messages || []));
      cursor = d.response_metadata?.next_cursor || "";
      if (!cursor || !d.has_more) break;
    } catch { break; }
  }
  return messages;
}

export async function postToChannel(channel, text) {
  const res = await fetch(`${API}/chat.postMessage`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ channel, text, unfurl_links: false, unfurl_media: false }),
  });
  const d = await res.json();
  if (d.ok) return d;
  throw new Error(`Slack chat.postMessage: ${d.error}`);
}

export async function postAndGetLink(channelId, message) {
  if (!channelId || !message) return null;
  const [result, { url: wsUrl }] = await Promise.all([postToChannel(channelId, message), getAuthInfo()]);
  try {
    if (wsUrl && result?.channel && result?.ts) {
      const tsNoDot = String(result.ts).replace(".", "");
      return `${wsUrl.replace(/\/$/, "")}/archives/${result.channel}/p${tsNoDot}`;
    }
  } catch {}
  return null;
}
