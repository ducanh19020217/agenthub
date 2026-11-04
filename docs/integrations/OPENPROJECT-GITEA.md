# Tích hợp OpenProject + Gitea + Deploy từ xa

Tài liệu thiết kế chung cho nhóm task `f-op-*`, `f-gitea-*`, `f-remote-deploy`, `f-daily-report`.

Mọi tính năng **tắt mặc định** và cấu hình theo nguồn hoặc theo project. Không gắn cứng giá trị của bất kỳ dự án cụ thể nào: không có status id, tên người, prefix ticket hay lệnh build cố định trong code.

## 1. Khái niệm

- **Nguồn OpenProject (source)**: một kết nối tới một project OpenProject.
  - Cấu hình **toàn cục** trong `config.json` → `integrations.openproject.sources[]`.
  - Một nguồn có thể gắn với **nhiều** project hub (ví dụ FE + BE).
  - API key lưu ở file `<hubHome>/secrets/openproject-<sourceId>.key` (0600). Key không bao giờ nằm trong config.json, SQLite, log hay API response.
- **Project hub gắn nguồn**: settings theo project (`projects.settings.openproject`) là `{ enabled, sourceId, role: 'primary' | 'secondary' }`.
  - Mỗi nguồn có đúng một project `primary`, là nơi tạo task mặc định cho ticket.
  - Các project `secondary` nhận task liên kết khi cần sửa repo khác.
- **Ticket ↔ task**:
  - `tasks.external_ref` là displayId của ticket (ví dụ `SOAR-123`).
  - Bảng mới `tracker_items` lưu trạng thái đồng bộ theo `(source_id, wp_id)`: status đã thấy, `updated_at`, id comment cuối đã xử lý, danh sách task id liên kết, và trạng thái ghi ngược (đã comment hay đã Resolved).
- **Gitea**: settings theo project (`projects.settings.gitea`). Token lưu ở `<hubHome>/secrets/gitea-<projectId>.token`. Dùng để đồng bộ nhánh theo lịch qua PR.
- **Deploy từ xa**: settings theo project (`projects.settings.remoteDeploy`). Các bước là argv tuỳ cấu hình, kèm health check.
  - Bí mật cho các bước (ví dụ `SSHPASS`) lưu ở `<hubHome>/secrets/deploy-<projectId>.env`, dạng `KEY=VALUE`.
  - Chỉ được nạp vào env của tiến trình con, không log.

## 2. Cấu hình nguồn OpenProject (config.json)

```jsonc
"integrations": { "openproject": { "sources": [ {
  "id": "soar",                       // [a-z0-9-]+
  "url": "https://op.example.com",
  "project": "123",                   // id hoặc identifier
  "pollIntervalSec": 120,
  "watchStatusIds": [1, 100],         // ticket giao cho "me" ở các trạng thái này → tạo task
  "reopenedStatusIds": [100],         // chuyển sang các trạng thái này = REOPENED
  "createTypeId": null,                // loại mặc định khi hub tạo ticket
  "createStatusId": null,              // trạng thái mặc định khi hub tạo ticket
  "resolvedStatusId": 95,             // null = không đổi trạng thái khi xong
  "reviewStatusId": 94,               // cần quyết định → trạng thái này (null = không đổi)
  "openStatusIds": [1, 100, 7, 94],   // dùng cho báo cáo ngày
  "minTicketNumber": 0,               // chỉ tự tạo task cho số ticket >= mức này
  "autoStart": true,                  // true: task queued; false: draft
  "autoResolve": true,                // xong + đã push → comment + resolvedStatusId
  "language": "vi"                    // ngôn ngữ comment ghi ngược
} ] } }
```

## 3. OpenProject API v3 (đã kiểm chứng ở công cụ tham khảo)

- **Auth**: `Authorization: Basic base64("apikey:" + key)` và `Accept: application/hal+json`. Khi ghi thì thêm `Content-Type: application/json`.
- **Danh sách**: `GET /api/v3/projects/{project}/work_packages?filters=<json>&pageSize=100&offset=<trang, bắt đầu 1>&sortBy=[["id","asc"]]`
  - filters: `[{"assignee":{"operator":"=","values":["me"]}},{"status":{"operator":"=","values":["1","100"]}}]`
  - Dừng khi đã đủ `total` hoặc gặp trang rỗng.
- **User**: `GET /api/v3/users/me` → `id`, `name`. Tên tác giả comment lấy bằng `GET <_links.user.href>`, cache theo href.
- **Work package**: `GET /api/v3/work_packages/{id}` → `displayId`, `subject`, `description.raw`, `lockVersion`, `updatedAt`, `_links.status.{href,title}`, `priority.title`, `author.title`. Status id là đoạn cuối của href.
- **Lịch sử**: `GET /api/v3/work_packages/{id}/activities` → `_embedded.elements[]`, gồm `id`, `comment.raw`, `details[].raw`, `createdAt`, `_links.user.href`.
- **Ảnh nhúng**: tìm `<img src="/api/v3/attachments/{id}/content">` trong mô tả và comment, tải bằng `GET /api/v3/attachments/{id}/content`, rồi đổi link thành `images/{id}.<ext>`.
- **Comment**: `POST /api/v3/work_packages/{id}/activities` với body `{"comment":{"raw": "<markdown>"}}`.
- **Đổi trạng thái**: GET để lấy `lockVersion`, rồi `PATCH /api/v3/work_packages/{id}` với body `{"lockVersion":lv,"_links":{"status":{"href":"/api/v3/statuses/{sid}"}}}`. Nếu nhận 409 (lockVersion cũ) thì GET lại và thử lại, tối đa 3 lần.
- **Link ticket**: `{url}/work_packages/{id}`.

## 4. Luồng ticket → task → ghi ngược

### 4.0 Tạo task kèm ticket

API `POST /api/tasks` và MCP `hub_create_task` có thể nhận `createTicket: { sourceId? }`. Nếu không truyền `sourceId`, hub dùng nguồn OpenProject `primary` đã gắn với project của task. Tùy chọn này tắt mặc định.

Hub tạo work package trước bằng tiêu đề task và mô tả Markdown (rút gọn khi quá dài), sau đó ghi ngay một hàng `tracker_items` đang tạo trước mọi lần đọc/ghi tiếp theo; intake bỏ qua hàng này nên không thể tạo task trùng trong lúc request đang hoàn tất. Hub tiếp tục tạo task với tiêu đề `[<displayId>] <tiêu đề>` và `externalRef = <displayId>`, cập nhật `task_ids`, rồi chép `ticket.md`/ảnh vào `tracker/<sourceId>/<wpId>/`. Các đầu vào project/slug/tracker được kiểm tra trước khi gọi OpenProject; nếu OpenProject từ chối tạo ticket thì task không được tạo.

Nguồn có thêm `createTypeId` và `createStatusId` để chọn mặc định khi tạo ticket. Danh sách loại được lấy từ `GET /api/integrations/openproject/sources/:id/types`.

### 4.1 Intake

Poller chạy theo `pollIntervalSec`. Khi lỗi thì backoff, tối đa 1800s.

- **Lần đầu của một nguồn**: chỉ ghi mốc, không tạo task.
- **Phân loại sự kiện**:
  - Ticket mới xuất hiện trong danh sách theo dõi → `NEW`.
  - Ticket đổi sang một trong `reopenedStatusIds` → `REOPENED`.
  - `updatedAt` thay đổi → lấy activities; comment mới của người khác (không phải "me") → `COMMENT`.
- **`NEW`/`REOPENED`** (chỉ khi số ticket ≥ `minTicketNumber`):
  - Tải ticket về `<hubHome>/tracker/<sourceId>/<wpId>/` (`ticket.md` + `images/`).
  - Tạo task ở project primary:
    - slug: `op-<displayId thường hoá>[-r<n>]`
    - `externalRef`: displayId
    - title: `[displayId] subject`
    - body: theo mẫu ở mục 5
  - Nếu ticket đang có task chưa kết thúc thì không tạo trùng.
- **`COMMENT`** khi task đang mở: cập nhật `ticket.md` và phát event `tracker.comment` để thông báo. Không tự tạo task mới.
- Khi chuẩn bị worktree của task, hub chép thư mục ticket vào `.agenthub/context/ticket/`.

### 4.2 Quy ước cho worker

Áp dụng cho task có nguồn tracker và được ghi trong body task.

- **Xong**: `.agenthub/DONE` có mục `## Comment cho tester`, viết bằng ngôn ngữ của người dùng cuối, không có tên file hay tên hàm.
- **Cần người quyết định**: tạo `.agenthub/BLOCKED` có mục `## Cần quyết định`, liệt kê các phương án có đánh số.
- **Cần sửa repo khác**: DONE có mục `## Cần sửa ở project <projectId>` kèm mô tả. Hub tạo task liên kết ở project secondary đó, cùng `externalRef` và phụ thuộc task hiện tại.

### 4.3 Ghi ngược

- **Điều kiện xong**: ticket chỉ coi là xong khi **mọi** task liên kết đã `task.merged` **và** commit merge đã được push lên remote.
  - "Đã push" xác định qua event push thành công của DeployService hoặc Gitea sync, kiểm tra bằng `git merge-base --is-ancestor`.
  - Khi đó, nếu bật `autoResolve`: comment `**[AgentHub] Đã sửa**` kèm nội dung mục `## Comment cho tester`, rồi đổi sang `resolvedStatusId`.
  - Nếu tắt `autoResolve`: chỉ comment.
- **Cần quyết định**: task blocked có mục `## Cần quyết định` → comment `**[Cần duyệt]**` kèm nội dung mục đó, rồi đổi sang `reviewStatusId`.
  - Người dùng trả lời trên OP và chuyển ticket về New hoặc Reopened.
  - Intake tạo task `-r<n>` với toàn bộ lịch sử. Quyết định mới nhất sau comment `[Cần duyệt]` là quyết định cuối cùng.
- Mọi lần ghi ngược đều idempotent (lưu trong `tracker_items`). Lỗi mạng thì thử lại ở vòng sau.

## 5. Mẫu body task từ ticket

```
Ticket: [<displayId>] <subject> — <link>
Trạng thái: <status> · Ưu tiên: <priority> · Người tạo: <author>

Đọc toàn bộ `.agenthub/context/ticket/ticket.md` (mô tả + lịch sử comment) và ảnh trong
`.agenthub/context/ticket/images/`. Với ticket Reopened, comment mới nhất của tester là yêu cầu chính.
Nếu có comment [Cần duyệt] và sau đó có quyết định, làm đúng theo quyết định đó.

Yêu cầu: tìm nguyên nhân gốc, sửa tối thiểu, chạy build/test của repo, commit với message
`fix(<displayId>): <tóm tắt>`.
<quy ước DONE/BLOCKED ở mục 4.2>
```

## 6. Gitea: đồng bộ nhánh theo lịch

Settings project `gitea`: `{ enabled, url, sourceBranch, targetBranch, schedule: ["12:00","18:00"], weekdaysOnly, checks: string[][] (argv), unionMergeGlobs: string[] }`. owner/repo lấy từ `git remote get-url origin`.

API: base `{url}/api/v1`, header `Authorization: token <TOKEN>`.
- **Tìm PR đang mở**: `GET /repos/{o}/{r}/pulls?state=open&limit=50&page=1..5`, khớp `head.ref` và `base.ref`.
- **Tạo PR**: `POST /repos/{o}/{r}/pulls` với `{head, base, title, body}`.
- **Merge**: `POST /repos/{o}/{r}/pulls/{n}/merge` với `{"Do":"merge","delete_branch_after_merge":false}`. Thử lại 6 lần, cách nhau 10s, vì Gitea kiểm tra mergeable bất đồng bộ.

Luồng:
1. fetch. Nếu `origin/target..origin/source` không có commit non-merge nào thì bỏ qua.
2. Tạo worktree tạm detached tại `origin/source`, rồi merge `origin/target`.
3. Xử lý xung đột:
   - File khớp `unionMergeGlobs`: giữ cả hai phía.
   - Xung đột khác: huỷ merge, tạo task draft "gỡ xung đột" trong hub và thông báo.
4. Chạy `checks`.
5. Nếu có merge commit thì push source (không force).
6. Tìm hoặc tạo PR, rồi merge.

Phát event `gitea.sync.*`.

## 7. Deploy từ xa (giai đoạn 1)

Settings `remoteDeploy`: `{ enabled, trigger: 'after-gitea-sync' | 'manual', steps: string[][], healthChecks: [{ url, expectStatusBelow: 500, contains?: string }], waitMinutes: 15, timeoutSec }`.

- Các bước chạy tuần tự. Env có thêm các biến từ `secrets/deploy-<projectId>.env`.
- Health check poll mỗi 15s, tối đa `waitMinutes`.
- Event `remote_deploy.*`. Log ở `<hubHome>/logs/remote-deploy/`.

Giai đoạn 2 (chưa làm): QA tự động bằng AI trên server test.

## 8. Báo cáo ngày

Settings nằm trong nguồn OP: `dailyReport: { enabled, time: "08:00", weekdaysOnly: true, dir, maxItems: 10, telegram: boolean }`.

Định dạng:
```
Ngày: dd/mm/yyyy
1. Hôm qua đã làm gì?
- [ID] - subject
2. Hôm nay làm gì ?
- [ID] - subject
```

- **"Hôm qua"**: lấy mục "Hôm nay" của báo cáo trước. Nếu chưa có báo cáo trước thì lấy các ticket được cập nhật trong ngày làm việc trước và có hoạt động của "me".
- **"Hôm nay"**: ticket giao cho "me" ở `openStatusIds`, sắp theo `updatedAt` giảm dần, tối đa `maxItems`.
- Tên file: `bao-cao-DD-MM-YYYY.txt`.

## 9. Ràng buộc chung

- HTTP client nhận `fetch` tiêm vào (như `src/ci.ts`). Test chỉ dùng fetch giả và thư mục tạm, không gọi mạng.
- Không log và không trả về bí mật. Route ghi bí mật chỉ nhận PUT và trả `{configured: true}`.
- Event mới đặt tên `tracker.*`, `gitea.*`, `remote_deploy.*`, `daily_report.*`. Thêm case tương ứng trong `src/notify.ts` và trong handler Telegram.
- Migration chỉ thêm vào cuối `MIGRATIONS` và phải cập nhật `test/fixtures/migrations.lock`.
- Chuỗi giao diện mới phải có đủ trong `web/src/locales`.
