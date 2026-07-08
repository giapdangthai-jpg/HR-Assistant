// Config wizard status — lists every configurable section with its
// current value, so Claude can walk HR through them ONE AT A TIME ("hiện
// tại là X, bạn có muốn đổi không?") instead of dumping a form. Setting a
// value still goes through the owning tool (logtime action=setup,
// export_report action=configure) — this tool only reports state, it
// doesn't write anything itself.

import { loadConfig } from "./lib/store.js";

export function hrConfigStatus() {
  const cfg = loadConfig();
  const sections = [
    {
      name: "Ticket log time cá nhân",
      current: cfg.hr?.autoLogIssue || null,
      how: 'logtime(action="setup", issueKey="<TICKET>")',
    },
    {
      name: "Comment mặc định khi log time",
      current: cfg.hr?.autoLogComment || null,
      how: 'logtime(action="setup", comment="<nội dung>") — không cần truyền lại issueKey nếu chỉ đổi comment',
    },
    {
      // Stored as a bare Drive file id — shown back as a real, clickable
      // link (not the raw id) so HR can actually open and check it
      // without having to hand-construct a URL themselves. Input still
      // accepts a pasted link either way (export_report.js's
      // `extractDriveId` already parses a full URL back down to the id).
      name: "Template Google Sheet cho company report",
      current: cfg.companyTimesheet?.templateFileId
        ? `https://docs.google.com/spreadsheets/d/${cfg.companyTimesheet.templateFileId}/edit`
        : null,
      how: 'export_report(action="configure", templateUrl="<link>") — không cần truyền lại folderUrl nếu chỉ đổi template',
    },
    {
      name: "Folder Drive cho company report",
      current: cfg.companyTimesheet?.driveFolderId
        ? `https://drive.google.com/drive/folders/${cfg.companyTimesheet.driveFolderId}`
        : null,
      how: 'export_report(action="configure", folderUrl="<link>") — không cần truyền lại templateUrl nếu chỉ đổi folder',
    },
  ];

  const lines = [`## Cấu hình HR Skill`, ``];
  sections.forEach((s, i) => {
    const isLink = s.current?.startsWith("http");
    const shown = s.current ? (isLink ? s.current : `\`${s.current}\``) : "_(chưa cấu hình)_";
    lines.push(`${i + 1}. **${s.name}**: ${shown}`);
  });
  lines.push(``, `---`);
  lines.push(`Đi qua từng mục theo thứ tự trên. Với mỗi mục: nói giá trị hiện tại (hoặc "chưa cấu hình"), hỏi HR có muốn đổi không.`);
  lines.push(`Nếu có → hỏi giá trị mới → gọi đúng tool tương ứng (ghi ở trên) → xác nhận đã lưu → hỏi tiếp mục kế.`);
  lines.push(`Nếu không → qua mục kế ngay, không hỏi lại.`);
  lines.push(`Sau khi xong hết 4 mục thì dừng, không tự lặp lại từ đầu.`);
  return lines.join("\n");
}
