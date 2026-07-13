#!/usr/bin/env node
// HR Logtime MCP Server — runs locally on the HR user's own machine
// (same pattern as PM Assistant's src/index.js) so Jira/Slack/Tempo/Google
// API calls go out over that machine's real network, not through a
// sandboxed agent environment's restricted egress proxy. Config in
// .env / config/config.json is read from THIS folder regardless of where
// Claude Code is invoked from.

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
const __dir = dirname(fileURLToPath(import.meta.url));

const _envPath = resolve(__dir, ".env");
if (existsSync(_envPath)) {
  readFileSync(_envPath, "utf8").split("\n").forEach(line => {
    const eq = line.indexOf("=");
    if (eq < 1) return;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (key && !process.env[key]) process.env[key] = val;
  });
}

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { hrMenu } from "./scripts/hr_menu.js";
import { hrConfigStatus } from "./scripts/hr_config.js";
import { logTime } from "./scripts/logtime.js";
import { updateAbsenceInfo } from "./scripts/update_absence.js";
import { setHaeMisc } from "./scripts/set_hae_misc.js";
import { exportReportConfigure, exportReportRun, exportReportNotify } from "./scripts/export_report.js";
import { missingLogtimeScan, missingLogtimeNotify } from "./scripts/missing_logtime.js";

const server = new Server(
  { name: "hr-skill", version: "2.0.0" },
  { capabilities: { tools: {} } }
);

// ─── List all tools ───────────────────────────────────────────────
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "hr_menu",
      description: "Hiển thị danh sách tất cả công việc HR Skill có thể làm, kèm lệnh gọi tương ứng và trạng thái cấu hình hiện tại. Dùng khi user hỏi \"làm được gì\", \"menu\", hoặc muốn xem tổng quan.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "hr_config",
      description: "Xem trạng thái cấu hình hiện tại (ticket log time, comment mặc định, template + folder company report) — mỗi mục kèm giá trị hiện tại (hoặc \"chưa cấu hình\") và cách đổi. QUY TRÌNH BẮT BUỘC khi gọi tool này: đi qua từng mục THEO THỨ TỰ, mỗi mục hỏi \"hiện tại là X — bạn có muốn đổi không?\" và CHỜ user trả lời trước khi qua mục kế — không hỏi dồn hết 1 lần, không tự đổi khi user chưa xác nhận. Cũng gọi tool này khi bất kỳ tool khác báo lỗi thiếu cấu hình.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "logtime",
      description: "Check/log/xem/xóa time cá nhân trên ticket Jira của mình. Nếu chưa cấu hình (lỗi trả về sẽ nói rõ), gọi tool hr_config trước để dẫn user qua bước setup, đừng tự hỏi issueKey/comment ngoài quy trình đó. action=check (mặc định) xem ngày nào thiếu/sai — chỉ đọc, không ghi. Khi HR muốn \"check time log\" mà chưa nói rõ khoảng thời gian, LUÔN hỏi HR chọn 1 trong 4: Tuần này / Tuần trước / Tháng này / Tháng trước, rồi gọi action=check với period tương ứng (thisWeek/lastWeek/thisMonth/lastMonth) — không tự đoán from/to bằng tay. Luôn hiển thị NGUYÊN VĂN kết quả action=check cho HR, không tự tóm tắt lại. action=add/delete BẮT BUỘC gọi không có confirm trước để lấy preview, hiển thị preview đó cho user, chỉ gọi lại với confirm=true sau khi user xác nhận rõ ràng (không phải câu hỏi/góp ý) — không bao giờ gọi confirm=true ngay lần đầu.",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["setup", "check", "view", "add", "delete"], description: "setup: cấu hình ticket lần đầu | check: xem ngày thiếu/sai (mặc định) | view: xem toàn bộ worklog | add: log time (cần preview trước) | delete: xóa worklog" },
          issueKey: { type: "string", description: "Dùng với action=setup: ticket cá nhân (ví dụ GP-82)" },
          comment: { type: "string", description: "Dùng với action=setup: comment mặc định khi log time" },
          absenceChannel: { type: "string", description: "Dùng với action=setup: tên Slack channel absence (mặc định vn-absence)" },
          absenceChannelId: { type: "string", description: "Dùng với action=setup, kèm absenceChannel: Slack channel ID tương ứng (cần cho gọi Slack API — chỉ bỏ trống nếu absenceChannel đã có ID mặc định)" },
          period: { type: "string", enum: ["thisWeek", "lastWeek", "thisMonth", "lastMonth"], description: "Dùng với action=check: 1 trong 4 lựa chọn khoảng thời gian mà HR chọn (Tuần này/Tuần trước/Tháng này/Tháng trước). Tự tính from/to đúng, ưu tiên hơn from/to/date nếu cả hai đều truyền." },
          date: { type: "string", description: "Kiểm tra/log 1 ngày cụ thể (YYYY-MM-DD)" },
          from: { type: "string", description: "Ngày bắt đầu khoảng kiểm tra (YYYY-MM-DD). Mặc định: thứ Hai tuần này. Bỏ qua nếu đã dùng period." },
          to: { type: "string", description: "Ngày kết thúc khoảng kiểm tra (YYYY-MM-DD). Mặc định: hôm nay. Bỏ qua nếu đã dùng period." },
          dates: { type: "array", items: { type: "string" }, description: "Mảng ngày cần log/xóa (YYYY-MM-DD). Dùng với action=add hoặc action=delete." },
          entries: { type: "array", items: { type: "object", properties: { ticket: { type: "string" }, hours: { type: "number" }, comment: { type: "string" } }, required: ["hours"] }, description: "Override thủ công entries thay vì auto-detect từ Slack." },
          confirm: { type: "boolean", description: "true: thực hiện ghi/xóa thật. Bắt buộc phải xem preview (gọi không có confirm) trước." },
        },
        required: [],
      },
    },
    {
      name: "update_absence",
      description: "Chủ động cập nhật absence cache (absence_cache.json) cho 1 ngày (mặc định hôm nay) bằng cách quét channel absence (vn-absence) — quét lại thật nếu cache tháng đó chưa fetch hôm nay, không thì dùng luôn cache có sẵn. Sau đó hiển thị danh sách ai đã xin đi muộn/về sớm/nghỉ trong ngày đó. Đây KHÔNG phải điều kiện bắt buộc trước khi dùng logtime/missing_logtime — 2 tool đó vẫn tự refresh cache ngầm khi cần, tool này chỉ để chủ động xem trước hoặc làm mới sớm.",
      inputSchema: {
        type: "object",
        properties: {
          date: { type: "string", description: "Ngày cần xem (YYYY-MM-DD). Mặc định: hôm nay." },
          force: { type: "boolean", description: "true: quét lại Slack ngay cả khi cache tháng đó đã fetch hôm nay rồi (dùng khi biết vừa có message mới)." },
        },
        required: [],
      },
    },
    {
      name: "set_hae_misc",
      description: "Setup ticket HAE \"Holidays & Events\" (1 ticket dùng chung mãi) và ticket MISC \"Absence\" (mỗi tháng 1 ticket), lưu key vào config.json để logtime dùng, rồi thông báo lên Slack #vn-absence. QUY TRÌNH BẮT BUỘC 3 bước: (1) action=status trước — tool báo: MISC tháng này đã/chưa có (kèm tên), HAE đã/chưa có (kèm tên); rồi HIỂN THỊ NGUYÊN VĂN các câu hỏi tool trả về cho HR và HỎI LẦN LƯỢT, chờ trả lời từng câu: nếu MISC tháng này CHƯA có → hỏi 'tạo mới MISC cho tháng này?'; nếu ĐÃ có → hỏi 'tạo mới MISC cho tháng sau?'; rồi hỏi 'tạo mới HAE không?'. Không tự quyết thay HR. (2) Sau khi HR trả lời rõ ràng → action=create với month=<tháng tool báo ở status>, createMisc=<true nếu HR đồng ý>, createHae=<true nếu HR đồng ý> — đây là bước tạo ticket thật trên Jira (chỉ tạo cái HR đồng ý; nếu ticket cùng tên đã có sẵn thì dùng lại, không tạo trùng). BẮT BUỘC gọi status trước create. (3) action=notify: gọi không confirm để xem preview FULL message, cho sửa (message=...) đến khi HR confirm mới gọi lại confirm=true để gửi thật. Không bao giờ dùng Slack MCP tool trực tiếp.",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["status", "create", "notify"], description: "status: xem trạng thái + lấy câu hỏi cho HR (không ghi) | create: tạo/dùng lại ticket theo lựa chọn HR | notify: xem/gửi thông báo Slack" },
          month: { type: "string", description: "Dùng với action=create: tháng mục tiêu cho MISC (YYYY-MM) — LẤY ĐÚNG giá trị tool trả ở bước status, không tự tính." },
          createMisc: { type: "boolean", description: "Dùng với action=create: true nếu HR đồng ý tạo MISC cho tháng mục tiêu." },
          createHae: { type: "boolean", description: "Dùng với action=create: true nếu HR đồng ý tạo HAE." },
          miscTitle: { type: "string", description: "Dùng với action=create: tên custom cho ticket MISC thay cho mặc định (mặc định tự sinh theo tháng)." },
          message: { type: "string", description: "Dùng với action=notify: nội dung tùy chỉnh thay cho message tự generate." },
          confirm: { type: "boolean", description: "Dùng với action=notify: true để gửi Slack thật. Bắt buộc xem preview (gọi không confirm) trước." },
        },
        required: [],
      },
    },
    {
      name: "export_report",
      description: "Tạo/update báo cáo giờ làm toàn công ty hàng tháng lên Google Sheet (\"Create timesheet\") (copy từ template, ghi vào Jira log/Jira absence/Jira OT/Timesheet/OT/MISC/WFH). Không cần roster — tự phát hiện toàn bộ nhân viên từ Tempo. Nếu chưa cấu hình template/folder (lỗi trả về sẽ nói rõ), gọi tool hr_config trước để dẫn user qua bước cấu hình. Khi HR muốn tạo report mà chưa nói rõ tháng, LUÔN hỏi HR chọn 1 trong 2: Tháng này / Tháng trước, rồi gọi action=run với period tương ứng (thisMonth/lastMonth) — không tự tính YYYY-MM bằng tay (tránh lỗi khi tháng trước đổi năm, ví dụ tháng 1 → tháng 12 năm trước). Ghi vào 1 file Google Sheet chung mà người khác có thể đang xem — trước lần đầu chạy action=run cho 1 tháng, nói rõ cho user sẽ tạo/update file nào rồi mới chạy (không cần hỏi lại mỗi lần chạy lại cùng tháng đó, vì chỉ update số liệu tại chỗ, không tạo file mới hay xóa gì). Riêng tab WFH: ngoài file tháng đó, cũng ghi cùng dữ liệu vào tab WFH của chính file template gốc (theo yêu cầu HR) — chỉ tab này, các tab khác không bao giờ đụng vào template. Sau khi action=run xong, LUÔN hỏi HR có muốn gửi thông báo lên Slack #vn-absence không (timesheet đã sẵn sàng cho toàn công ty check). Nếu có: action=notify BẮT BUỘC gọi không có confirm trước để xem preview FULL nội dung message (đã tự điền đúng tháng/năm/ngày hiện tại), cho sửa (message=...) đến khi HR confirm mới gọi lại với confirm=true để gửi thật. Không bao giờ dùng Slack MCP tool trực tiếp cho việc này.",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["configure", "run", "notify"], description: "configure: lưu template + folder Drive (làm 1 lần) | run: tạo/update report cho 1 tháng | notify: preview/gửi thông báo Slack (dùng data từ lần run gần nhất)" },
          templateUrl: { type: "string", description: "Dùng với action=configure: link Google Sheet template" },
          folderUrl: { type: "string", description: "Dùng với action=configure: link folder Drive chứa report hàng tháng" },
          period: { type: "string", enum: ["thisMonth", "lastMonth"], description: "Dùng với action=run: 1 trong 2 lựa chọn tháng mà HR chọn (Tháng này/Tháng trước). Tự tính YYYY-MM đúng, ưu tiên hơn month nếu cả hai đều truyền." },
          month: { type: "string", description: "Dùng với action=run: override tháng cụ thể, format YYYY-MM, thay cho period (chỉ dùng khi không phải tháng này/tháng trước)." },
          message: { type: "string", description: "Dùng với action=notify: nội dung tùy chỉnh thay cho message tự generate" },
          confirm: { type: "boolean", description: "Dùng với action=notify: true để gửi thật. Bắt buộc phải xem preview (gọi không có confirm) trước." },
        },
        required: ["action"],
      },
    },
    {
      name: "missing_logtime",
      description: "Quét công ty tìm ai thiếu log time trong khoảng ngày (\"Check Company time log\"), và gửi thông báo Slack lên channel absence. Khi HR muốn check company time log mà chưa nói rõ khoảng thời gian, LUÔN hỏi HR chọn 1 trong 4: Tuần này / Tuần trước / Tháng này / Tháng trước (giống task \"Check my time log\" cá nhân), rồi gọi action=scan với period tương ứng (thisWeek/lastWeek/thisMonth/lastMonth) — không tự đoán from/to bằng tay. action=scan trước (đọc, không gửi gì) — LUÔN hiển thị NGUYÊN VĂN kết quả trả về cho HR xem (đủ cả 2 mục \"Thiếu log time\" và \"Đã khai nghỉ...\", đủ tên từng người từng ngày), TUYỆT ĐỐI KHÔNG tự tóm tắt/diễn giải lại thành đoạn văn ngắn hơn — tóm tắt có thể vô tình bỏ sót hoặc làm sai lệch thông tin mà HR cần tự kiểm tra. Sau đó hỏi HR có muốn gửi thông báo không, rồi action=notify để preview (cũng phải hiển thị NGUYÊN VĂN), rồi action=notify confirm=true để gửi thật. Không bao giờ gửi trực tiếp mà không qua bước preview.",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["scan", "notify"], description: "scan: quét ai thiếu log time | notify: preview hoặc gửi thông báo (dùng data từ lần scan gần nhất)" },
          period: { type: "string", enum: ["thisWeek", "lastWeek", "thisMonth", "lastMonth"], description: "Dùng với action=scan: 1 trong 4 lựa chọn khoảng thời gian mà HR chọn (Tuần này/Tuần trước/Tháng này/Tháng trước). Tự tính from/to đúng, ưu tiên hơn from/to nếu cả hai đều truyền." },
          from: { type: "string", description: "Dùng với action=scan: ngày bắt đầu (YYYY-MM-DD). Mặc định: thứ Hai tuần này. Bỏ qua nếu đã dùng period." },
          to: { type: "string", description: "Dùng với action=scan: ngày kết thúc (YYYY-MM-DD). Mặc định: hôm nay. Bỏ qua nếu đã dùng period." },
          message: { type: "string", description: "Dùng với action=notify: nội dung tùy chỉnh thay cho message tự generate" },
          confirm: { type: "boolean", description: "Dùng với action=notify: true để gửi thật. Bắt buộc phải xem preview (gọi không có confirm) trước." },
        },
        required: ["action"],
      },
    },
  ],
}));

// ─── Handle tool calls ────────────────────────────────────────────
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    let result;
    switch (name) {
      case "hr_menu":
        result = hrMenu();
        break;
      case "hr_config":
        result = hrConfigStatus();
        break;
      case "logtime":
        result = await logTime(args);
        break;
      case "update_absence":
        result = await updateAbsenceInfo(args);
        break;
      case "set_hae_misc":
        result = await setHaeMisc(args);
        break;
      case "export_report":
        if (args?.action === "configure") result = exportReportConfigure(args);
        else if (args?.action === "run") result = await exportReportRun(args);
        else if (args?.action === "notify") result = await exportReportNotify(args);
        else result = '❌ Cần `action`: "configure", "run" hoặc "notify".';
        break;
      case "missing_logtime":
        if (args?.action === "scan") result = await missingLogtimeScan(args);
        else if (args?.action === "notify") result = await missingLogtimeNotify(args);
        else result = '❌ Cần `action`: "scan" hoặc "notify".';
        break;
      default:
        return { content: [{ type: "text", text: `❌ Tool "${name}" không tồn tại.` }], isError: true };
    }
    return { content: [{ type: "text", text: result }] };
  } catch (err) {
    return { content: [{ type: "text", text: `❌ Lỗi: ${err.message}` }], isError: true };
  }
});

// ─── Start server ─────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("✅ HR Logtime MCP Server đang chạy...");
