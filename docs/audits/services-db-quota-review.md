# Báo cáo Rà soát Mã nguồn: Tầng Dịch vụ, Dữ liệu SQLite & Quota (AgentHub)

## 1. Tổng quan & Phạm vi
Rà soát toàn diện mã nguồn các module:
- **Tầng cơ sở dữ liệu**: `src/db/index.ts`, `src/db/time.ts` (lưu trữ SQLite qua `better-sqlite3`, migrations, index, transactions, concurrency).
- **Tầng hạn mức & quota**: `src/quota/index.ts`, `src/quota/usage.ts`, `src/quota/alerts.ts`, `src/quota/wakeup.ts`, `src/quota/claude-usage.ts`, `src/quota/codex-api.ts`, `src/quota/codex-usage.ts` (thu thập usage, tính toán reset, phân bổ dung lượng, đánh thức tài khoản).
- **Tầng dịch vụ & điều phối**: `src/services/index.ts`, `src/services/dag.ts` (quản lý vòng đời task, project, batch, DAG dependencies, N+1 query, ranh giới transaction).

Các phát hiện dưới đây được phân loại theo mức độ ưu tiên:
- **Cao (High)**: Nguy cơ trực tiếp gây mất dữ liệu, deadlock / crash ứng dụng, sai lệch quota nghiêm trọng hoặc nghẽn hiệu năng hệ thống ở quy mô thực tế.
- **Trung bình (Medium)**: Thiếu sót kiến trúc, N+1 query lặp lại, thiếu transaction đa bảng, thiếu index hoặc xử lý ngoại lệ tiềm ẩn rủi ro khi tải cao.
- **Thấp (Low)**: Điểm tối ưu hoá thuật toán, đồng nhất đơn vị dữ liệu hoặc cải thiện code structure không gây sự cố tức thì.

---

## 2. Bảng tổng hợp các vấn đề phát hiện

| STT | Vấn đề / Hạng mục | Vị trí (`file:dòng`) | Mức độ ưu tiên | Tóm tắt nguy cơ |
|---|---|---|:---:|---|
| 1 | Migrations chạy ngoài transaction | `src/db/index.ts:1021-1026` | **Cao** | Migration DDL nhiều câu lệnh bị lỗi dở dang sẽ làm hỏng DB, không thể khởi động lại |
| 2 | Các migration rebuild `tasks` không bảo toàn `runCount` và `consecutiveCrashes` | `src/db/index.ts:754-778`, `780-816`, `818-841`, `882-918` | **Cao** | Rebuild bảng `tasks` ở các migration 55, 56, 57, 62 có thể làm mất lịch sử crash và số lượt chạy |
| 3 | Mất index `idx_tasks_batch` và `idx_tasks_creation_session` | `src/db/index.ts:758-777`, `811-816`, `836-841`, `913-918` | **Cao** | Rebuild bảng `tasks` ở các migration 55, 56, 57, 62 không tạo lại index của migration 34 và 47 |
| 4 | Thiếu `busy_timeout` trên kết nối SQLite | `src/db/index.ts:1001-1005` | **Cao** | Daemon, CLI và MCP truy cập đồng thời vào `hub.db` bị văng lỗi `database is locked` |
| 5 | Thiếu khoá đồng bộ tiến trình khi chạy migration | `src/db/index.ts:1007-1026` | **Cao** | Nhiều tiến trình mở DB cùng lúc sẽ chạy migration trùng lặp, gây xung đột schema |
| 6 | Thiếu transaction nguyên tử trong `AppService.createBatch` và `dispatchBatch` | `src/services/index.ts:4183-4239`, `4300-4311` | **Cao** | Lỗi giữa chừng để lại batch dở dang, task mồ côi hoặc trạng thái nửa draft nửa queued |
| 7 | N+1 query nghiêm trọng trong `SavingsService.getSavings` | `src/savings.ts:412`, `src/claude-sessions/repo.ts:45` | **Cao** | Lặp qua từng task để query riêng `claude_task_usage`, làm đơ dashboard khi có hàng trăm task |
| 8 | `getStatus()` tải toàn bộ task vào RAM | `src/services/index.ts:1455`, `1495-1517` | **Cao** | Tải hàng ngàn task cũ từ DB lên JS chỉ để đếm trạng thái thay vì dùng `COUNT(*) GROUP BY` |
| 9 | N+1 query lặp qua các profile Claude trong `getStatus()` | `src/services/index.ts:1584-1587`, `1328-1410` | **Cao** | Chạy 6 câu query DB và phân tích đường dẫn worktree cho mỗi profile Claude trên mỗi nhịp polling |
| 10 | `QuotaMarkRepo.mark` ghi đè thời hạn ngắn lên thời hạn dài | `src/db/index.ts:1705-1709`, `src/quota/usage.ts:316-331` | **Cao** | Hạn mức tuần (hết hạn 5 ngày) bị cửa sổ 5 giờ (reset sau 2h) ghi đè làm mở khoá sớm sai quy định |
| 11 | `bestRemaining` bỏ qua hoàn toàn hạn mức tuần (`week`) | `src/quota/usage.ts:354-361` | **Cao** | Tài khoản hết 100% quota tuần vẫn được báo còn 100% quota (do chỉ nhìn cửa sổ 5h) |
| 13 | Hoàn toàn không có cơ chế backup và restore cơ sở dữ liệu | `src/db/index.ts` | **Cao** | Không có snapshot tự động trước khi migration hay backup định kỳ; nguy cơ mất dữ liệu hoàn toàn khi crash |
| 14 | Thao tác `ProjectRepo.purge` dễ tràn biến SQL (`SQLITE_MAX_VARIABLE_NUMBER`) | `src/db/index.ts:1404-1408`, `1374-1379` | **Cao** | Sinh chuỗi `IN (?,?,...)` với toàn bộ id task; crash với `too many SQL variables` nếu dự án có nhiều task |
| 16 | Thêm cột ngoài migration (`ensureSchedulerLimitColumns`) | `src/db/index.ts:1062-1080` | **Trung** | Chạy DDL kiểm tra và `ALTER TABLE` mỗi lần mở kết nối DB thay vì tích hợp trong hệ thống version |
| 17 | Thiếu transaction nguyên tử trong `TaskRepo` (`insert`, `update`, `delete`) | `src/db/index.ts:1871-1907`, `1950-1981`, `1929-1933` | **Trung** | Bảng `tasks` và bảng liên kết `task_deps` bị lệch dữ liệu nếu có lỗi xảy ra giữa các câu lệnh |
| 18 | Thiếu transaction trong `ProfileRepo.delete` và `softDelete` | `src/db/index.ts:1617-1627` | **Trung** | Dữ liệu `quota_marks` hoặc `quota_usage` bị xoá dở dang nếu tiến trình bị ngắt |
| 19 | `ProfileRepo.rename` bỏ sót bảng `department_profiles` | `src/db/index.ts:1629-1647` | **Trung** | Đổi tên hồ sơ nhưng không cập nhật `department_profiles`, làm phòng ban mất phân bổ worker |
| 20 | Phương thức đọc `ChatSessionRepo.getAll` thực hiện ghi (`UPDATE`) ngầm | `src/db/index.ts:2308-2321` | **Trung** | Gọi hàm đọc lại làm thay đổi `updatedAt` của session và ghi vào DB trong quá trình đọc danh sách |
| 21 | Thiếu transaction khi cập nhật kết thúc worker trong `Scheduler` | `src/scheduler/index.ts:2203-2211`, `2213-2215`, `2237-2241` | **Trung** | `runs.finish`, `tasks.update` và crash counter không nằm trong 1 transaction; crash làm lệch trạng thái |
| 22 | Quét toàn bộ bảng `events` không có index trong `hasTimesheetPosted` | `src/db/index.ts:2201-2205` | **Trung** | Full scan toàn bộ lịch sử sự kiện kết hợp `json_extract` trên từng bản ghi |
| 23 | Quét toàn bộ `tracker_items` vào RAM (`listAll`) để tìm ticket | `src/scheduler/index.ts:3501`, `3726`, `src/db/index.ts:3316` | **Trung** | Không có index trên `display_id`, phải tải toàn bộ ticket từ DB lên để `.find()` trong JS |
| 24 | N+1 query trong `AppService.listBatches` và `pageBatches` | `src/services/index.ts:4257-4275` | **Trung** | Chạy riêng `getByBatch` cho từng batch trong danh sách thay vì gom nhóm trong một query |
| 25 | Thiếu index trên một số cột khoá ngoại ở bảng con | `src/db/index.ts:131`, `156`, `649`, `935` | **Trung** | `check_results(runId)` và `chat_sessions(projectId)` chưa có index dẫn đầu tương ứng, làm chậm thao tác DELETE/UPDATE bảng cha |
| 26 | Quét toàn bộ bảng `claude_usage` không có điều kiện thời gian | `src/daily-usage.ts:381-385` | **Trung** | Tải toàn bộ lượt dùng Claude trong lịch sử lên bộ nhớ rồi mới lọc 7 ngày gần nhất bằng JS |
| 27 | Lỗi tính sai múi giờ trong `parseResetTime` | `src/quota/claude-usage.ts:28-39`, `45-66` | **Trung** | Múi giờ viết tắt không chuẩn IANA (EST, PST, EDT) làm `Intl` văng lỗi, fallback về UTC gây lệch 4-8 giờ |
| 28 | Lệnh đánh thức Codex CLI không chuyển hướng stdin | `src/quota/wakeup.ts:101`, `110-115` | **Trung** | Không cấp `/dev/null` cho stdin của `codex exec` vi phạm mục 2.2 của PLAN.md, có thể khiến tiến trình bị treo |
| 29 | Đọc log rollout Codex hoàn toàn đồng bộ làm nghẽn event loop | `src/quota/codex-usage.ts:18-69`, `106-116` | **Trung** | Duyệt cây thư mục và đọc 256KB đồng bộ (`readdirSync`, `readSync`) gây giật lag server |
| 30 | Thiếu chiến lược checkpoint / dọn dẹp file WAL SQLite | `src/db/index.ts:1001-1005` | **Trung** | File `hub.db-wal` có thể phình to vô hạn khi có tiến trình đọc liên tục hoặc polling dồn dập |
| 31 | Thiếu test cho rollback và kiểm tra toàn vẹn chuỗi migration | `test/migration.test.ts:1-174` | **Trung** | Chưa có test kiểm tra kịch bản migration lỗi dở dang hoặc bảo toàn dữ liệu qua tất cả 68 migrations |
| 32 | Race condition khi cập nhật liên kết ticket trong `TrackerItemRepo.linkTask` | `src/db/index.ts:3285-3298` | **Thấp** | Thao tác đọc-sửa-ghi JSON `task_ids` không có transaction / optimistic lock, có thể mất liên kết khi gọi song song |
| 33 | Tìm kiếm task dùng UDF `agenthub_normalize` trên từng dòng | `src/db/index.ts:1790-1794` | **Thấp** | Không thể dùng index B-tree; phải chuyển ngữ qua cầu nối FFI JS-SQLite cho mọi bản ghi |
| 34 | Đệ quy DFS không memoized trong `filterTasksForGraph` | `src/services/dag.ts:129-146` | **Thấp** | Độ phức tạp O(N^2) khi kiểm tra unfinished descendants cho từng task đã hoàn thành |
| 35 | `cleanupExpired` thực hiện N query xoá đơn lẻ | `src/quota/index.ts:147-158` | **Thấp** | Lặp qua từng bản ghi hết hạn để gọi `DELETE` riêng rẽ thay vì dùng một lệnh SQL duy nhất |
| 36 | `Date.parse` phụ thuộc vào định dạng chuỗi từ `agy` CLI | `src/quota/usage.ts:48-50` | **Thấp** | Dễ bị ảnh hưởng bởi locale hoặc định dạng ngày không chuẩn ISO của terminal |
| 37 | Lệch đơn vị thời gian giữa `lastCrashAt` (ms) và `coolingUntil` (s) | `src/scheduler/index.ts:489-496`, `src/db/index.ts:1078-1079` | **Thấp** | Hai cột số nguyên trong cùng bảng `profiles` lưu hai đơn vị khác nhau gây nhầm lẫn |

---

## 3. Chi tiết Phân tích & Đề xuất Cải tiến

### Nhóm I: Migrations & Tính toàn vẹn Schema

#### 1. Migrations chạy ngoài transaction
- **Vị trí**: `src/db/index.ts:1021-1026`
- **Mô tả**: Vòng lặp migration thực thi từng migration bằng `db.exec(MIGRATIONS[i])` rồi mới cập nhật bảng `meta`. Nếu một migration chứa nhiều lệnh SQL (DDL + DML) và bị lỗi hoặc tiến trình bị tắt ngang ở câu lệnh thứ 2: các câu lệnh trước đó đã được áp dụng vào DB, nhưng `meta.schema_version` chưa được tăng. Lần mở ứng dụng tiếp theo sẽ chạy lại migration đó từ đầu, gây lỗi `table ... already exists` hoặc `duplicate column name`, làm tê liệt hoàn toàn hệ thống.
- **Mức độ ưu tiên**: **Cao**
- **Đề xuất**: Bọc toàn bộ việc chạy migration và cập nhật version vào transaction:
  ```ts
  const runMigration = db.transaction((index: number, sql: string) => {
    db.exec(sql);
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(String(index));
  });
  for (let i = currentVersion + 1; i < MIGRATIONS.length; i++) {
    runMigration(i, MIGRATIONS[i]);
  }
  ```

#### 2. Các migration rebuild `tasks` không bảo toàn `runCount` và `consecutiveCrashes`
- **Vị trí**: `src/db/index.ts:754-778`, `780-816`, `818-841`, `882-918`
- **Mô tả**: Migration 55, 56, 57 và 62 đều tạo lại bảng `tasks` nhưng không khai báo/chuyển tiếp hai cột `runCount` và `consecutiveCrashes`. Hai cột này chỉ được thêm động bởi `ensureSchedulerLimitColumns` sau khi toàn bộ chuỗi migration hoàn tất. Vì vậy mọi đường nâng cấp/rebuild khi các cột đã tồn tại sẽ làm mất giá trị lịch sử và thay bằng mặc định 0; với DB mới chạy tuần tự, rủi ro thực tế phụ thuộc việc cột đã được thêm trước khi rebuild hay chưa.
- **Mức độ ưu tiên**: **Cao**
- **Đề xuất**: Trong các script migration rebuild bảng `tasks`, phải bảo toàn đầy đủ các cột bổ sung đã tồn tại trong schema thực tế, hoặc chính thức đưa các cột từ `ensureSchedulerLimitColumns` vào chuỗi migrations cố định.

#### 3. Mất index `idx_tasks_batch` và `idx_tasks_creation_session` sau khi rebuild bảng `tasks`
- **Vị trí**: `src/db/index.ts:758-777`, `811-816`, `836-841`, `913-918`
- **Mô tả**: Migration 34 tạo index `idx_tasks_batch ON tasks(batchId)` và Migration 47 tạo index `idx_tasks_creation_session ON tasks(projectId, creationSessionId, createdAt)`. Tuy nhiên, các migration rebuild bảng `tasks` sau đó (Migration 55, 56, 57, 62) sau khi `DROP TABLE tasks` chỉ tạo lại 3 index: `idx_tasks_project_created`, `idx_tasks_status_created`, `idx_tasks_project_status_created`. Hai index quan trọng `idx_tasks_batch` và `idx_tasks_creation_session` đã bị xoá hoàn toàn, khiến tất cả các truy vấn lọc task theo batch hoặc session tạo phải thực hiện full table scan.
- **Mức độ ưu tiên**: **Cao**
- **Đề xuất**: Bổ sung `CREATE INDEX IF NOT EXISTS idx_tasks_batch ON tasks(batchId)` và `CREATE INDEX IF NOT EXISTS idx_tasks_creation_session ON tasks(projectId, creationSessionId, createdAt)` vào cuối chuỗi migration mới nhất.

#### 4. Thiếu `busy_timeout` trên kết nối SQLite
- **Vị trí**: `src/db/index.ts:1001-1005`
- **Mô tả**: Khi mở DB trong `openDatabase`, ứng dụng chỉ cấu hình `WAL` và `foreign_keys = ON`, hoàn toàn không thiết lập `busy_timeout` (mặc định trong SQLite là 0ms). AgentHub là ứng dụng đa tiến trình (daemon `agenthubd`, lệnh CLI `agenthub`, worker reaper, và process MCP `agenthub mcp`). Bất cứ khi nào daemon đang ghi dữ liệu mà CLI hoặc MCP thực hiện ghi, câu lệnh sẽ lập tức văng ngoại lệ `SqliteError: database is locked`.
- **Mức độ ưu tiên**: **Cao**
- **Đề xuất**: Đặt `busy_timeout` tối thiểu 5000ms ngay khi mở kết nối:
  ```ts
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  ```

#### 5. Thiếu khoá đồng bộ tiến trình khi chạy migration
- **Vị trí**: `src/db/index.ts:1007-1026`
- **Mô tả**: Nếu người dùng khởi động daemon cùng lúc chạy một lệnh CLI hoặc mở tool MCP sau khi cập nhật phiên bản mới, cả hai tiến trình đều gọi `openDatabase` và cố gắng chạy chuỗi migration song song. Điều này dẫn tới tranh chấp DDL hoặc ghi đè `schema_version`.
- **Mức độ ưu tiên**: **Cao**
- **Đề xuất**: Dùng cơ chế khoá file định dạng `hub.db.lock` (bằng `fs.openSync` với cờ `O_EXCL` hoặc `flock`) trong thời gian kiểm tra và chạy migration để đảm bảo chỉ đúng 1 tiến trình thực hiện migration tại một thời điểm.

---

### Nhóm II: Giao dịch (Transactions), Atomicity & Concurrency

#### 6. Thiếu transaction nguyên tử trong `AppService.createBatch` và `dispatchBatch`
- **Vị trí**: `src/services/index.ts:4183-4239`, `4300-4311`
- **Mô tả**:
  - Trong `createBatch`: Thao tác tạo batch (`taskBatchRepo.create`), chèn danh sách task (`taskRepo.insert`), điền dependencies (`taskRepo.populateDeps`) và chèn sự kiện (`eventRepo.insert`) được gọi rời rạc. Nếu task thứ 5 bị lỗi ràng buộc dữ liệu, 4 task trước và batch đã nằm trong DB ở trạng thái dở dang.
  - Trong `dispatchBatch`: Lặp qua danh sách draft task để cập nhật `status = queued`, chèn event cho từng task, rồi cập nhật batch sang `dispatched`. Không có transaction nào bảo bọc; crash giữa chừng sẽ làm một nửa số task được queue còn một nửa vẫn là draft.
- **Mức độ ưu tiên**: **Cao**
- **Đề xuất**: Đưa toàn bộ chuỗi thao tác ghi của `createBatch` và `dispatchBatch` vào một `db.transaction(() => { ... })()`.

#### 7. Thiếu transaction nguyên tử trong `TaskRepo`
- **Vị trí**: `src/db/index.ts:1871-1907`, `1950-1981`, `1929-1933`
- **Mô tả**:
  - `insert`: Chèn vào bảng `tasks`, sau đó mới lặp qua `dependsOn` chèn vào `task_deps`. Nếu việc chèn dependency lỗi, task vẫn được lưu nhưng mất liên kết phụ thuộc.
  - `update`: Khi cập nhật dependencies, repo chạy `DELETE FROM task_deps WHERE taskId = ?` rồi mới parse JSON và chèn bản ghi mới. Nếu parse JSON lỗi, các dependency cũ đã bị xoá mất vĩnh viễn trong khi cột `tasks.dependsOn` vẫn giữ chuỗi cũ.
  - `delete`: Xoá `task_deps`, xoá `tasks`, xoá `meta` trong 3 câu lệnh riêng biệt không transaction.
- **Mức độ ưu tiên**: **Trung bình**
- **Đề xuất**: Bọc các phương thức sửa đổi nhiều bảng trong `TaskRepo` bằng `this.db.transaction`.

#### 8. `ProfileRepo.rename` bỏ sót bảng `department_profiles`
- **Vị trí**: `src/db/index.ts:1629-1647`
- **Mô tả**: Hàm `rename` tắt foreign keys và cập nhật lại `name` trên các bảng: `profiles`, `quota_marks`, `quota_usage`, `runs`, `run_metrics`, `chat_sessions`. Tuy nhiên, bảng `department_profiles` (chứa cột `profileName` phân bổ hồ sơ vào phòng ban) bị bỏ quên hoàn toàn. Khi đổi tên hồ sơ, phòng ban sẽ giữ lại tên cũ không còn tồn tại, làm hỏng logic điều phối worker theo phòng ban.
- **Mức độ ưu tiên**: **Trung bình**
- **Đề xuất**: Thêm dòng:
  ```ts
  this.db.prepare('UPDATE department_profiles SET profileName = ? WHERE profileName = ?').run(newName, oldName);
  ```
  vào bên trong transaction của `rename`. Đồng thời bổ sung khoá ngoại `FOREIGN KEY (profileName) REFERENCES profiles(name) ON DELETE CASCADE` cho bảng `department_profiles`.

#### 9. Phương thức đọc `ChatSessionRepo.getAll` và `search` thực hiện ghi (`UPDATE`) ngầm
- **Vị trí**: `src/db/index.ts:2308-2321`
- **Mô tả**: Trong `getAll` và `search`, mỗi bản ghi session được duyệt qua hàm `normalizeAssistantSession`. Hàm này kiểm tra nếu id là `assistant`, nó sẽ thực thi câu lệnh SQL `UPDATE chat_sessions SET kind = 'assistant', updatedAt = datetime('now') WHERE id = ?`. Một hàm đọc danh sách (Query) lại làm biến đổi dữ liệu (Mutation), thay đổi cả `updatedAt` của session, làm xáo trộn thứ tự sắp xếp và có thể gây xung đột ghi nếu chạy song song.
- **Mức độ ưu tiên**: **Trung bình**
- **Đề xuất**: Tách việc chuẩn hoá dữ liệu session thành một migration duy nhất lúc mở DB, không thực hiện `UPDATE` trong hàm `getAll`/`search`.

#### 10. Thiếu transaction khi cập nhật kết thúc worker trong `Scheduler`
- **Vị trí**: `src/scheduler/index.ts:2203-2211`, `2213-2215`, `2237-2241`
- **Mô tả**: Khi tiến trình worker kết thúc, scheduler lần lượt gọi `this.runRepo.finish(rt.runId, 'done')`, `this.taskRepo.update(taskId, { status: 'checking', ... })`, và `this.recordWorkerSuccess(rt.profileName, taskId)`. Các câu lệnh này chạy độc lập; nếu daemon bị kill hoặc crash sau dòng 2203, run đã có kết quả `done` nhưng task vẫn giữ trạng thái `running` vĩnh viễn trong DB.
- **Mức độ ưu tiên**: **Trung bình**
- **Đề xuất**: Gom việc chuyển trạng thái run, task và thống kê worker vào một transaction nguyên tử.

---

### Nhóm III: Hiệu năng Truy vấn (Performance & N+1 Queries)

#### 11. N+1 query nghiêm trọng trong `SavingsService.getSavings`
- **Vị trí**: `src/savings.ts:412`, `src/claude-sessions/repo.ts:45`
- **Mô tả**: Trong phương thức tính toán khoản tiết kiệm `getSavings`, vòng lặp duyệt qua từng task trong hệ thống và gọi:
  ```ts
  const measured = this.claudeSessionRepo?.taskCost(task.id);
  ```
  Hàm `taskCost` thực thi câu lệnh SQL:
  ```sql
  SELECT COALESCE(SUM(effectiveTokens),0) effectiveTokens, COUNT(DISTINCT sessionId) sessions FROM claude_task_usage WHERE taskId=?
  ```
  Nếu hệ thống có 1.000 task, endpoint `/api/savings` sẽ thực thi 1.000 câu query đơn lẻ nối tiếp nhau.
- **Mức độ ưu tiên**: **Cao**
- **Đề xuất**: Gom thành 1 câu query duy nhất sử dụng `GROUP BY`:
  ```sql
  SELECT taskId, COALESCE(SUM(effectiveTokens), 0) AS effectiveTokens, COUNT(DISTINCT sessionId) AS sessions
  FROM claude_task_usage
  GROUP BY taskId
  ```
  Sau đó nạp kết quả vào một `Map<string, { effectiveTokens: number, sessions: number }>` trong bộ nhớ.

#### 12. `getStatus()` tải toàn bộ task vào RAM để đếm thủ công
- **Vị trí**: `src/services/index.ts:1455`, `1495-1517`
- **Mô tả**: Endpoint `/api/status` (được web dashboard gọi định kỳ liên tục) thực hiện `this.taskRepo.getAll()`. Toàn bộ dữ liệu của tất cả các task trong lịch sử (kể cả những task đã `done`, `cancelled` từ nhiều tháng trước với nội dung body lớn) được tải hết lên Node.js chỉ để chạy vòng lặp JavaScript đếm số lượng theo status và project.
- **Mức độ ưu tiên**: **Cao**
- **Đề xuất**: Dùng query tổng hợp trực tiếp từ SQLite:
  ```sql
  SELECT status, waitReason, COUNT(*) AS count FROM tasks GROUP BY status, waitReason;
  SELECT projectId, status, COUNT(*) AS count FROM tasks GROUP BY projectId, status;
  ```
  Giảm thời gian xử lý và mức chiếm dụng RAM từ O(N) về O(1).

#### 13. N+1 query lặp qua các profile Claude trong `getStatus()`
- **Vị trí**: `src/services/index.ts:1584-1587`, `1328-1410`
- **Mô tả**: Trong `getStatus()`, vòng lặp `profiles.map()` gọi `getClaudeProfileLimitedSessions(p)` cho từng profile Claude. Hàm này thực hiện tới 6 câu truy vấn DB độc lập (`claude_sessions`, `chat_sessions`, `claude_task_usage`, `tasks`, `claude_scan_state`), cộng thêm việc duyệt đệ quy đường dẫn thư mục worktree. Với N profile, số query tăng tuyến tính 6*N lần trong mỗi nhịp polling status.
- **Mức độ ưu tiên**: **Cao**
- **Đề xuất**: Gom việc lấy limited sessions của tất cả các profile Claude thành một hàm tổng hợp chạy một lần duy nhất ngoài vòng lặp.

#### 14. Quét toàn bộ bảng `events` không có index trong `hasTimesheetPosted`
- **Vị trí**: `src/db/index.ts:2201-2205`
- **Mô tả**: Hàm `hasTimesheetPosted` chạy câu lệnh:
  ```sql
  SELECT 1 FROM events
  WHERE type = 'tracker.timesheet.posted'
    AND json_extract(payload, '$.sourceId') = ?
    AND json_extract(payload, '$.date') = ?
  LIMIT 1
  ```
  Bảng `events` chỉ có duy nhất index `(taskId, id)`. Cột `type` không được đánh index. Câu lệnh trên bắt buộc SQLite phải quét toàn bộ bảng `events` (vốn tăng trưởng liên tục theo thời gian hoạt động của hub) và parse JSON trên từng dòng.
- **Mức độ ưu tiên**: **Trung bình**
- **Đề xuất**: Thêm index `CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);`.

#### 15. Quét toàn bộ `tracker_items` vào RAM để tìm ticket theo `display_id`
- **Vị trí**: `src/scheduler/index.ts:3501`, `3726`, `src/db/index.ts:3316`
- **Mô tả**: Khi lập prompt hoặc kiểm tra task có liên kết ticket ngoài, code gọi:
  ```ts
  this.trackerRepo.listAll().find((row) => row.display_id === task.externalRef);
  ```
  Hàm `listAll()` lấy toàn bộ danh sách ticket từ DB lên JS để tìm kiếm. Bảng `tracker_items` cũng không có index trên cột `display_id`.
- **Mức độ ưu tiên**: **Trung bình**
- **Đề xuất**: Bổ sung index `CREATE INDEX IF NOT EXISTS idx_tracker_items_display_id ON tracker_items(display_id);` và tạo hàm `getByDisplayId(displayId: string): TrackerItemRow | undefined` trong `TrackerItemRepo`.

#### 16. N+1 query trong `AppService.listBatches` và `pageBatches`
- **Vị trí**: `src/services/index.ts:4257-4275`
- **Mô tả**: Cả hai hàm `listBatches` và `pageBatches` đều duyệt qua danh sách batch và gọi:
  ```ts
  progress: batchProgress(this.taskRepo.getByBatch(batch.id))
  ```
  Gây ra N câu lệnh `SELECT * FROM tasks WHERE batchId = ?` riêng rẽ.
- **Mức độ ưu tiên**: **Trung bình**
- **Đề xuất**: Truy vấn một lần với điều kiện `WHERE batchId IN (...)` hoặc dùng câu lệnh SQL gom nhóm tiến độ theo `batchId`.

#### 17. Thiếu index trên một số cột khoá ngoại ở bảng con
- **Vị trí**: `src/db/index.ts:131`, `156`, `649`, `935`
- **Mô tả**:
  - `check_results(runId)` trỏ tới `runs(id)`, nhưng index hiện có là `(taskId, runId)` nên không có `runId` ở vị trí dẫn đầu.
  - `chat_sessions(projectId)` trỏ tới `projects(id)` nhưng không có index riêng trên `projectId`.
  - `claude_task_usage` không có cột `runId`; bảng này chỉ có `taskId`, `sessionId`, `turnId` và `effectiveTokens`, nên không thuộc phát hiện này.
  Trong SQLite, các cột foreign key không được tự động đánh index. Khi xoá hoặc cập nhật bản ghi ở bảng cha, SQLite buộc phải full scan các bảng con để kiểm tra ràng buộc khoá ngoại.
- **Mức độ ưu tiên**: **Trung bình**
- **Đề xuất**: Tạo index cho các cột khoá ngoại tham chiếu trên các bảng con:
  - `CREATE INDEX IF NOT EXISTS idx_check_results_run ON check_results(runId);`
  - `CREATE INDEX IF NOT EXISTS idx_chat_sessions_project ON chat_sessions(projectId);`

#### 18. Quét toàn bộ bảng `claude_usage` không giới hạn khoảng ngày trong `getDailyUsageReport`
- **Vị trí**: `src/daily-usage.ts:381-385`
- **Mô tả**: Câu lệnh `SELECT sessionId, ts, effective FROM claude_usage` tải toàn bộ lịch sử sử dụng token Claude vào bộ nhớ mà không có điều kiện `WHERE ts >= ?`, mặc dù hàm báo cáo chỉ yêu cầu thống kê trong 7 ngày gần nhất (`days = 7`).
- **Mức độ ưu tiên**: **Trung bình**
- **Đề xuất**: Bổ sung điều kiện lọc thời gian ở tầng SQL: `WHERE ts >= datetime('now', '-' || ? || ' days')`.

---

### Nhóm IV: Logic Quota & Thu thập Dữ liệu Hạn mức

#### 19. `QuotaMarkRepo.mark` ghi đè thời hạn ngắn lên thời hạn dài
- **Vị trí**: `src/db/index.ts:1705-1709`, `src/quota/usage.ts:316-331`
- **Mô tả**:
  Trong `QuotaMarkRepo.mark`:
  ```sql
  INSERT INTO quota_marks (profileName, family, until, reason)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(profileName, family) DO UPDATE SET until=excluded.until, reason=excluded.reason
  ```
  Một tài khoản có thể có cả cửa sổ hạn mức 5 giờ (`5h`) và hạn mức tuần (`week`). Nếu hạn mức tuần bị cạn (hết hạn sau 5 ngày), lệnh đánh dấu lưu `until = now + 5 ngày`. Tuy nhiên, khi cửa sổ 5h cũng cạn (reset sau 2 giờ), vòng lặp duyệt qua cửa sổ 5h sẽ chạy lệnh ghi đè `until = now + 2 giờ`. Hậu quả là tài khoản bị hết hạn mức tuần lại được tự động gỡ phong toả chỉ sau 2 giờ, vi phạm quy định hạn mức của nhà cung cấp.
- **Mức độ ưu tiên**: **Cao**
- **Đề xuất**: Giữ giá trị thời điểm reset lớn nhất khi có xung đột:
  ```sql
  ON CONFLICT(profileName, family) DO UPDATE SET
    until = MAX(quota_marks.until, excluded.until),
    reason = excluded.reason
  ```

#### 20. `QuotaUsageService.bestRemaining` bỏ qua hoàn toàn hạn mức tuần (`week`)
- **Vị trí**: `src/quota/usage.ts:354-361`
- **Mô tả**: Hàm `bestRemaining` được dùng để đánh giá phần trăm quota còn lại tốt nhất của một tài khoản:
  ```ts
  const values = names.flatMap((name) => this.usage.getForProfile(name).filter((u) => u.window === '5h' && u.grp === group).map((u) => u.remainingPct));
  ```
  Hàm chỉ lọc đúng `u.window === '5h'`. Nếu tài khoản đã sử dụng hết 100% hạn mức tuần (`u.window === 'week'` và `remainingPct = 0`), nhưng cửa sổ 5 giờ vừa reset về 100%, hàm vẫn trả về `100%`, khiến scheduler đánh giá sai rằng tài khoản còn dồi dào dung lượng.
- **Mức độ ưu tiên**: **Cao**
- **Đề xuất**: Lấy giá trị nhỏ nhất giữa các cửa sổ của cùng một tài khoản (`Math.min(5h_remaining, week_remaining)`) trước khi lấy giá trị tốt nhất giữa các tài khoản cùng email.

#### 22. Lỗi tính sai múi giờ trong `parseResetTime`
- **Vị trí**: `src/quota/claude-usage.ts:28-39`, `45-66`
- **Mô tả**: Khi parse chuỗi thời gian reset của Claude Code (ví dụ `Resets 6:50pm (EDT)` hoặc `Resets 2am (PST)`), hàm truyền chuỗi múi giờ vào `Intl.DateTimeFormat({ timeZone })`. Theo chuẩn ECMA-402, các tên viết tắt 3 chữ cái (EDT, PST, EST, BST...) không phải là IANA time zone hợp lệ và sẽ ném lỗi `RangeError`. Khối `catch` bắt lỗi này và âm thầm trả về `offset = 0` (UTC). Do đó, thời gian reset tính toán bị lệch từ 4 đến 8 tiếng so với thực tế.
- **Mức độ ưu tiên**: **Trung bình**
- **Đề xuất**: Xây dựng một bảng ánh xạ các viết tắt múi giờ phổ biến sang offset phút (ví dụ `{ edt: -240, est: -300, pdt: -420, pst: -480, cdt: -300, cst: -360 }`) trước khi fallback về `Intl`.

#### 23. Lệnh đánh thức Codex CLI không chuyển hướng stdin
- **Vị trí**: `src/quota/wakeup.ts:101`, `110-115`
- **Mô tả**: Trong mục 2.2 của `docs/PLAN.md` quy định rõ: *"Codex CLI: Stdin phải là /dev/null"*. Tuy nhiên trong `wakeupCommands`:
  ```ts
  return [{ bin: bins.codex, args: ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', WAKEUP_PROMPT], env }];
  ```
  Và `defaultWakeupRunner` dùng `execFile` không cấu hình đóng stdin hoặc truyền `/dev/null`. Lệnh có thể bị treo chờ input cho tới khi hết timeout 120s.
- **Mức độ ưu tiên**: **Trung bình**
- **Đề xuất**: Cấu hình `stdio: ['ignore', 'pipe', 'pipe']` hoặc truyền `/dev/null` cho stdin khi chạy lệnh Codex wakeup.

#### 24. Đọc log rollout Codex hoàn toàn đồng bộ làm nghẽn event loop
- **Vị trí**: `src/quota/codex-usage.ts:18-69`, `106-116`
- **Mô tả**: `readCodexRateLimits` gọi `newestRolloutFiles` quét đệ quy các thư mục theo ngày bằng `fs.readdirSync`, rồi đọc 256KB cuối của các file bằng `fs.openSync`, `fs.readSync`, `fs.closeSync`. Toàn bộ quá trình diễn ra đồng bộ trên main thread của Node.js trong mỗi chu kỳ kiểm tra quota, gây gián đoạn việc phục vụ HTTP API và WebSocket.
- **Mức độ ưu tiên**: **Trung bình**
- **Đề xuất**: Chuyển các hàm quét thư mục và đọc file sang dạng bất đồng bộ (`fs.promises` / `fs.createReadStream`).

---

### Nhóm V: Lưu trữ Nhạy cảm, Sao lưu & Khôi phục

#### 25. Hoàn toàn không có cơ chế backup và restore cơ sở dữ liệu
- **Vị trí**: Toàn bộ module `src/db/`
- **Mô tả**: `better-sqlite3` cung cấp sẵn hàm `db.backup(destination, options)` hỗ trợ sao lưu trực tuyến an toàn không gián đoạn ghi ngay cả trong chế độ WAL. Tuy nhiên, toàn bộ mã nguồn AgentHub hiện tại không có bất kỳ lệnh hoặc cron job nào thực hiện sao lưu DB định kỳ, cũng như không tạo snapshot tạm thời của `hub.db` trước khi thực thi chuỗi 68 migrations. Khi gặp sự cố crash phần cứng hoặc mất điện đột ngột trong lúc ghi dở (bài học mục 2.4 của PLAN.md), rủi ro hỏng hóc DB là rất lớn và không có điểm phục hồi.
- **Mức độ ưu tiên**: **Cao**
- **Đề xuất**:
  1. Tự động snapshot `hub.db` sang `hub.db.bak-<timestamp>` trước khi áp dụng bất kỳ migration nào trong `openDatabase`.
  2. Bổ sung endpoint và tác vụ nền sao lưu định kỳ bằng `db.backup()`.

#### 26. Thiếu chiến lược checkpoint / dọn dẹp file WAL SQLite
- **Vị trí**: `src/db/index.ts:1001-1005`
- **Mô tả**: SQLite ở chế độ WAL dựa vào checkpoint để chuyển dữ liệu từ file `-wal` sang file `.db` chính. Khi có nhiều tác vụ đọc nền diễn ra liên tục (scheduler tick 2 giây, quota collector, SSE broadcast), checkpoint tự động có thể bị hoãn liên tục, khiến file `-wal` phình to hàng trăm megabytes, làm chậm tốc độ đọc và tiêu tốn dung lượng đĩa.
- **Mức độ ưu tiên**: **Trung bình**
- **Đề xuất**: Thiết lập `db.pragma('wal_autocheckpoint = 1000')` và thực hiện `PRAGMA wal_checkpoint(PASSIVE)` định kỳ trong tác vụ bảo trì nền.

#### 27. Đơn vị thời gian không đồng nhất giữa `lastCrashAt` và `coolingUntil`
- **Vị trí**: `src/scheduler/index.ts:489-496`, `src/db/index.ts:1078-1079`
- **Mô tả**: Trong bảng `profiles`:
  - `lastCrashAt` lưu thời gian dạng mili-giây: `now = Date.now()`
  - `coolingUntil` lưu thời gian dạng giây (epoch seconds): `Math.floor(... / 1000)`
  Cả hai cột đều có kiểu `INTEGER` trong SQLite. Sự không nhất quán về đơn vị gây nguy cơ so sánh sai lệch khi viết các truy vấn kiểm tra thời gian làm nguội của hồ sơ.
- **Mức độ ưu tiên**: **Thấp**
- **Đề xuất**: Chuẩn hoá toàn bộ timestamp lưu trong các cột số nguyên của SQLite về epoch giây hoặc mili-giây thống nhất.
