# Báo cáo rà soát scheduler, worktrees và engines

Phạm vi đã đọc: toàn bộ `src/scheduler/index.ts`, `src/worktrees/index.ts`,
`src/engines/index.ts` và `src/engines/claude-review.ts`. Không sửa code nguồn.

## Phát hiện

### 1. Có thể xử lý hoàn tất cùng một run nhiều lần do các vòng kiểm tra chồng nhau

- **Vị trí:** `src/scheduler/index.ts:1650-1684`, `src/scheduler/index.ts:2014-2025`
- **Mức độ:** cao
- **Mô tả:** `tick()` chỉ khóa phần đồng bộ bằng `inTick`, sau đó gọi `void this.checkRunningTasks()`; hàm này lại `await checkTaskCommits()` và chờ các completion. Vòng tick kế tiếp có thể vào `checkRunningTasks()` lần nữa trong khi vòng trước chưa xong. Hai vòng đều có thể thấy cùng PID đã chết và gọi `handleRunCompletion()` trước khi vòng nào kịp `runRepo.finish()`. Các kiểm tra stale/overlap giảm hậu quả nhưng không tạo một commit/transition nguyên tử; có thể đọc marker, dọn worktree hoặc ghi event/checks hai lần.
- **Đề xuất:** thêm mutex/promise `runningCheck` cho toàn bộ `checkRunningTasks`, hoặc đánh dấu run đang được finalize ngay khi phát hiện process chết và dùng một transaction/compare-and-set khi chuyển outcome.

### 2. Hủy task trong lúc chuẩn bị dependency không ngăn worker được spawn

- **Vị trí:** `src/scheduler/index.ts:3635-3640`, `src/scheduler/index.ts:3650-3654`, `src/scheduler/index.ts:3890-3915` (logic `cancelTask`)
- **Mức độ:** cao
- **Mô tả:** sau khi tạo worktree, task đã được ghi `status: 'running'`, rồi `startTask()` await `ensureWorktreeNodeModules()`. Trong khoảng await đó, `cancelTask()` không thấy task trong `running` (chỉ có trong `starting`) và chuyển DB sang `cancelled`. Khi await xong, `startTask()` tiếp tục tạo run, ghi lại `running` và spawn child; worker của task đã hủy không còn được theo dõi đúng cách.
- **Đề xuất:** `cancelTask()` phải xử lý `starting` và đặt cờ hủy/generation cho task; mọi điểm sau await trong `startTask()` phải kiểm tra cờ đó, rollback trạng thái/worktree/lock trước khi spawn.

### 3. Startup recovery bỏ lại run/task mồ côi khi thiếu project, engine hoặc PID

- **Vị trí:** `src/scheduler/index.ts:925-942`
- **Mức độ:** cao
- **Mô tả:** nếu run `running` có PID đã chết nhưng task/project không tồn tại, code `continue` mà không finish run. Nếu PID còn sống nhưng `task`, `engine` hoặc `run.pid` thiếu, code cũng `continue`; process có thể tiếp tục chạy ngoài `this.running`, còn DB giữ `runs.outcome = NULL` và task có thể kẹt `running` vĩnh viễn. Đây là đường crash/restart trực tiếp trái với yêu cầu phải phục hồi state sau daemon restart.
- **Đề xuất:** mọi nhánh không thể reattach phải kill process nếu còn sống, finish run với `crashed`/reason cụ thể, và nếu task còn tồn tại thì đưa về `queued` hoặc terminal phù hợp; ghi event recovery để người dùng biết.

### 4. Fallback model không hoạt động khi profile có nhưng engine binary không khả dụng

- **Vị trí:** `src/scheduler/index.ts:3313-3329`, `src/scheduler/index.ts:3567-3572`
- **Mức độ:** cao
- **Mô tả:** `findModelProfilePair()` chỉ lọc profile/quota/lock, không kiểm tra `this.engines.has(engineId)`. Vì vậy khi Codex profile tồn tại nhưng Codex CLI không được phát hiện, chain có thể chọn `codex:...`; `startTask()` chỉ log “engine not available” và return, không thử model kế tiếp cũng không chuyển task sang lý do chờ rõ ràng. Task có thể nằm queued mà không có wakeup hữu ích, hoặc fallback bị bỏ qua.
- **Đề xuất:** đưa engine availability vào hàm đánh giá candidate; bỏ qua model không có adapter để thử model tiếp theo, đồng thời phân biệt “không cài engine” với “quota/profile bận” trong wait reason/event.

### 5. Watchdog stall bypass cơ chế giới hạn crash và cooling profile

- **Vị trí:** `src/scheduler/index.ts:1882-1904`
- **Mức độ:** trung bình
- **Mô tả:** đường stall tự `runRepo.finish(..., 'crashed')` và retry tối đa theo số run có `reason === 'stalled'`, nhưng không gọi `recordWorkerCrash()`. Vì vậy `task.consecutiveCrashes`, `profile.consecutiveCrashes` và `coolingUntil` không được cập nhật; giới hạn crash/profile cooling áp dụng cho crash thông thường không áp dụng cho worker bị stall. Một profile lỗi có thể tiếp tục được chọn qua nhiều task stall.
- **Đề xuất:** dùng chung hàm ghi nhận crash với reason `stalled`, hoặc tách policy stall nhưng vẫn cập nhật counter/cooling và áp dụng `maxRunsPerTask`/`maxConsecutiveCrashesPerTask` nhất quán.

### 6. Auto-close merged tasks bỏ sót merge fast-forward

- **Vị trí:** `src/scheduler/index.ts:4511-4551`
- **Mức độ:** trung bình
- **Mô tả:** sau khi xác nhận branch là ancestor của target, code chỉ tìm các commit có `--merges`. Với việc branch được fast-forward vào target, không có merge commit để duyệt nên `hasCommits` vẫn false; task đã merge thật sẽ mắc ở `review`/`failed` và giữ worktree lâu hơn.
- **Đề xuất:** kiểm tra số commit đóng góp trước khi merge bằng quan hệ base đã lưu/task base (`rev-list --count <base>..<branch>`), hoặc xử lý riêng trường hợp fast-forward khi branch là ancestor và có commit khác base.

### 7. Chọn Codex extension bằng sort từ điển không tương đương sort phiên bản

- **Vị trí:** `src/engines/index.ts:410-416`
- **Mức độ:** thấp
- **Mô tả:** các thư mục `openai.chatgpt-*` được `entries.sort()` theo chuỗi. Khi có phiên bản dạng `...-1.10` và `...-1.9`, có thể chọn bản cũ hơn, khiến daemon dùng binary không tương thích dù bản mới đã cài. Kế hoạch hệ thống yêu cầu chọn bản cuối theo thứ tự version.
- **Đề xuất:** parse suffix semver/version và sort numeric (hoặc dùng comparator tương đương `sort -V`) trước khi chọn entry.

### 8. Giới hạn slot worktree không khớp hợp đồng `{slot}`

- **Vị trí:** `src/worktrees/index.ts:98-114`
- **Mức độ:** trung bình
- **Mô tả:** constant là `30` trong khi prompt/config contract quy định `{slot}` chỉ từ 1 đến 9. Env template có thể nhận slot hai chữ số, phá vỡ port/service naming dựa trên hợp đồng; comment trong code cũng ghi 1-9 nhưng implementation khác.
- **Đề xuất:** giới hạn allocator ở 1..9 và báo lỗi rõ khi hết slot; nếu thật sự cần 30 thì phải thay đổi contract và toàn bộ consumer cùng lúc.

### 9. Env template có thể ghi/đọc ngoài worktree

- **Vị trí:** `src/worktrees/index.ts:649-690`
- **Mức độ:** cao
- **Mô tả:** `path.join(worktreePath, envTemplate.file)` và `copyFrom` không kiểm tra path traversal hoặc symlink. Giá trị như `../../...` có thể khiến task tạo env ngoài worktree, và `copyFrom` có thể đọc file ngoài phạm vi rồi copy nội dung vào target.
- **Đề xuất:** resolve real path/containment cho cả target và source, từ chối absolute path, `..` vượt root và symlink ra ngoài; chỉ cho phép file nằm bên trong worktree.

## Fallback, quota, watchdog và state đã kiểm tra

- Cấp slot/profile trong cùng tick có reservation đồng bộ (`starting` và lock reservation); quota được mark theo profile và account cùng email; transient error có backoff 60/120/180 giây. Các cơ chế này phù hợp contract hiện tại, nhưng cần được bao phủ bởi các test race ở trên.
- Timeout và cancel thông thường có kill process group; stall cũng kill group và retry. Vấn đề là stall không đi qua counter/cooling chung (mục 5).
- Startup có xử lý run còn PID sống và marker sau crash, nhưng các nhánh thiếu dữ liệu nêu ở mục 3 làm state recovery chưa đầy đủ.
- Chuỗi review fallback đã có kiểm tra profile/quota/backoff và fallback Claude/Codex; vẫn nên hợp nhất evaluator profile/model với worker path để tránh khác biệt eligibility. Worker model chain hiện còn lỗi engine-unavailable ở mục 4.
- `parseResetTime()` xử lý giờ/phút và giờ-phút-giây, nhưng thiếu dạng chỉ có giây (`Resets in 45s`), nên rơi về mặc định 5 giờ thay vì 105 giây gồm buffer 60 giây.

## Coverage và duplicate logic

- Các suite hiện có đã bao phủ nhiều đường quota, stall, overlap completion, review fallback, cleanup và engine detection. Tuy nhiên chưa thấy test cho: hai `checkRunningTasks()` chạy chồng nhau; `cancelTask()` trong lúc `ensureWorktreeNodeModules()` đang await; recovery với task/project/engine/PID bị thiếu; fallback khi profile khớp nhưng adapter không tồn tại; stall cập nhật crash/cooling; và fast-forward auto-close.
- Eligibility của model/profile đang được tính lặp và không đồng nhất ở `findModelProfilePair()` (`3313+`), `hasBusyMatchingProfile()` (`3362+`), `allMatchingProfilesNeedLogin()` (`3382+`) và `getProfileWaitReason()` (`3397+`). Nên có một evaluator trả về candidate + lý do loại (engine, auth, quota, busy, cooling, department), rồi dùng chung cho dispatch, wait reason và fallback; điều này giảm nguy cơ một nhánh chọn model mà nhánh khác không thể chạy.

## Kiểm tra các hạng mục không phát hiện lỗi mới

- Reservation slot trong dispatch và giới hạn project/department có tính cả `starting`, nên race cấp slot cơ bản đã được xử lý.
- Quota failover của worker đọc log tail, mark profile/account và reset retry counter; transient retry có giới hạn. Không phát hiện lỗi mới ngoài reset-time chỉ có giây và engine-unavailable đã nêu.
- Cleanup worktree kiểm tra containment/protected path, giữ worktree dirty và retry cleanup; không phát hiện thêm lỗi xóa nhầm ngoài mục env path traversal.
- Claude reviewer là read-only theo allowed tools và có timeout/backoff/quota detection; không phát hiện lỗi chức năng mới trong file `src/engines/claude-review.ts`.
