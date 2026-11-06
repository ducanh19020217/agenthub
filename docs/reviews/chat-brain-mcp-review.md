# Báo cáo rà soát chat / brain / MCP

Phạm vi: toàn bộ `src/chat/*.ts`, `src/brain/*.ts`, `src/mcp/*.ts`. Đây là review tĩnh; không sửa mã nguồn.

## Vấn đề chức năng và kiến trúc

### 1. Persistent stream không xử lý record JSON cuối khi process đóng — Cao

- **Vị trí:** `src/chat/service.ts:2188-2196`, `src/chat/service.ts:2407-2435`.
- **Mô tả:** `StreamChunkParser.feed()` giữ record chưa có ký tự newline trong `buffer`. Handler của process persistent xử lý `result` ngay khi đọc được dòng hoàn chỉnh, nhưng `handlePersistentClose()` không gọi `proc.parser.flush()`. Vì vậy một record cuối hợp lệ bị mất khi Claude đóng stdout mà không thêm newline; lượt đang chạy bị báo “Claude process đã dừng” dù có thể đã có kết quả. Nhánh non-persistent có `parser.flush()` ở `1784`, nên hành vi giữa hai chế độ còn khác nhau.
- **Đề xuất:** gom việc xử lý event vào một hàm idempotent dùng được cả ở `data` và `close`; flush parser trước khi kết luận process thất bại, đồng thời tránh xử lý `result` hai lần.

### 2. stderr của persistent process bị tích lũy xuyên suốt mọi lượt — Cao

- **Vị trí:** `src/chat/service.ts:2179,2182,2237-2238,2413-2414`.
- **Mô tả:** `stderrOutput` được nối vô hạn và không reset sau mỗi turn. Các lượt sau đưa toàn bộ stderr lịch sử vào `recordClaudeQuota()`. Một thông báo quota cũ có thể khiến lượt hiện tại bị nhận diện hết quota; process sống lâu cũng tạo tăng trưởng bộ nhớ không có giới hạn.
- **Đề xuất:** tách stderr theo turn, reset sau khi hoàn tất lượt, giới hạn kích thước buffer và chỉ dùng phần stderr của lượt hiện tại cho quota/error reporting.

### 3. Retry khi failover sang `wait` dùng một timer dùng chung và có thể làm mất lượt — Cao

- **Vị trí:** `src/chat/service.ts:1520-1530`.
- **Mô tả:** khi nhiều turn gặp cùng trạng thái `pausedUntil`, mỗi turn bị lấy khỏi `queue` nhưng chỉ có một `delayedQueueTimer`. Timer mới hủy timer cũ, còn turn cũ không được lưu ở nơi nào khác; chỉ turn cuối được đưa lại vào queue. Đây là mất message/task âm thầm dưới tải hoặc khi quota toàn hệ thống hết.
- **Đề xuất:** dùng một hàng đợi delayed riêng cho từng turn/session, hoặc giữ các turn trong queue và chỉ schedule một timer đánh thức chung rồi drain tất cả turn đã đến hạn.

### 4. MCP project scope bị bypass qua nhiều tool — Cao

- **Vị trí:** `src/mcp/index.ts:494-522`, `1280-1401`, `1466-1502`, `1714-1723`.
- **Mô tả:** `hub_knowledge`, `hub_wait` và `hub_remote_deploy` không gọi `assertProject`/`assertTaskId`. Đặc biệt `hub_git` nếu lookup API không thành công sẽ nhận bất kỳ path tồn tại nào từ `toolArgs.project` rồi chạy `git -C` (`1490-1502`), vượt project scope và cho phép đọc repository khác. Một MCP server được tạo cho chat/brain của project vì vậy có thể truy cập hoặc tác động project ngoài phạm vi.
- **Đề xuất:** tập trung kiểm tra scope ở một lớp middleware/tool wrapper; mọi project/task/source ID phải được resolve qua allow-list của session, không có fallback path tùy ý. Với `hub_git`, canonicalize path và bắt buộc project đã đăng ký thuộc scope.

### 5. Assistant session vẫn nhìn thấy các thao tác thay đổi hạ tầng/dữ liệu — Cao

- **Vị trí:** `src/mcp/index.ts:158-165`, cùng các đăng ký tool mutation ở `583-765`, `1622-1727`.
- **Mô tả:** `assertAssistantAllowed()` chỉ chặn `hub_review`, `hub_dispatch_batch`, `hub_request_secret`. Assistant vẫn có thể gọi các tool như đồng bộ/ghi ticket, timesheet, quota, `hub_gitea_sync`, `hub_remote_deploy`, pause/resume và các thao tác khác; prompt chỉ là hướng dẫn, không phải enforcement. Điều này mâu thuẫn với vai trò “không duyệt/merge/dispatch” và mở rộng blast radius khi model bị prompt injection.
- **Đề xuất:** lập capability matrix theo `chat.kind` ở server/API, mặc định assistant chỉ được đọc, tạo/cập nhật draft và dry-run; yêu cầu xác nhận/brain cho mọi mutation ngoài danh sách cho phép. Không dựa vào prompt để thực thi quyền.

### 6. Token được đưa vào query string của SSE — Trung bình

- **Vị trí:** `src/mcp/index.ts:1353`.
- **Mô tả:** `hub_wait` tạo URL `/api/events?token=${token}`. Query string dễ xuất hiện trong access log, proxy log, tracing hoặc lịch sử debug, khác với các request thường dùng `Authorization` header.
- **Đề xuất:** dùng header `Authorization: Bearer ...` cho SSE; nếu endpoint buộc phải hỗ trợ query token thì dùng token dùng một lần, TTL ngắn và redaction bắt buộc ở mọi lớp log.

### 7. Theo dõi quyết định của brain chỉ nằm trong memory — Trung bình

- **Vị trí:** `src/brain/digest.ts:21-107`, `112-130`.
- **Mô tả:** `DecisionTracker` lưu pending decisions trong `Map` và `clear()` xóa toàn bộ. Sau daemon restart, các quyết định đang chờ và số lần reminder biến mất; câu trả lời sau đó không còn được liên kết chắc chắn với decision cũ. Đây là mất dữ liệu nghiệp vụ, không chỉ mất cache.
- **Đề xuất:** lưu decision/reminder/answer trong repository bền vững (hoặc phục hồi từ event log), dùng idempotent answer và replay pending decisions khi khởi động.

### 8. Pending event của brain không có giới hạn hoặc cơ chế coalescing đủ mạnh — Trung bình

- **Vị trí:** `src/brain/runner.ts:383-413`, `172-183`, `500-516`.
- **Mô tả:** mỗi event đánh thức đều `pending.push()`; khi brain bị quota, lỗi hoặc offline lâu, danh sách tăng không giới hạn. Việc chỉ `slice(0, 30)` lúc format làm mất phần sự kiện phía sau khỏi prompt nhưng vẫn giữ chúng trong memory, và các event lặp có thể tạo nhiều lượt retry/độ trễ.
- **Đề xuất:** đặt max queue toàn cục/per project, coalesce event theo task/type, lưu cursor hoặc durable queue, và phát incident rõ ràng khi overflow thay vì âm thầm cắt prompt.

### 9. Các đường compact non-persistent cũng bỏ qua record cuối và lỗi stream — Trung bình

- **Vị trí:** `src/chat/service.ts:1262-1295`, `1438-1483`.
- **Mô tả:** callback `close` của compact chỉ dùng dữ liệu đã được `parser.feed()`; không gọi `parser.flush()`, không đọc stderr và không kiểm tra nội dung `result` trước khi coi exit code 0 là compact thành công. Một stream bị cắt/record cuối thiếu newline có thể ghi “Đã nén ngữ cảnh” với `contextTokens=0`; fork có thể tạo session mới chỉ với fallback summary.
- **Đề xuất:** dùng chung pipeline stream với chat thường, flush trước close, xử lý `isError`, thu thập stderr/quota và chỉ ghi marker `chat.compacted` sau khi có kết quả hợp lệ.

### 10. Parser bỏ qua JSON lỗi mà không có tín hiệu chẩn đoán — Thấp

- **Vị trí:** `src/chat/parse.ts:117-127`.
- **Mô tả:** mọi dòng stdout không parse được bị bỏ qua. Đây có thể là log CLI xen vào stream, nhưng cũng có thể là protocol drift hoặc JSON bị cắt; caller không biết đã mất event tool/result nào, dẫn tới chờ timeout hoặc báo process dừng muộn.
- **Đề xuất:** đếm/ghi nhận malformed lines theo turn (giới hạn kích thước, không log secret), phát metric/event chẩn đoán và phân biệt log không phải protocol với protocol lỗi.

## Thiếu kiểm thử đáng bổ sung

- Persistent process đóng với JSON cuối không có newline; stderr quota của lượt trước không ảnh hưởng lượt sau; nhiều turn cùng `pausedUntil` không bị mất.
- MCP scoped server phải từ chối path/project/task ngoài scope cho `hub_git`, `hub_knowledge`, `hub_wait`, remote deploy và các tool mutation khác.
- Khởi động lại giữa một pending decision và quyền/answer; replay quyết định và tính idempotency.
- Compact/fork với partial stream, `result.is_error`, exit code 0 nhưng không có result hợp lệ.
