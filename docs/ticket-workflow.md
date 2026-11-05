# Quy trình ticket OpenProject

AgentHub hỗ trợ một vòng đời thống nhất: tìm hoặc tạo ticket, gắn ticket với việc, chuyển trạng thái khi worker bắt đầu, nhận commit và báo cáo, rồi comment kết quả và resolve sau khi merge/push.

## Công cụ MCP

- `hub_ticket_search`: tìm theo từ khóa, trạng thái hoặc người được giao trong toàn bộ project của nguồn; kết quả gồm mã, tiêu đề, trạng thái, cha, người được giao và URL.
- `hub_ticket_create`: tạo ticket độc lập, không để lại task nháp; nhận `subject`, mô tả markdown, `parent`, `status`, `type`, `assigneeMe` và tùy chọn `taskId` để liên kết task AgentHub đã có.
- `hub_ticket_get` / `hub_ticket_update`: đọc hoặc cập nhật trạng thái, ticket cha và comment.
- `hub_create_task`: tạo task AgentHub; dùng `externalRef` khi nhận ticket có sẵn. `createTicket` vẫn dành cho luồng tạo đồng thời task và ticket.

Các tool đều đi qua hub; API key chỉ được đọc từ kho bí mật của hub và không xuất hiện trong response/log.

## Cấu hình

Mỗi nguồn OpenProject cấu hình `createTypeId`, `createStatusId`, `inProgressStatusId`, `resolvedStatusId`, `reviewStatusId` và `autoResolve`. Mỗi project cấu hình nguồn qua `settings.openproject.sourceId` và quy ước commit qua `settings.commitConvention.defaultRef`, `commitTemplate`, `branchTemplate`.

Khi task có `externalRef`, worker nhận quy tắc ticket dùng chung: không tạo ticket trùng/tổng hợp, ticket cùng chủ đề là ticket con, báo cáo có `## Đã làm` và `## Còn lại`, không chứa secret. Task sửa bug phải nêu Lỗi, Nguyên nhân (file:dòng), Cách sửa (commit, image) và Kiểm tra.

## Ví dụ một vòng đầy đủ (SIE)

1. Dùng `hub_ticket_search` với `sourceId: "openproject-1793763696242"` và từ khóa `SIE-25` để kiểm tra ticket đã tồn tại.
2. Nếu chưa có, dùng `hub_ticket_create` với `subject`, mô tả `## Đã làm\n- Chưa bắt đầu\n\n## Còn lại\n- [ ] ...`, và `parent` nếu là việc con.
3. Dùng `hub_create_task` với `externalRef: "SIE-25"`; khi task chạy, hub chuyển ticket sang `inProgressStatusId`.
4. Worker commit theo `commitConvention` của project, ghi `.agenthub/DONE`, rồi task được review/merge/push.
5. Hub comment mục kết quả vào ticket và, nếu `autoResolve`, chuyển ticket sang `resolvedStatusId`.

Test tích hợp dùng fetch giả; không gọi OpenProject thật.
