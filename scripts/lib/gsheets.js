// Google Sheets + Drive client, authenticated as a real user via OAuth
// refresh token — acts AS a Workspace account that already has access to
// the files, so no "share this file with a foreign identity" step is
// needed. (A service-account JWT approach was tried first but rejected by
// this org's Workspace policy: "Policy set by the administrators ...
// prohibits sharing with ... because it is not a Google Account in a
// compatible allowlisted domain". User OAuth sidesteps that entirely.) Get
// a refresh token once via `node scripts/google_login.js` (needs
// GOOGLE_OAUTH_CLIENT_ID/SECRET from a Desktop-app OAuth client in a GCP
// project — that only needs GCP project access, not Workspace Admin).
//
// Why this is needed at all: the Drive MCP tools available to Claude
// (copy_file, create_file, read_file_content, ...) can create/copy whole
// files but have no way to write into a specific tab of an EXISTING
// spreadsheet — populating "Jira log"/"Jira absence"/"Jira OT" on a file
// that already exists needs the real Sheets API (spreadsheets.values.update).

const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const SCOPES = "https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/spreadsheets";

let _tokenCache = null; // { token, expiresAt }
async function getAccessToken() {
  if (_tokenCache && _tokenCache.expiresAt > Date.now() + 60_000) return _tokenCache.token;

  const clientId     = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const refreshToken  = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("Chưa cấu hình Google auth — chạy `node scripts/google_login.js` (cần GOOGLE_OAUTH_CLIENT_ID/SECRET trong .env trước).");
  }

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Google OAuth refresh ${res.status}: ${data.error_description || data.error || res.statusText}`);

  _tokenCache = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return _tokenCache.token;
}

async function googleReq(method, url, body) {
  const token = await getAccessToken();
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json();
  if (!res.ok) {
    const msg = data.error?.message || res.statusText;
    throw new Error(`Google API ${res.status}: ${msg}`);
  }
  return data;
}

// ─── Drive ──────────────────────────────────────────────────────────

export async function driveFindFileByName(name, parentId) {
  const q = `name = '${name.replace(/'/g, "\\'")}' and '${parentId}' in parents and trashed = false`;
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)`;
  const data = await googleReq("GET", url);
  return data.files?.[0] || null;
}

// The template is a real .xlsx file in Drive (confirmed via files.get:
// mimeType application/vnd.openxmlformats-officedocument.spreadsheetml.sheet),
// not a native Google Sheet — the Sheets API can't write to that format at
// all ("must not be an Office file"). Passing the target mimeType in the
// copy request converts it to a native Sheet at copy time (verified: every
// tab survives the conversion), so only the per-month copy needs to be
// Sheets-native — the original template file is left untouched.
export async function driveCopyFile(fileId, name, parentId) {
  const url = `https://www.googleapis.com/drive/v3/files/${fileId}/copy`;
  return googleReq("POST", url, { name, parents: [parentId], mimeType: "application/vnd.google-apps.spreadsheet" });
}

// ─── Sheets ─────────────────────────────────────────────────────────

export async function sheetsGetValues(spreadsheetId, a1Range) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(a1Range)}`;
  const data = await googleReq("GET", url);
  return data.values || [];
}

export async function sheetsClearRange(spreadsheetId, a1Range) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(a1Range)}:clear`;
  return googleReq("POST", url, {});
}

export async function sheetsUpdateValues(spreadsheetId, a1Range, values) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(a1Range)}?valueInputOption=RAW`;
  return googleReq("PUT", url, { values });
}

// Replace an entire tab's contents: clear a generous range first (covers
// last month's possibly-larger grid), then write the fresh values from A1.
export async function sheetsReplaceSheetContents(spreadsheetId, sheetName, values) {
  await sheetsClearRange(spreadsheetId, `'${sheetName}'!A1:BZ2000`);
  if (values.length) await sheetsUpdateValues(spreadsheetId, `'${sheetName}'!A1`, values);
}
