# Báo cáo Rà soát Mã nguồn: API, Profiles, Projects, Claude-Sessions, Tools, Platform

> Ngày rà soát: 2026-11-06  
> Phạm vi: `src/api/*.ts`, `src/platform/*.ts`, `src/profiles/*.ts`, `src/projects/*.ts`, `src/claude-sessions/*.ts`, `src/tools/*.ts`  
> Nhánh: `agenthub/review-api-profiles-projects`  
> Mục tiêu: Phát hiện các vấn đề bảo mật, kiến trúc, race condition, input validation, phân trang, error handling, và test coverage thực tế.
>
> Tổng cộng: **24 phát hiện** (SEC-01–07, ARC-01–05, PRF-01–08, REL-01–02, CON-01, TST-01).

---

## 1. Bảng Tổng Hợp Vấn Đề

| ID | Vị trí (`file:dòng`) | Vấn đề | Ưu tiên | Phân loại |
|---|---|---|---|---|
| **SEC-01** | `src/api/server.ts:184-189` | XSS qua `${request.label}` và lỗi xác thực 401 khi submit secret form tại `/secrets/:id` | **Cao** | Bảo mật / Auth / XSS |
| **SEC-02** | `src/api/server.ts:168-180` | Lỗ hổng đọc file tuỳ ý (Arbitrary File Read) qua tham số `body.file` tại `/api/setup/import` | **Cao** | Bảo mật / Path Traversal |
| **SEC-03** | `src/projects/settings.ts:14-21`<br>`src/projects/knowledge-context.ts:19-29` | Đọc và inject file nhạy cảm tùy ý vào context qua `references.path` | **Cao** | Bảo mật / Data Leak |
| **SEC-04** | `src/api/server.ts:159-161`<br>`src/setup-tools.ts:218-239` | `POST /api/setup/config-set` cho phép gán `brain.permissions: full` mà không yêu cầu `confirm: true` | **Cao** | Bảo mật / Authorization Bypass |
| **SEC-05** | `src/profiles/index.ts:276` | Thiếu phân quyền `0700` khi tạo thư mục isolated home cho hồ sơ Antigravity | **Cao** | Bảo mật / File Permissions |
| **ARC-01** | `src/tools/setup.ts:155-162`<br>`src/profiles/agyToken.ts:137-144`<br>`src/profiles/codexToken.ts:82-88` | Ghi đè file cấu hình và credential không nguyên tử (nguy cơ 0-byte file khi crash/mất điện) | **Cao** | Kiến trúc / Tính toàn vẹn dữ liệu |
| **ARC-02** | `src/claude-sessions/scanner.ts:79` | Quét nhầm và rò rỉ transcript của các dự án ngoài phạm vi do kiểm tra tiền tố lỏng lẻo (`startsWith`) | **Cao** | Kiến trúc / Bảo mật dữ liệu |
| **PRF-01** | `src/services/index.ts:3837-3849`<br>`src/claude-sessions/scanner.ts:412-438` | Quét `/proc` N+1 và N+1 database queries gây nghẽn Event Loop trong `listClaudeSessions` | **Cao** | Hiệu năng / Event Loop Blocking |
| **PRF-08** | `src/api/server.ts:818-823`<br>`src/services/index.ts:1219-1221` | API liệt kê Claude sessions không có `limit` sẽ tải và decorate toàn bộ session, gây cạn kiệt tài nguyên | **Trung bình** | Hiệu năng / Resource Exhaustion |
| **PRF-02** | `src/api/sse.ts:38`<br>`src/db/index.ts:1680-1684` | Query `eventRepo.getSince()` không có `LIMIT` gây tràn RAM (OOM) khi client reconnect với `Last-Event-ID` | **Cao** | Hiệu năng / Resource Exhaustion |
| **ARC-03** | `src/claude-sessions/scanner.ts:114-118` | Lệch byte offset trong `ClaudeSessionScanner` khi gặp file transcript kết thúc bằng CRLF (`\r\n`) | **Trung bình** | Độ tin cậy / Data Corruption |
| **ARC-04** | `src/claude-sessions/repo.ts:16-21` | Phân trang con trỏ (Cursor Pagination) bị so sánh từ điển thay vì số học trên các cột `messages`, `effectiveTokens` | **Trung bình** | Chức năng / Pagination |
| **PRF-03** | `src/api/sse.ts:73-83, 104-167` | Trộn lẫn fake event ID và polling đọc file đĩa đồng bộ mỗi giây cho từng kết nối SSE | **Trung bình** | Kiến trúc / Hiệu năng |
| **SEC-06** | `src/projects/integration.ts:198-201, 226, 258` | Thiếu kiểm tra `baseRef` chống Command/Option Injection khi tạo integration worktree | **Trung bình** | Bảo mật / Command Injection |
| **ARC-05** | `src/platform/linux.ts:85`<br>`src/platform/darwin.ts:131` | Không escape ký tự đặc biệt / khoảng trắng trong template sinh file systemd unit và launchd plist | **Trung bình** | Độ tin cậy / Tương thích nền tảng |
| **PRF-04** | `src/platform/linux.ts:23-28` | Đọc lặp lại file `/proc/uptime` và `/proc/stat` hàng trăm lần trong vòng lặp `listProcesses` | **Trung bình** | Hiệu năng / Syscall Overhead |
| **REL-01** | `src/platform/darwin.ts:9-18, 58-85` | Thiếu timeout trong các lệnh đồng bộ trên macOS (`execFileSync`), nguy cơ treo cứng daemon khi `lsof` kẹt | **Trung bình** | Độ tin cậy / Process Hang |
| **CON-01** | `src/profiles/locks.ts:132, 148` | Cache trạng thái slot profile 3.000ms có thể gây lệch trạng thái giữa scheduler và lockfile thực tế | **Trung bình** | Race Condition / Concurrency |
| **PRF-05** | `src/claude-sessions/scanner.ts:380-389` | Cấp phát `Buffer.allocUnsafe(end)` toàn bộ dung lượng file khi đếm dòng cho transcript lớn | **Trung bình** | Hiệu năng / Memory Spike |
| **PRF-06** | `src/claude-sessions/attribution.ts:3-26` | Nguy cơ tràn stack do đệ quy không giới hạn và biên dịch regex lặp lại trong `taskRefsFromToolInput` | **Trung bình** | Hiệu năng / ReDoS / Stack Overflow |
| **PRF-07** | `src/projects/inspect.ts:77-96` | `readClaudeSessionExcerpt` đọc toàn bộ file transcript dung lượng lớn vào RAM trước khi cắt ngắn 96KB | **Trung bình** | Hiệu năng / Memory Spike |
| **REL-02** | `src/projects/git.ts:19, 42` | `execFileAsync` dùng `maxBuffer: 1MB` gây sập `inspectGitProject` nếu repo có danh sách file dirty lớn | **Trung bình** | Độ tin cậy / Unhandled Error |
| **SEC-07** | `src/api/server.ts:121-124`<br>`src/api/pty.ts:477-480` | Lộ thông báo lỗi nội bộ chi tiết (stack trace/file system path) qua response lỗi HTTP 500 | **Thấp** | Bảo mật / Info Leak |
| **TST-01** | `test/` (toàn bộ) | Thiếu test tự động cho các luồng then chốt (CRLF transcripts, macOS process check, concurrent updates) | **Trung bình** | Kiểm thử / Test Coverage |

---

## 2. Chi Tiết Từng Vấn Đề & Đề Xuất Cải Tiến

### SEC-01: XSS qua `${request.label}` và lỗi xác thực 401 khi submit secret form tại `/secrets/:id`
- **Vị trí:** `src/api/server.ts:184-189`
- **Mức độ ưu tiên:** **Cao (High)**
- **Mô tả:**
  1. Route `GET /secrets/:id` phục vụ một trang HTML standalone không qua kiểm tra Bearer token. Giá trị `request.label` được chèn trực tiếp dạng `${String(request.label)}` vào thẻ `<h1>`. Do `SetupSecretRequestSchema` chỉ kiểm tra độ dài chuỗi mà không sanitize HTML, kẻ tấn công có thể tạo secret request có nhãn chứa thẻ `<script>` hoặc mã HTML độc hại, dẫn tới thực thi mã JavaScript tùy ý trong origin của AgentHub (`Stored XSS`).
  2. Đoạn mã inline script trong form thực hiện:
     ```js
     fetch('/api/secrets/requests/${encodeURIComponent(id)}/value', {
       method: 'POST',
       headers: {'Content-Type': 'application/json'},
       body: JSON.stringify({value})
     });
     ```
     Mọi endpoint dưới `/api/` đều bị chặn bởi preHandler hook yêu cầu Bearer token. Vì form này mở trực tiếp từ trình duyệt mà không mang theo Bearer token trong header, lệnh fetch luôn nhận `401 Unauthorized`. Người dùng không thể nhập bí mật qua giao diện này.
- **Đề xuất cải tiến:**
  1. Escape HTML cho `request.label` trước khi render hoặc dùng `textContent` trong client script.
  2. Tạo token dùng một lần (`submissionToken`) lưu cùng `secret_requests` và truyền qua query param hoặc cho phép endpoint `POST /api/secrets/requests/:id/value` chấp nhận token đó để xác thực việc gửi bí mật từ trình duyệt.

---

### SEC-02: Lỗ hổng đọc file tuỳ ý (Arbitrary File Read) qua tham số `body.file` tại `/api/setup/import`
- **Vị trí:** `src/api/server.ts:168-180`
- **Mức độ ưu tiên:** **Cao (High)**
- **Mô tả:**
  Endpoint `POST /api/setup/import` nhận trực tiếp đường dẫn file từ client:
  ```ts
  const filePath = path.resolve(body.file);
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error(...);
  const imported = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
  ```
  Không hề có kiểm tra giới hạn thư mục (path traversal restriction). Bất kỳ file nào trên host mà daemon có quyền đọc (dung lượng dưới 2MB) đều có thể bị đọc. Nếu file không phải JSON hợp lệ (ví dụ `/etc/shadow`, `~/.ssh/id_rsa`), thông báo lỗi trả về trong HTTP 400 phản ánh nội dung lỗi parse của Node.js (vạch trần một phần nội dung file). Nếu là JSON hợp lệ (ví dụ token file của Claude hay agy), nó sẽ được đưa vào xử lý trong `importSetup`.
- **Đề xuất cải tiến:**
  1. Chỉ cho phép nhập dữ liệu JSON trực tiếp qua request body (`payload: object`) thay vì truyền đường dẫn file trên server.
  2. Nếu bắt buộc phải đọc từ file, chỉ cho phép đường dẫn nằm trong `config.hubHome` và kiểm tra bằng `path.relative` chống vượt cấp thư mục (`..`).

---

### SEC-03: Đọc và inject file nhạy cảm tùy ý vào context qua `references.path`
- **Vị trí:** `src/projects/settings.ts:14-21`, `src/projects/knowledge-context.ts:19-29`
- **Mức độ ưu tiên:** **Cao (High)**
- **Mô tả:**
  `ReferenceSchema` cho phép thiết lập `path` là chuỗi bất kỳ (`z.string().min(1)`). Khi `inject: true`, hàm `readReference()` thực hiện đọc trực tiếp:
  ```ts
  const referencePath = projectPath && !path.isAbsolute(reference.path) ? path.resolve(projectPath, reference.path) : reference.path;
  return { content: fs.readFileSync(referencePath, 'utf8'), size: stat.size };
  ```
  Nếu cấu hình project thiết lập `references: [{ name: "key", path: "/home/user/.ssh/id_rsa", inject: true }]`, toàn bộ nội dung file nhạy cảm trên máy sẽ được nạp vào context của project, đưa vào prompt của AI agent và hiển thị trên API.
- **Đề xuất cải tiến:**
  1. Bổ sung danh sách đen (blacklist) ngăn chặn trỏ vào các thư mục hệ thống và credential cá nhân (`~/.ssh`, `~/.agenthub/token`, `~/.gemini`, `~/.claude`, `/etc`, etc.).
  2. Đối với các file có `inject: true`, bắt buộc `path` phải là đường dẫn tương đối an toàn bên trong `project.path` (dùng `isSafeProjectRelativePath`) hoặc nằm trong thư mục tài liệu được phê duyệt.

---

### SEC-04: Bỏ qua yêu cầu `confirm: true` khi gán quyền `permissions: full` qua API setup config-set
- **Vị trí:** `src/api/server.ts:159-161`, `src/setup-tools.ts:218-239`
- **Mức độ ưu tiên:** **Cao (High)**
- **Mô tả:**
  Cơ chế bảo vệ tại `PATCH /api/projects/:id` và `PUT /api/config` yêu cầu `confirm: true` khi nâng quyền bộ não lên `full` (cho phép Claude chạy mọi lệnh bash không cần hỏi). Tuy nhiên `POST /api/setup/config-set` nhận `path` và `value` tùy ý trong danh sách cho phép, rồi gọi `service.updateConfig(root)` mà không nhận hoặc kiểm tra cờ `confirm`. Vì vậy client có thể gửi `path: "brain.permissions", value: "full", dryRun: false` để bypass xác nhận.
  Preset `auto` hiện đặt `brain.permissions: 'trusted'`, không phải `full`, nên không phải nguyên nhân của bypass này.
- **Đề xuất cải tiến:**
  Thêm `confirm: true` vào schema/request của `config-set` khi path là `brain.permissions` và value là `full`, đồng thời chuyển validation xuống tầng service (`updateConfig`) để mọi API gọi vào đều bị chặn nếu thiếu xác nhận rõ ràng từ người dùng.

---

### SEC-05: Thiếu phân quyền `0700` khi tạo thư mục isolated home cho hồ sơ Antigravity
- **Vị trí:** `src/profiles/index.ts:276`
- **Mức độ ưu tiên:** **Cao (High)**
- **Mô tả:**
  Trong `ProfileService.createProfile()`:
  - Với Claude: `fs.mkdirSync(homeDir, { recursive: true, mode: 0o700 })`
  - Với Codex: `fs.mkdirSync(homeDir, { recursive: true, mode: 0o700 })`
  - Với Antigravity: `fs.mkdirSync(homeDir, { recursive: true })` (thiếu `mode: 0o700`).
  Hơn nữa, `mkdirSync` trong Node.js vẫn chịu ảnh hưởng của `umask` tiến trình. Nếu umask là `0022`, thư mục `~/.agy-homes/<tên>/` sẽ có quyền `0755`, khiến các user khác trên cùng máy đọc được token OAuth, log chứa email và lịch sử hoạt động.
- **Đề xuất cải tiến:**
  Thêm `mode: 0o700` và gọi tường minh `fs.chmodSync(homeDir, 0o700)` cho mọi thư mục home của profile (cả agy, claude, codex) để không phụ thuộc vào umask.

---

### ARC-01: Ghi đè file cấu hình và credential không nguyên tử
- **Vị trí:** `src/tools/setup.ts:155-162`, `src/profiles/agyToken.ts:137-144`, `src/profiles/codexToken.ts:82-88`
- **Mức độ ưu tiên:** **Cao (High)**
- **Mô tả:**
  Như đã ghi nhận trong `PLAN.md` 2.4, việc crash hoặc mất nguồn đột ngột khi tiến trình đang ghi dở file có thể để lại file rỗng (0 bytes). Các file tối quan trọng như `config.json` (`SetupManager.complete`), `antigravity-oauth-token` (`writeAgyIsolatedToken`) và `auth.json` (`writeCodexAuthFile`) hiện đều dùng trực tiếp `fs.writeFileSync(file, ...)` ghi đè thẳng lên file đang có. Nếu xảy ra ngắt nguồn hoặc kill tiến trình giữa chừng, toàn bộ cấu hình hoặc phiên đăng nhập của tài khoản sẽ bị mất và hỏng file vĩnh viễn.
- **Đề xuất cải tiến:**
  Áp dụng quy chuẩn ghi nguyên tử: ghi nội dung ra file tạm cùng thư mục (ví dụ `<file>.tmp.<pid>`), flush/close rồi dùng `fs.renameSync` để thay thế nguyên tử.

---

### ARC-02: Quét nhầm và rò rỉ transcript của các dự án ngoài phạm vi
- **Vị trí:** `src/claude-sessions/scanner.ts:79`
- **Mức độ ưu tiên:** **Cao (High)**
- **Mô tả:**
  Điều kiện cho phép quét thư mục dự án Claude Code:
  `const dirAllowed = (name: string) => encodedRoots.some((root) => name === root || name.startsWith(`${root}-`));`
  Giả sử AgentHub quản lý dự án `/home/user/proj` (encoded thành `-home-user-proj`). Nếu trên máy có một dự án hoàn toàn riêng biệt khác là `/home/user/proj-secret`, Claude Code sẽ lưu transcript trong `-home-user-proj-secret`.
  Do có nhánh `name.startsWith(`${root}-`)`, scanner sẽ tự động đọc cả các file transcript của `proj-secret`, phân tích và lưu toàn bộ nội dung trao đổi, model, turn data vào cơ sở dữ liệu AgentHub.
- **Đề xuất cải tiến:**
  Bỏ điều kiện `startsWith(`${root}-`)`. Chỉ cho phép `name === root` (hoặc kiểm tra chính xác các subpath/worktree đã đăng ký hợp lệ).

---

### PRF-01: Quét `/proc` N+1 và N+1 database queries gây nghẽn Event Loop trong `listClaudeSessions`
- **Vị trí:** `src/services/index.ts:3837-3849`, `src/claude-sessions/scanner.ts:412-438`
- **Mức độ ưu tiên:** **Cao (High)**
- **Mô tả:**
  Khi người dùng xem danh sách Claude sessions (`GET /api/claude/sessions`):
  Hàm `decorateClaudeSessions` duyệt qua từng session trong danh sách (có thể lên tới hàng chục, hàng trăm session) và thực hiện:
  1. `isClaudeProcessOpen(session.cwd)`: hàm này đọc toàn bộ thư mục `/proc`, mở `/cmdline` và `readlink` của `/cwd` cho TỪNG tiến trình đang chạy trên toàn hệ điều hành. 50 sessions = 50 lần quét toàn bộ `/proc`.
  2. `this.claudeSessionRepo.topTasks(session.sessionId)`: mỗi session thực hiện một truy vấn SQL độc lập (N+1 query problem).
  Tất cả diễn ra đồng bộ trên main thread, khiến daemon bị đơ và không thể xử lý bất kỳ request nào khác trong suốt thời gian này.
- **Đề xuất cải tiến:**
  1. Quét danh sách các tiến trình Claude đang chạy một lần duy nhất (`collectRunningClaudeCwds()`), đưa vào một `Set<string>` rồi kiểm tra O(1) cho từng session.
  2. Tối ưu gom nhóm truy vấn `topTasks` thành 1 query duy nhất dạng `IN (...)` hoặc join trực tiếp trong câu query chính.

---

### PRF-08: API Claude sessions không giới hạn phân trang mặc định
- **Vị trí:** `src/api/server.ts:818-823`, `src/services/index.ts:1219-1221`
- **Mức độ ưu tiên:** **Trung bình (P2 / Medium)**
- **Mô tả:**
  `GET /api/claude/sessions` gọi `service.listClaudeSessions(activeWithinMin)` khi query không có `limit`. Hàm này gọi `claudeSessionRepo.list()` để tải toàn bộ sessions rồi `decorateClaudeSessions()` xử lý từng bản ghi (kiểm tra process và truy vấn `topTasks`). Một client có thể bỏ qua `limit` hoặc gửi request lặp lại để buộc daemon đọc và xử lý toàn bộ lịch sử sessions, khiến thời gian phản hồi, I/O và bộ nhớ tăng theo dữ liệu tích lũy.
- **Đề xuất cải tiến:**
  Luôn áp dụng phân trang có giới hạn mặc định (ví dụ `limit=20`, tối đa 100), kể cả khi client không truyền `limit`; chỉ trả về tổng số/cursor cần thiết và tránh decorate các bản ghi ngoài trang hiện tại.

---

### PRF-02: Query `eventRepo.getSince()` không có `LIMIT` gây tràn RAM khi SSE reconnect
- **Vị trí:** `src/api/sse.ts:38`, `src/db/index.ts:1680-1684`
- **Mức độ ưu tiên:** **Cao (High)**
- **Mô tả:**
  Khi client kết nối SSE gửi header `Last-Event-ID: <id>`, code gọi:
  `const missedEvents = service.eventRepo.getSince(parsedLastId).slice(0, 200);`
  Tuy nhiên, trong `src/db/index.ts`:
  `getSince(afterId) { return this.db.prepare('SELECT * FROM events WHERE id > ? ORDER BY id').all(afterId); }`
  Câu lệnh SQL không có mệnh đề `LIMIT`. Nếu database đã chạy lâu và có 100.000 sự kiện, khi client gửi `Last-Event-ID: 1`, SQLite sẽ load toàn bộ 100.000 dòng vào bộ nhớ của Node process trước khi `slice(0, 200)` được gọi. Điều này có thể dẫn tới spike RAM đột ngột hoặc sập process do OOM.
- **Đề xuất cải tiến:**
  Thêm tham số `limit` trực tiếp vào câu lệnh SQL: `SELECT * FROM events WHERE id > ? ORDER BY id LIMIT ?` (mặc định 200).

---

### ARC-03: Lệch byte offset trong `ClaudeSessionScanner` khi gặp file transcript kết thúc bằng CRLF (`\r\n`)
- **Vị trí:** `src/claude-sessions/scanner.ts:114-118`
- **Mức độ ưu tiên:** **Trung bình (Medium)**
- **Mô tả:**
  `ClaudeSessionScanner` đọc từng dòng bằng `readline.createInterface`:
  ```ts
  const raw = line as string;
  const bytes = Buffer.byteLength(raw + '\n');
  offset += bytes;
  ```
  `readline` tự động loại bỏ ký tự `\r` cuối dòng. Do đó, nếu file transcript chứa dòng kết thúc bằng `\r\n` (CRLF), độ dài thực tế của dòng trên đĩa là `Buffer.byteLength(raw) + 2`, nhưng biến `offset` chỉ cộng thêm `Buffer.byteLength(raw) + 1`. Sau nhiều dòng, `offset` lưu vào `claude_scan_state` sẽ bị lệch lùi lại so với vị trí thật trong file. Ở lần quét sau, stream đọc từ vị trí giữa chừng một dòng, gây lỗi cú pháp JSON và hỏng khả năng cập nhật tiếp tục của session đó.
- **Đề xuất cải tiến:**
  Theo dõi vị trí đọc byte trực tiếp từ stream hoặc phát hiện CRLF để tính chính xác số byte đã đọc.

---

### ARC-04: Phân trang con trỏ (Cursor Pagination) bị so sánh từ điển thay vì số học
- **Vị trí:** `src/claude-sessions/repo.ts:16-21`
- **Mức độ ưu tiên:** **Trung bình (Medium)**
- **Mô tả:**
  Trong `ClaudeSessionRepo.page()`:
  `const where = decoded ? ` WHERE (COALESCE(${sortColumn}, '') ${comparison} ? OR (COALESCE(${sortColumn}, '') = ? AND sessionId ${comparison} ?))` : '';`
  Khi sắp xếp theo `messages` hoặc `effectiveTokens`, các cột này có kiểu số (`INTEGER`/`REAL`). Sử dụng `COALESCE(col, '')` và truyền tham số con trỏ dạng string khiến SQLite thực hiện so sánh dạng text (thứ tự bảng chữ cái). Ví dụ: `'100' < '20'` trả về `true`. Kết quả phân trang qua cursor sẽ nhảy cóc hoặc trả về sai thứ tự bản ghi.
- **Đề xuất cải tiến:**
  Xác định kiểu dữ liệu của `sortColumn`: nếu là số, dùng `COALESCE(${sortColumn}, 0)` và chuyển đổi tham số cursor sang số (`Number(decoded.value)`).

---

### PRF-03: Trộn lẫn fake event ID và polling đọc file đĩa đồng bộ mỗi giây cho từng kết nối SSE
- **Vị trí:** `src/api/sse.ts:73-83, 104-167`
- **Mức độ ưu tiên:** **Trung bình (Medium)**
- **Mô tả:**
  1. Khi nhận sự kiện bus không lưu vào DB (ephemeral), SSE handler tự động tăng `lastSentId++` để sinh ID giả gửi cho client. Nếu client reconnect dùng ID giả này, nó không khớp với ID tuần tự trong bảng `events` của SQLite.
  2. Đoạn mã stream `run.output` tạo một `setInterval(..., 1000)` riêng biệt cho mỗi client SSE, thực hiện hàng loạt `fs.statSync`, `fs.openSync`, `fs.readSync`, `fs.closeSync` đồng bộ trên đĩa. Khi có nhiều tab dashboard cùng mở, việc đọc file đồng bộ này gây lãng phí tài nguyên và làm chậm các request HTTP khác.
- **Đề xuất cải tiến:**
  1. Chỉ gán SSE `id:` cho các sự kiện persistent có trong database; các sự kiện ephemeral hoặc stream log không cần kèm `id:` để tránh làm sai lệch con trỏ khôi phục.
  2. Phát log output qua EventBus tập trung thay vì từng kết nối SSE tự đọc file định kỳ.

---

### SEC-06: Thiếu kiểm tra `baseRef` chống Command/Option Injection khi tạo integration worktree
- **Vị trí:** `src/projects/integration.ts:198-201, 226, 258`
- **Mức độ ưu tiên:** **Trung bình (Medium)**
- **Mô tả:**
  `ensureIntegrationWorktree()` kiểm tra `branch` bằng `validateIntegrationBranch()`, nhưng `baseRef` (`settings.integration.baseRef || project.defaultBranch`) không được kiểm tra tương tự. Khi chạy:
  `execFileSync('git', ['-C', project.path, 'worktree', 'add', '-b', branch, integrationPath, baseRef])`
  Nếu `baseRef` được cấu hình bắt đầu bằng dấu trừ (ví dụ `--orphan`), git sẽ phân tích nó thành flag điều khiển thay vì tên nhánh/commit ref.
- **Đề xuất cải tiến:**
  Xác thực `baseRef` không được bắt đầu bằng `-` và kiểm tra hợp lệ bằng `git check-ref-format` hoặc `git rev-parse --verify` trước khi đưa vào lệnh git.

---

### ARC-05: Không escape ký tự đặc biệt / khoảng trắng trong template sinh file systemd unit và launchd plist
- **Vị trí:** `src/platform/linux.ts:85`, `src/platform/darwin.ts:131`
- **Mức độ ưu tiên:** **Trung bình (Medium)**
- **Mô tả:**
  1. Trên Linux: `ExecStart=${opts.nodePath} ${opts.cliPath} daemon` không bọc ngoặc kép cho đường dẫn. Nếu `nodePath` hoặc `cliPath` chứa khoảng trắng (rất phổ biến khi cài nvm dưới đường dẫn có dấu cách hoặc thư mục tùy biến), systemd sẽ phân tích sai câu lệnh và service không thể khởi động.
  2. Trên macOS: Template XML plist nội suy chuỗi thô mà không escape XML. Nếu đường dẫn chứa ký tự `&` hoặc `<>`, file plist sẽ bị lỗi cú pháp XML và `launchctl` từ chối load service.
- **Đề xuất cải tiến:**
  1. Bọc đường dẫn trong dấu ngoặc kép hợp lệ của systemd unit syntax.
  2. Escape các ký tự XML cơ bản (`&amp;`, `&lt;`, `&gt;`, `&quot;`) trong `darwin.ts`.

---

### PRF-04: Đọc lặp lại file `/proc/uptime` và `/proc/stat` hàng trăm lần trong vòng lặp `listProcesses`
- **Vị trí:** `src/platform/linux.ts:23-28`
- **Mức độ ưu tiên:** **Trung bình (Medium)**
- **Mô tả:**
  Hàm `listProcesses()` lặp qua mọi tiến trình con số trong `/proc`. Ở mỗi vòng lặp, nó gọi `fs.readFileSync('/proc/uptime')` và `bootTimeMs()` (mở `/proc/stat`). Với 500-1000 tiến trình trên Linux, hàm thực hiện hơn 1.000 syscall đọc file chỉ để lấy hai giá trị hệ thống không thay đổi trong suốt quá trình chạy của hàm.
- **Đề xuất cải tiến:**
  Đọc `/proc/uptime` và `bootTimeMs()` một lần duy nhất trước khi bắt đầu vòng lặp duyệt qua các tiến trình.

---

### REL-01: Thiếu timeout trong các lệnh đồng bộ trên macOS (`src/platform/darwin.ts`)
- **Vị trí:** `src/platform/darwin.ts:9-18, 58-85`
- **Mức độ ưu tiên:** **Trung bình (Medium)**
- **Mô tả:**
  Hàm `command(args)` dùng `execFileSync` mà không truyền thuộc tính `timeout`. Trong `listProcesses()`, lệnh `lsof -a -d cwd -Fpn -p <pids>` được gọi. Trên macOS, lệnh `lsof` có thể bị block vô hạn khi một process đang tương tác với socket mạng hoặc ổ đĩa mạng bị mất kết nối. Điều này khiến toàn bộ tiến trình daemon của AgentHub bị treo.
- **Đề xuất cải tiến:**
  Luôn đặt `timeout: 5000` (hoặc timeout tương đương) trong options của `execFileSync` trong `src/platform/darwin.ts`.

---

### CON-01: Cache trạng thái Slot profile 3.000ms có thể gây lệch trạng thái giữa scheduler và lockfile
- **Vị trí:** `src/profiles/locks.ts:132, 148`
- **Mức độ ưu tiên:** **Trung bình (Medium)**
- **Mô tả:**
  `ProfileLockService` cache kết quả `ProfileSlots` trong 3 giây. Nếu một worker vừa chạy xong và giải phóng lockfile hoặc bị hủy, scheduler trong 3 giây tiếp theo có thể vẫn thấy slot đó là bận (`busy: true`) và bỏ qua việc giao việc. Ngược lại, nếu một tiến trình ngoài chiếm lock, cache có thể báo slot vẫn trống.
- **Đề xuất cải tiến:**
  Scheduler khi chuẩn bị giao task cần kiểm tra trạng thái lockfile trực tiếp (hoặc gọi `invalidate()`) thay vì dựa vào cache bộ đệm.

---

### PRF-05: Cấp phát `Buffer.allocUnsafe(end)` toàn bộ dung lượng file khi đếm dòng cho transcript lớn
- **Vị trí:** `src/claude-sessions/scanner.ts:380-389`
- **Mức độ ưu tiên:** **Trung bình (Medium)**
- **Mô tả:**
  Hàm `countNewlines(file, end)` cấp phát `Buffer.allocUnsafe(end)`. Khi transcript tích luỹ kích thước lớn (hàng chục đến hàng trăm MB), hàm sẽ xin cấp phát một mảng buffer khổng lồ trong bộ nhớ heap Node.js chỉ để đếm ký tự `\n` (`byte === 10`). Việc này gây tiêu tốn bộ nhớ đột ngột và có thể gây OOM trên máy cấu hình trung bình.
- **Đề xuất cải tiến:**
  Đọc file theo các block nhỏ (ví dụ 64KB) và đếm ký tự `\n` theo từng block thay vì nạp toàn bộ `end` bytes vào RAM cùng lúc.

---

### PRF-06: Nguy cơ tràn stack do đệ quy không giới hạn và ReDoS trong `taskRefsFromToolInput`
- **Vị trí:** `src/claude-sessions/attribution.ts:3-26`
- **Mức độ ưu tiên:** **Trung bình (Medium)**
- **Mô tả:**
  1. `collectStrings(value)` đệ quy qua mọi thuộc tính của object. Nếu đối tượng đầu vào có nhiều tầng lồng nhau sâu, hàm sẽ gây lỗi `RangeError: Maximum call stack size exceeded`.
  2. Trong `taskRefsFromToolInput`, với mỗi task trong danh sách, hàm tạo mới 4 biểu thức chính quy (RegExp) và thực thi kiểm tra trên toàn bộ văn bản đầu vào. Với hàng trăm task và nhiều khối tool input lớn, việc này tiêu tốn lượng lớn chu kỳ CPU của tiến trình daemon.
- **Đề xuất cải tiến:**
  1. Thêm giới hạn độ sâu đệ quy (ví dụ tối đa 5 cấp) trong `collectStrings`.
  2. Tránh biên dịch lại RegExp lặp đi lặp lại bên trong vòng lặp; biên dịch sẵn hoặc lọc nhanh chuỗi bằng `indexOf` trước khi chạy regex.

---

### PRF-07: `readClaudeSessionExcerpt` đọc toàn bộ file transcript dung lượng lớn vào RAM trước khi cắt ngắn 96KB
- **Vị trí:** `src/projects/inspect.ts:77-96`
- **Mức độ ưu tiên:** **Trung bình (Medium)**
- **Mô tả:**
  Trong `readClaudeSessionExcerpt`:
  `const lines = fs.readFileSync(file, 'utf8').slice(0, MAX_CONTEXT_BYTES).split('\n');`
  Hàm đọc toàn bộ file `file` vào bộ nhớ trước khi gọi `.slice(0, MAX_CONTEXT_BYTES)`. Khi kiểm tra dự án có 20-30 session files lớn (50-100MB mỗi file), việc gọi đồng bộ này sẽ đọc hàng gigabyte dữ liệu vào RAM chỉ để lấy 96KB đầu tiên, làm đơ API `/api/projects/inspect`.
- **Đề xuất cải tiến:**
  Dùng `fs.openSync` và `fs.readSync` với buffer cố định `MAX_CONTEXT_BYTES` (96KB) để chỉ đọc đúng lượng dữ liệu cần thiết từ đĩa.

---

### REL-02: `execFileAsync` dùng `maxBuffer: 1MB` gây sập `inspectGitProject` nếu repo có danh sách file dirty lớn
- **Vị trí:** `src/projects/git.ts:19, 42`
- **Mức độ ưu tiên:** **Trung bình (Medium)**
- **Mô tả:**
  Trong `git(path, args)`:
  `execFileAsync('git', ['-C', path, ...args], { timeout: GIT_TIMEOUT_MS, maxBuffer: 1024 * 1024 })`
  Nếu một repository có nhiều file chưa commit hoặc untracked (ví dụ thư mục build/dataset chưa gitignore gồm hàng chục ngàn file), `git status --porcelain` sẽ sinh output lớn hơn 1MB. Node.js sẽ ném lỗi `maxBuffer length exceeded`, làm `inspectGitProject` thất bại hoàn toàn và API `/api/projects/:id/git` trả về lỗi HTTP 400.
- **Đề xuất cải tiến:**
  Bổ sung cờ `-uall` hoặc kiểm soát buffer đầu ra, hoặc bắt lỗi `maxBuffer` riêng để trả về trạng thái cảnh báo `dirty: { changed: true, files: 10000+ }` thay vì làm sập toàn bộ request.

---

### SEC-07: Lộ thông báo lỗi nội bộ chi tiết qua response lỗi HTTP 500
- **Vị trí:** `src/api/server.ts:121-124`, `src/api/pty.ts:477-480`
- **Mức độ ưu tiên:** **Thấp (Low)**
- **Mô tả:**
  Tại một số route handler và global error handler, khi gặp Exception không xác định, server gửi trực tiếp `error.message` về cho client. Nếu lỗi xuất phát từ filesystem hoặc driver SQLite, thông điệp có thể làm lộ đường dẫn nội bộ máy chủ, tên tài khoản, cấu trúc thư mục hoặc câu lệnh shell thất bại.
- **Đề xuất cải tiến:**
  Ghi log chi tiết lỗi tại server (kèm timestamp/trace id) và chỉ trả về thông điệp chung `internal_server_error` cho client khi mã lỗi là 500.

---

### TST-01: Thiếu Test tự động cho các luồng then chốt
- **Vị trí:** `test/`
- **Mức độ ưu tiên:** **Trung bình (Medium)**
- **Mô tả:**
  1. Chưa có test trường hợp file transcript Claude chứa ký tự CRLF (`\r\n`) để kiểm chứng byte offset không bị lệch.
  2. Chưa có test cho route `/secrets/:id` để kiểm tra khả năng submit và chống XSS.
  3. Chưa có test mô phỏng race condition khi nhiều request đồng thời gửi `PATCH /api/projects/:id` hoặc cập nhật profile.
  4. Thiếu test kiểm tra hành vi `inspectGitProject` khi output của git vượt quá `maxBuffer`.
- **Đề xuất cải tiến:**
  Bổ sung các kịch bản test tương ứng vào bộ kiểm thử Vitest hiện có.

---

## 3. Khuyến Nghị Lộ Trình Cải Tiến

1. **Giai đoạn 1 (Khẩn cấp - An ninh & Toàn vẹn dữ liệu):**
   - Khắc phục **SEC-01** (XSS & Auth form `/secrets/:id`).
   - Khắc phục **SEC-02** & **SEC-03** (Chặn Path Traversal và rò rỉ file nhạy cảm trong `/api/setup/import` và `references.path`).
   - Khắc phục **SEC-04** (Bắt buộc `confirm: true` cho `permissions: full`, bao gồm `POST /api/setup/config-set`, trên toàn bộ API).
   - Khắc phục **SEC-05** & **ARC-01** (Phân quyền `0700` cho home agy và áp dụng ghi file nguyên tử cho config & token).
   - Khắc phục **ARC-02** (Chặn quét nhầm transcript dự án ngoài phạm vi).

2. **Giai đoạn 2 (Hiệu năng & Ổn định):**
   - Khắc phục **PRF-01** & **PRF-08** (Gộp truy vấn quét `/proc`, loại bỏ N+1 query và luôn phân trang `listClaudeSessions`).
   - Khắc phục **PRF-02** & **PRF-03** (Thêm `LIMIT` cho `eventRepo.getSince()` và dọn dẹp SSE interval).
   - Khắc phục **ARC-03** & **ARC-04** (Sửa lỗi CRLF offset và sửa so sánh con trỏ kiểu số).
   - Khắc phục **PRF-04**, **PRF-05**, **PRF-07** (Tối ưu I/O đọc file bounded và loại bỏ đọc dư thừa trong `listProcesses`).

3. **Giai đoạn 3 (Bền bỉ & Hoàn thiện):**
   - Khắc phục **SEC-06**, **ARC-05**, **REL-01**, **REL-02**, **CON-01**, **SEC-07**.
   - Bổ sung test coverage theo **TST-01**.
