# Quy trình ticket OpenProject

AgentHub hỗ trợ một vòng đời thống nhất cho ticket OpenProject: tìm hoặc tạo ticket, gắn ticket với task AgentHub, tự động chuyển trạng thái In progress khi worker bắt đầu, nhận commit kèm mã ticket, và tự động comment kết quả cùng chuyển Resolved/Done sau khi merge/push.

## Vòng đời chuẩn

1. **Tìm ticket (chống tạo trùng):** Dùng `hub_ticket_search` tìm kiếm theo display ID (ví dụ `SIE-25`), từ khóa trong subject, trạng thái hoặc người được giao. Mặc định công cụ tìm kiếm trên toàn bộ trạng thái (cả mở lẫn đóng) để tránh tạo trùng việc cũ.
2. **Tạo ticket không cần task nháp:** Dùng `hub_ticket_create` để tạo ticket độc lập, có thể chỉ định `parent` (cho việc con) và `taskId` (để liên kết ngay với một task AgentHub đã có).
3. **Gắn ticket và nhận việc:** Khi task có `externalRef` (ví dụ `SIE-25`) chuyển sang trạng thái `running`, hub tự động chuyển ticket sang trạng thái `inProgressStatusId` trên OpenProject (nếu nguồn có cấu hình).
4. **Thực hiện và commit:** Worker tuân thủ quy ước commit của project (mẫu `[{ref}] {summary}` hoặc `defaultRef` khi task chưa có ticket), ghi báo cáo hoàn thành vào `.agenthub/DONE`.
5. **Kết thúc và ghi ngược (Writeback):** Khi task được merge và push, hub tự động trích xuất kết quả từ `.agenthub/DONE` (với task sửa bug là đủ 4 mục Lỗi / Nguyên nhân / Cách sửa / Kiểm tra; với task khác là mục Comment cho tester) để comment vào ticket, đồng thời chuyển trạng thái sang `resolvedStatusId` nếu bật `autoResolve`.

## Công cụ MCP

- `hub_ticket_search`: Tìm ticket OpenProject trong toàn bộ project của nguồn.
  - `sourceId` (bắt buộc): ID của nguồn OpenProject.
  - `query`: Mã hiển thị (vd. `SIE-25`), ID số (vd. `25`), hoặc từ khóa tìm theo subject.
  - `status`: ID số hoặc tên trạng thái (không phân biệt hoa thường, vd. `Resolved`, `In progress`). Mặc định tìm mọi trạng thái (bao gồm cả ticket đã đóng).
  - `assignee`: Lọc theo người được giao (vd. `me`).
- `hub_ticket_create`: Tạo ticket OpenProject độc lập, không sinh task nháp trong hub.
  - `sourceId` (bắt buộc): ID của nguồn OpenProject.
  - `subject` (bắt buộc): Tiêu đề ticket.
  - `description`: Mô tả markdown (nên theo cấu trúc `## Đã làm` + `## Còn lại`).
  - `parent`: ID số hoặc display ID của ticket cha.
  - `status`: ID số hoặc tên trạng thái ban đầu.
  - `type`: ID loại ticket (vd. Bug, Task, Feature).
  - `assigneeMe`: Giao cho tài khoản hiện tại (mặc định `true`).
  - `taskId`: Tùy chọn ID task AgentHub để liên kết ngay lập tức.
- `hub_ticket_get`: Đọc thông tin chi tiết một ticket (subject, status, parent, assignee, url).
- `hub_ticket_update`: Cập nhật trạng thái, ticket cha hoặc thêm comment cho ticket.
- `hub_create_task`: Tạo task mới trong AgentHub.
  - Có thể truyền `externalRef: "SIE-25"` để nhận ticket có sẵn.
  - Có hỗ trợ tham số `createTicket: { sourceId }` để tạo đồng thời cả task và ticket OpenProject (kể cả khi client MCP lưu schema cũ chưa hiện tham số này trong giao diện).

API key luôn được lưu trong kho bí mật của AgentHub (`~/.agenthub/secrets/openproject-<sourceId>.key`) và không bao giờ xuất hiện trong log hoặc response API/MCP.

## Cấu hình nguồn và Project

### 1. Cấu hình nguồn OpenProject (`integrations.openproject.sources`)

Cấu hình nguồn có thể cập nhật qua API `PUT /api/integrations/openproject/sources/:id` hoặc file cấu hình:

```json
{
  "id": "openproject-1793763696242",
  "url": "https://op.cytech.ai",
  "project": "sie",
  "inProgressStatusId": 94,
  "resolvedStatusId": 95,
  "autoResolve": true,
  "createTypeId": 1,
  "createStatusId": 1
}
```

- `inProgressStatusId`: ID trạng thái khi bắt đầu làm việc (vd. `94` cho `UNREVIEWED` hoặc `In progress`). Nếu bỏ trống (`null`), hub không tự đổi trạng thái khi task bắt đầu.
- `resolvedStatusId`: ID trạng thái khi hoàn tất và đẩy mã nguồn (vd. `95` cho `Resolved`).
- `autoResolve`: Tự động chuyển ticket sang `resolvedStatusId` sau khi merge và push thành công.

### 2. Cấu hình Project AgentHub (`settings`)

Mỗi project trong AgentHub gắn với nguồn OpenProject và quy ước commit:

```json
{
  "openproject": {
    "enabled": true,
    "sourceId": "openproject-1793763696242",
    "role": "primary"
  },
  "commitConvention": {
    "defaultRef": "SIE-19",
    "commitTemplate": "[{ref}] {summary}",
    "branchTemplate": "agenthub/{slug}",
    "mergeMessageTemplate": "Merge branch '{branch}' into {target}"
  }
}
```

- `openproject.enabled`: Bật tích hợp OpenProject cho project. Khi bật, cả worker và brain đều tự động nhận quy định ticket dùng chung.
- `commitConvention.defaultRef`: Mã ticket mặc định sử dụng cho các task không gắn ticket riêng (ví dụ `SIE-19`).
- `commitConvention.commitTemplate`: Mẫu commit dòng đầu, ví dụ `[{ref}] {summary}`. Thân commit bắt buộc có mô tả chi tiết.

## Quy định dùng chung cho Worker và Brain

Khi project bật OpenProject (hoặc task có `externalRef`), AgentHub tự động chèn các quy tắc sau vào prompt của worker và brain:

1. **Mỗi việc một ticket:** Không tạo ticket "tổng hợp". Các việc cùng chủ đề phải tạo thành việc con (`parent`) của ticket đã có.
2. **Nội dung ticket:** Gồm 2 mục chính `## Đã làm` và `## Còn lại` (checklist), viết bằng tiếng Việt, tuyệt đối không chứa thông tin nhạy cảm/secret.
3. **Trạng thái:** Xong hoàn toàn → Resolved / Done; còn bước tiếp theo → In progress.
4. **Commit:** Dòng đầu theo định dạng `[{ref}] Tên việc`. Thân commit bắt buộc có mô tả chi tiết thay đổi và kết quả kiểm tra. Task không có ticket dùng mã mặc định của project.
5. **Báo cáo sửa lỗi (Bug):**
   - Phải xác minh lỗi thật trước khi sửa. Nếu không phải lỗi thật, tạo `.agenthub/BLOCKED` nêu rõ lý do.
   - Khi sửa lỗi thật, file `.agenthub/DONE` bắt buộc có 4 mục:
     - `### Lỗi`: Hiện tượng lỗi quan sát hoặc tái hiện được.
     - `### Nguyên nhân`: Nguyên nhân gốc rễ, chỉ rõ file:dòng cụ thể.
     - `### Cách sửa`: Giải pháp kỹ thuật, commit hash, hình ảnh minh họa (nếu có UI).
     - `### Kiểm tra`: Các bước và kết quả kiểm thử xác nhận lỗi đã hết.
   - Hub tự động trích xuất 4 mục này để comment trực tiếp vào ticket OpenProject khi hoàn tất.

## Ví dụ một vòng đầy đủ với dự án SIE

1. **Kiểm tra ticket:**
   Gọi `hub_ticket_search` với `sourceId: "openproject-1793763696242"`, `query: "SIE-25"`.
   Hệ thống tìm thấy ticket ID 25, displayId `SIE-25`.
2. **Nếu chưa có ticket (tạo mới):**
   Gọi `hub_ticket_create` với:
   - `sourceId: "openproject-1793763696242"`
   - `subject: "Sửa lỗi crash khi mở trang báo cáo"`
   - `description: "## Đã làm\n- Chưa bắt đầu\n\n## Còn lại\n- [ ] Xác minh lỗi\n- [ ] Sửa code\n- [ ] Viết unit test"`
   - `parent`: mã ticket cha nếu là việc con.
3. **Tạo task AgentHub:**
   Gọi `hub_create_task` với `project: "siem-fe-28"`, `slug: "fix-report-crash"`, `externalRef: "SIE-25"`, `start: true`.
4. **Nhận việc:**
   Khi task bắt đầu chạy (`running`), hub gửi PATCH lên OpenProject chuyển ticket SIE-25 sang trạng thái `94` (`inProgressStatusId`).
5. **Worker thực hiện:**
   Worker nhận được chỉ dẫn quy trình ticket, commit với message `[SIE-25] fix: prevent crash on empty report data` kèm thân commit chi tiết.
   Khi xong, worker tạo `.agenthub/DONE` chứa đủ 4 mục `### Lỗi`, `### Nguyên nhân`, `### Cách sửa`, `### Kiểm tra`.
6. **Hoàn tất và ghi ngược:**
   Task được merge và push lên remote. Hub tự động trích xuất 4 mục trong `.agenthub/DONE`, comment vào ticket SIE-25 dưới dạng:
   ```markdown
   **[AgentHub] Đã sửa**
   ### [SIE-25] Sửa lỗi crash khi mở trang báo cáo
   #### Lỗi
   Crash ứng dụng khi mở trang báo cáo rỗng.
   #### Nguyên nhân
   src/pages/Report.tsx:58 truy cập thuộc tính trên mảng rỗng.
   #### Cách sửa
   Thêm kiểm tra optional chaining và fallback data tại commit a1b2c3d.
   #### Kiểm tra
   Chạy npm test pass 15/15, kiểm tra giao diện không còn lỗi.
   ```
   Đồng thời, hub chuyển trạng thái ticket sang `95` (`resolvedStatusId`).
