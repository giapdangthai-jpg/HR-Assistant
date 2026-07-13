// Same idea as PM Assistant's pm_menu.js — a numbered task list with example
// phrasing, so HR can pick a number or just say the command instead of
// needing to know exact tool/argument names. Config-related items live
// under the single "Config" entry at the end (see hr_config.js) rather
// than being scattered as their own numbered tasks.

import { loadConfig, isConfigured } from "./lib/store.js";

const TASKS = [
  { n: 1, icon: "⏰", name: "Check my time log", cmd: "check time log", hint: "sẽ hỏi chọn: tuần này / tuần trước / tháng này / tháng trước" },
  { n: 2, icon: "🏢", name: "Check Company time log", cmd: "check company time log", hint: "sẽ hỏi chọn: tuần này / tuần trước / tháng này / tháng trước" },
  { n: 3, icon: "📣", name: "Send time log warning to Slack", cmd: "gửi nhắc nhở thiếu log time lên Slack" },
  { n: 4, icon: "📅", name: "Update absence information", cmd: "update absence information hôm nay", hint: "cập nhật absence cache + xem ai xin đi muộn/về sớm/nghỉ hôm nay" },
  { n: 5, icon: "📊", name: "Create timesheet", cmd: "create timesheet", hint: "sẽ hỏi chọn: tháng này / tháng trước" },
  { n: 6, icon: "🗂️", name: "Set HAE and MISC", cmd: "set HAE và MISC", hint: "xem trạng thái MISC/HAE, hỏi tạo mới cho tháng này/tháng sau, rồi thông báo Slack" },
  { n: 7, icon: "⚙️", name: "Config", cmd: "config" },
];

export function hrMenu() {
  const cfg = loadConfig();
  const lines = [`## HR Skill — Danh sách công việc`, ``];

  TASKS.forEach(t => {
    lines.push(`**${t.n}. ${t.icon} ${t.name}**`);
    lines.push(`   → \`${t.cmd}\`${t.hint ? ` _(${t.hint})_` : ""}`);
    lines.push(``);
  });

  lines.push(`---`);
  if (isConfigured()) {
    lines.push(`✅ Ticket log time cá nhân: **${cfg.hr.autoLogIssue}**`);
  } else {
    lines.push(`⚠️ Chưa setup ticket log time cá nhân — dùng lệnh số 7 (Config) trước khi check/log time.`);
  }
  if (cfg.companyTimesheet?.templateFileId && cfg.companyTimesheet?.driveFolderId) {
    lines.push(`✅ Company report đã cấu hình template + folder.`);
  } else {
    lines.push(`⚠️ Company report chưa cấu hình đầy đủ — dùng lệnh số 7 (Config) nếu bạn là người phụ trách report.`);
  }
  lines.push(``);
  lines.push(`*Chọn số hoặc gõ lệnh để bắt đầu.*`);

  return lines.join("\n");
}
