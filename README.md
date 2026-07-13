# HR Logtime MCP Server — Hướng dẫn triển khai

Server MCP local (giống PM Assistant), cung cấp 7 tool cho Claude dùng qua chat bình thường:

1. **`hr_menu`** — hiện danh sách công việc có thể làm (giống `pm_menu` của PM Assistant). Hỏi Claude *"HR skill làm được gì"* để xem menu này.
2. **`hr_config`** — xem/đổi cấu hình (ticket log time, comment, template + folder company report).
3. **`logtime`** — mỗi HR tự check/log time cho ticket Jira cá nhân của mình ("Check my time log").
4. **`update_absence`** — chủ động cập nhật absence cache + xem ai xin đi muộn/về sớm/nghỉ trong 1 ngày ("Update absence information").
5. **`set_hae_misc`** — đầu tháng tạo (hoặc dùng lại) ticket HAE + MISC, rồi thông báo lên Slack.
6. **`export_report`** — tạo/update báo cáo giờ làm toàn công ty hàng tháng lên Google Sheet ("Create timesheet", chỉ 1-2 người phụ trách cần dùng).
7. **`missing_logtime`** — quét công ty tìm ai thiếu log time / khai nghỉ nhưng log sai ("Check Company time log"), gửi nhắc nhở lên Slack ("Send time log warning to Slack").

**Quan trọng: chạy trên máy cá nhân qua Claude Code app/CLI, không chạy trong môi trường sandbox (Cowork...).** Server này gọi thẳng ra Jira/Slack/Tempo/Google qua mạng của máy đang chạy — sandbox có proxy chặn domain ngoài sẽ không gọi được (đã gặp thực tế: 403 tới `api.atlassian.com`, `slack.com`...). Chạy local thì không bị giới hạn này.

## 1. Yêu cầu

- **Node.js >= 18** (`node --version`). Nếu chưa có, cài từ https://nodejs.org (bản LTS).
- **Claude Code** cài trên máy (app hoặc CLI) — không phải môi trường cloud/sandbox.

## 2. Copy folder này vào máy HR

Copy toàn bộ thư mục `HR_skill/` sang máy cần dùng. **Không copy** các file/folder sau nếu có (chứa secret riêng của máy cũ, mỗi máy nên có riêng):
- `.env`
- `config/config.json`
- `node_modules/`

(Đã nằm trong `.gitignore` nên dùng git thì tự động không đi theo.)

## 3. Cài dependency

```bash
cd HR_skill
npm install
```

## 4. Cấu hình `.env`

```bash
cp .env.example .env
```

Mở `.env`, điền theo bảng dưới. **Chỉ cần điền phần tương ứng với tính năng bạn thực sự dùng.**

| Biến | Cần cho | Lấy ở đâu |
|---|---|---|
| `JIRA_DOMAIN` | `logtime`, `update_absence`, `set_hae_misc`, `export_report`, `missing_logtime` | `torilab-ai.atlassian.net` (cố định) |
| `JIRA_EMAIL` | `logtime`, `update_absence`, `set_hae_misc`, `export_report`, `missing_logtime` | Email Jira của **người đang dùng máy này** — cần quyền "Create Issues" trên project MISC (và HAE lần đầu) để `set_hae_misc` tạo được ticket |
| `JIRA_API_TOKEN` | `logtime`, `update_absence`, `set_hae_misc`, `export_report`, `missing_logtime` | Jira → Account Settings → Security → **API tokens** → Create |
| `SLACK_USER_TOKEN` | `logtime` (auto-detect nghỉ/lễ), `update_absence` (quét/xem), `set_hae_misc` (gửi thông báo), `export_report` (đọc WFH channel + gửi thông báo), `missing_logtime` (đọc/gửi Slack) | Hỏi admin Slack nội bộ, dùng chung 1 token cho cả team — cần scope `users:read.email` |
| `TEMPO_API_TOKEN` | `export_report`, `missing_logtime` | Jira → Apps → **Tempo** → Settings → API Integration |
| `GOOGLE_OAUTH_CLIENT_ID` / `_SECRET` / `_REFRESH_TOKEN` | `export_report` | Xem mục 7.2 — chạy 1 script để lấy tự động |

## 5. Đăng ký MCP server

Tùy máy HR đang dùng **Claude Code (CLI)** hay **Claude Desktop app** — chọn 1 trong 2 cách dưới (dùng cả 2 cũng không sao nếu HR dùng cả 2 app). **Cả 2 cách đều KHÔNG cần tạo project hay file instruction nào** — tool có sẵn ở mọi conversation ngay sau khi đăng ký.

### Cách A — Claude Code (CLI)

```bash
claude mcp add hr-skill -s user -- node /đường/dẫn/tuyệt/đối/tới/HR_skill/mcp-server.js
```

(Thay đường dẫn cho đúng máy bạn — dùng đường dẫn tuyệt đối, không dùng `~` hay đường dẫn tương đối.)

**`-s user` là bắt buộc** — mặc định `claude mcp add` dùng scope `local` (chỉ hoạt động khi Claude Code đang mở đúng project/folder lúc bạn chạy lệnh đăng ký). Dùng `-s user` để tool có sẵn ở **mọi conversation trên máy này**.

Kiểm tra đã đăng ký: `claude mcp list`. Sau khi đăng ký, mở 1 session Claude Code mới (hoặc restart session hiện tại) để nó nhận tool mới.

### Cách B — Claude Desktop app

Đóng app, mở file config (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`), thêm vào mục `mcpServers` (giữ nguyên các server khác nếu có, ví dụ PM Assistant):

```json
"hr-skill": {
  "command": "/opt/homebrew/bin/node",
  "args": ["/đường/dẫn/tuyệt/đối/tới/HR_skill/mcp-server.js"]
}
```

(`command` dùng đường dẫn tuyệt đối tới `node` — chạy `which node` để lấy đúng đường dẫn trên máy đó, vì Desktop app không chắc kế thừa `PATH` giống terminal.) Không cần thêm `env` — server tự đọc `.env` trong folder `HR_skill/`. Mở lại app để nhận config mới.

---

Cả 2 cách đều không cần khai báo biến môi trường trong config — server tự đọc `.env` trong chính folder `HR_skill/` khi khởi động. Các rule quan trọng (bắt buộc xem preview trước khi ghi/gửi...) đã nằm trong mô tả của tool, Claude luôn thấy được qua MCP protocol bất kể đang làm việc ở project nào — không cần thêm CLAUDE.md hay bất kỳ instruction nào. File `CLAUDE.md` trong folder này chỉ là tài liệu kỹ thuật cho ai cần sửa code sau này.

Kiểm tra hoạt động bằng cách hỏi Claude: *"bạn có tool logtime không?"*

## 6. Setup lần đầu — dùng "Config"

Không nhớ có thể gọi gì? Hỏi Claude *"HR skill làm được gì"* — Claude hiện menu kèm câu lệnh mẫu (giống `pm_menu` ở PM Assistant), mục cuối là **Config**.

Trong Claude Code, nói:

> "config"

Claude sẽ đi qua từng mục — **ticket log time cá nhân**, **comment mặc định**, **template report**, **folder report** — hiện giá trị hiện tại (hoặc "chưa cấu hình") và hỏi bạn có muốn đổi không cho từng mục, chờ bạn trả lời rồi mới qua mục kế. Chỉ người phụ trách company report mới cần đổi 2 mục cuối (template/folder) — HR thường chỉ cần mục 1-2.

Đổi lại bất kỳ lúc nào cũng gọi lại "config". Nếu gọi tool nào mà thiếu thông tin cần thiết, Claude sẽ tự dẫn bạn qua bước config trước khi làm tiếp.

Sau khi đã config ticket cá nhân, dùng bình thường:

> "check logtime của tôi tuần này"

`check` chỉ đọc, không ghi gì. Nếu thiếu/sai ngày nào, Claude sẽ hỏi xác nhận trước khi thực sự ghi vào Jira — không bao giờ ghi thẳng mà không hỏi trước.

## 7. Company monthly report (chỉ người phụ trách mới cần làm phần này)

### 7.1. Lấy `TEMPO_API_TOKEN`
Jira → click icon **Apps** trên thanh menu → **Tempo** → **Settings** → **API Integration** → tạo token mới → dán vào `.env`.

### 7.2. Lấy Google OAuth credentials (làm 1 lần)

**a) Tạo OAuth Client ID:**

1. Vào https://console.cloud.google.com/apis/credentials/consent → nếu chưa cấu hình, làm theo màn hình (chọn Internal nếu có, hoặc External + thêm email của bạn vào **Test users**).
2. Vào https://console.cloud.google.com/apis/credentials → **+ CREATE CREDENTIALS → OAuth client ID** → Application type: **Desktop app** → Create.
3. Copy **Client ID** và **Client Secret**, dán vào `.env` (`GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`).

**b) Đăng nhập 1 lần để lấy refresh token:**

```bash
node scripts/google_login.js
```

Script in ra 1 URL — mở trong browser, đăng nhập bằng tài khoản Google **có quyền truy cập template + folder báo cáo**, cấp quyền. Tự động lưu `GOOGLE_OAUTH_REFRESH_TOKEN` vào `.env`. Không cần đăng nhập lại (trừ khi tự revoke quyền trong Google Account settings).

> Ban đầu định dùng Service Account, nhưng bị chính sách Workspace của công ty chặn ("Policy set by the administrators ... prohibits the sharing of items with ... because it is not a Google Account in a compatible allowlisted domain"). OAuth cá nhân né được vấn đề này vì không cần "share" file/folder cho ai cả.

### 7.3. Cấu hình template + folder đích + kênh WFH (làm 1 lần)

Trong Claude Code, nói **"config"** (xem mục 6) — Claude sẽ hỏi lần lượt template và folder cho company report, chỉ cần trả lời khi tới 2 mục đó.

Kênh WFH (`wfh-request`, khác `vn-overtime-request` chỉ có OT request) chưa có trong luồng "config" — cấu hình trực tiếp vào `config.json`:

```bash
node --input-type=module -e '
import { updateConfig } from "./scripts/lib/store.js";
updateConfig({ hr: { wfhChannel: { name: "wfh-request", id: "<CHANNEL_ID>" } } });
'
```

Nếu không cấu hình, `export_report` vẫn chạy bình thường, chỉ bỏ qua update tab `WFH` (báo `⚠️`, không lỗi).

### 7.4. Chạy báo cáo hàng tháng ("Create timesheet")

Không cần chuẩn bị danh sách nhân viên — tool tự lấy toàn bộ người đã log time trong tháng đó trực tiếp từ Tempo. Trong Claude Code, nói **"create timesheet"** — Claude sẽ hỏi bạn chọn Tháng này hoặc Tháng trước rồi gọi `export_report(action="run", period=...)`. Cũng có thể chỉ định tháng cụ thể khác qua `month` (YYYY-MM) nếu cần.

Lần đầu chạy cho 1 tháng: tạo file mới tên `Timesheet <Mon> <Year>` trong folder đã cấu hình (copy từ template). Chạy lại cho cùng tháng đó: **update lại** dữ liệu trong file đã có, không tạo file trùng. Riêng tab `WFH`: ngoài file tháng đó, cùng dữ liệu cũng được ghi vào tab `WFH` của chính file template gốc (chỉ tab này — mọi tab khác không bao giờ đụng đến template).

**Cache Slack:** lần đầu chạy, tool quét toàn bộ lịch sử kênh `wfh-request` (có thể chậm), lưu vào `config/wfh_cache.json`. Từ lần sau chỉ quét tin nhắn mới. Muốn hỏi Claude thông tin WFH cụ thể mà không cần chạy lại report, cứ hỏi trực tiếp — Claude có thể đọc file cache để trả lời ngay.

**Thông báo lên Slack:** sau khi tạo/update xong, Claude sẽ hỏi bạn có muốn gửi thông báo timesheet đã sẵn sàng lên `#vn-absence` không. Nếu có: Claude gọi `export_report(action="notify")` — hiển thị **full** nội dung message (đã tự điền đúng tháng/năm/ngày hiện tại) để bạn xem/sửa trước, chỉ gửi thật sau khi bạn xác nhận (`confirm=true`).

## 8. Check Company time log + nhắc nhở toàn công ty

Trong Claude Code, nói **"check company time log"** — Claude sẽ hỏi bạn chọn 1 trong 4: Tuần này / Tuần trước / Tháng này / Tháng trước (giống "Check my time log" cá nhân).

Claude gọi `missing_logtime(action="scan", period=...)` — chỉ đọc, không gửi gì. Kết quả gồm 2 phần: (1) ai thiếu log time (tổng giờ log ngày đó < 7h), và (2) ai đã khai đi muộn/về sớm/xin nghỉ trên Slack (`#vn-absence`) nhưng chưa log đủ giờ đó vào ticket MISC của tháng — tức log đủ giờ nhưng vào nhầm ticket, không tách phần nghỉ ra.

Muốn gửi nhắc nhở lên Slack ("Send time log warning to Slack"): Claude hỏi lại, hiển thị preview đầy đủ nội dung message trước, chỉ gửi thật sau khi bạn xác nhận rõ ràng — không bao giờ gửi thẳng.

**Update absence information**: muốn chủ động xem trước ai xin đi muộn/về sớm/nghỉ trong 1 ngày (không cần chờ check time log), nói **"update absence information"** — Claude gọi `update_absence` (mặc định hôm nay, có thể chỉ định `date` khác). Tool này không bắt buộc phải chạy trước — `logtime`/`missing_logtime` vẫn tự cập nhật absence cache khi cần, tool này chỉ để xem chủ động sớm hơn.

## 9. Set HAE and MISC (đầu tháng)

Đầu mỗi tháng, cần ticket HAE (Holidays & Events, dùng chung mãi mãi) và ticket MISC (Absence, tạo mới mỗi tháng) để `logtime`/`missing_logtime` tự phát hiện nghỉ lễ/nghỉ phép. Trong Claude Code, nói **"set HAE và MISC"** — Claude đi 3 bước:

1. `set_hae_misc(action="status")` — báo trạng thái: **MISC tháng này** đã/chưa có (kèm tên), **HAE** đã/chưa có (kèm tên). Rồi hỏi bạn lần lượt: nếu MISC tháng này **chưa có** → "tạo mới MISC cho tháng này?"; nếu **đã có** → "tạo mới MISC cho tháng sau?"; và "tạo mới HAE không?".
2. `set_hae_misc(action="create", month=..., createMisc=..., createHae=...)` — tạo (hoặc dùng lại nếu đã có ticket trùng tên) đúng những gì bạn đồng ý. MISC và HAE độc lập — có thể tạo một, cả hai, hoặc không.
3. `set_hae_misc(action="notify")` — preview rồi gửi thông báo lên `#vn-absence` cho toàn công ty biết link HAE + MISC của tháng đó (chỉ gửi khi đã đủ cả 2 ticket).

**Cần quyền Jira "Create Issues"** trên project MISC (và HAE lần đầu) cho tài khoản trong `.env` — nếu thiếu, `action="create"` sẽ báo lỗi rõ 403/400 thay vì tạo âm thầm sai.

## 10. Lỗi thường gặp

| Lỗi | Nguyên nhân | Cách sửa |
|---|---|---|
| Claude không thấy tool `logtime`/`export_report`/`missing_logtime`/... | Chưa đăng ký MCP server, hoặc chưa mở session mới sau khi đăng ký | `claude mcp list` để kiểm tra, mở session mới |
| `❌ Không lấy được worklog từ Jira` | Máy đang chạy bị chặn mạng tới Jira (ví dụ chạy nhầm trong sandbox), hoặc token sai | Chạy trên máy local thật, kiểm tra lại `.env` |
| `Chưa cấu hình ticket cá nhân cho logtime` | Chưa gọi `action="setup"` | Xem mục 6 |
| `TEMPO_API_TOKEN chưa được set` | Thiếu token trong `.env` | Xem mục 7.1 |
| `Chưa cấu hình Google auth` | Thiếu `GOOGLE_OAUTH_*` trong `.env` | Xem mục 7.2 |
| `Google API 404 File not found` | Tài khoản login (`google_login.js`) không có quyền truy cập template/folder | Đăng nhập lại bằng tài khoản có quyền |
| `missing_scope` khi resolve Slack ID | Token Slack thiếu `users:read.email` | Slack App settings → OAuth & Permissions → thêm scope → reinstall app |
| `⚠️ WFH: N người không có trong danh sách CODE` | Người đó chưa có dòng CODE trong tab `Timesheet '` của file report | HR tự thêm dòng CODE mới |
| `set_hae_misc` báo lỗi 403/400 khi tạo ticket MISC | Tài khoản trong `.env` thiếu quyền "Create Issues" trên project MISC | Nhờ Jira admin cấp quyền cho project MISC (và HAE nếu lần đầu) |
| `⚠️ (chưa resolve Slack ID)` — người hiện `@Tên` thường, không tag được | Jira ẩn email của account đó nên không tự bắc cầu Jira→Slack | Thêm vào `config.json` → `hr.slackIdByJiraName`: `{ "Tên Jira chính xác": "U…SlackID" }`. Lấy Slack ID bằng cách tìm tên trong Slack (Profile → Copy member ID), hoặc nhờ Claude tra giúp qua `users.list`. |

## 11. Giới hạn đã biết (có chủ đích, không phải bug)

- Cột theo ngày ở `Jira log`/`Jira absence` là **giờ thật đã log trong Jira/Tempo** — không phải giả định "7h/ngày làm".
- OT (`Jira OT`) chỉ tính giờ có tick checkbox **Overtime** lúc log time trong Tempo — không suy ra từ ticket hay từ khóa trong comment.
- WFH lấy từ tin nhắn Slack, không có bước "duyệt" — bất kỳ ai gõ tin nhắn có chữ "WFH" đều được tính.
- Không tính các cột lương/ngày nghỉ phép/seniority — cần dữ liệu HR không có trong Jira.

Chi tiết kỹ thuật đầy đủ (cho ai cần sửa code) xem `CLAUDE.md`.
