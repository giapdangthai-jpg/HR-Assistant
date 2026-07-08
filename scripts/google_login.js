#!/usr/bin/env node
// One-time interactive login: get a Google OAuth refresh token under YOUR
// own account (not a service account), so export_report.js can read/write
// Drive & Sheets as you — no file/folder sharing needed at all, which
// sidesteps a Workspace admin policy that blocks sharing with foreign
// identities like service accounts.
//
// Prerequisite: an OAuth Client ID of type "Desktop app", created in the
// same GCP project as the service account (Console -> APIs & Services ->
// Credentials -> Create Credentials -> OAuth client ID -> Desktop app).
// That only needs GCP project access, not Workspace Super Admin.
//
// Usage:
//   node scripts/google_login.js
// (requires GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET already in .env)

import { createServer } from "http";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { loadEnvFile } from "./lib/env.js";
import { SCOPES } from "./lib/gsheets.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const ENV_FILE = resolve(__dir, "..", ".env");

loadEnvFile();

function fail(msg) { console.error(msg); process.exit(1); }

function upsertEnvVar(key, value) {
  let text = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8") : "";
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, "m");
  text = re.test(text) ? text.replace(re, line) : (text.trimEnd() + `\n${line}\n`);
  writeFileSync(ENV_FILE, text, "utf8");
}

async function main() {
  const clientId     = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    fail("❌ Cần GOOGLE_OAUTH_CLIENT_ID và GOOGLE_OAUTH_CLIENT_SECRET trong .env trước (từ OAuth Client ID loại Desktop app).");
  }

  const server = createServer();
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const redirectUri = `http://127.0.0.1:${port}`;

  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES,
    access_type: "offline",
    prompt: "consent",
  })}`;

  console.log("Mở URL này trong browser (đăng nhập bằng tài khoản có quyền truy cập file/folder cần dùng):\n");
  console.log(authUrl);
  console.log("\nĐang chờ bạn hoàn tất đăng nhập...");

  const code = await new Promise((resolvePromise, rejectPromise) => {
    server.on("request", (req, res) => {
      const url = new URL(req.url, redirectUri);
      const code  = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(error
        ? `<p>Lỗi: ${error}. Có thể đóng tab này và thử lại.</p>`
        : `<p>Đã đăng nhập xong, có thể đóng tab này.</p>`);
      if (error) rejectPromise(new Error(error));
      else if (code) resolvePromise(code);
    });
  });
  server.close();

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
    }),
  });
  const tokenData = await tokenRes.json();
  if (!tokenRes.ok) fail(`❌ Đổi code lấy token thất bại: ${tokenData.error_description || tokenData.error}`);
  if (!tokenData.refresh_token) {
    fail("❌ Google không trả refresh_token (thường do đã login trước đó mà chưa revoke). Vào https://myaccount.google.com/permissions, revoke quyền của app này, rồi chạy lại.");
  }

  upsertEnvVar("GOOGLE_OAUTH_REFRESH_TOKEN", tokenData.refresh_token);
  console.log("\n✅ Đã lưu GOOGLE_OAUTH_REFRESH_TOKEN vào .env. Từ nay export_report.js sẽ tự dùng, không cần đăng nhập lại.");
}

main().catch(e => fail(`❌ ${e.message}`));
