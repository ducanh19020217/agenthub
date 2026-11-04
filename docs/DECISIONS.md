# Quyết định kiến trúc (Decisions Log)

## DEC-003: Watchdog dùng đa nguồn hoạt động của worker

- **Bối cảnh**: `agy -p` có thể không ghi stdout trong khi agent vẫn đang gọi công cụ. Chỉ dùng mtime log khiến watchdog kill nhầm worker Gemini.
- **Quyết định**: Mốc hoạt động là mtime mới nhất của log, conversation DB đúng HOME/profile hoặc worktree (tối đa 5000 mục, bỏ qua `node_modules`, `.git/objects`, `dist`). Conversation chỉ xét file thay đổi sau khi run bắt đầu; profile keyring dùng HOME thật. Với trạng thái `waiting up to`, chỉ coi là kẹt khi log và conversation cùng im lặng quá `waitingMinutes`.
- **Ngưỡng mặc định**: `stallMinutes = 20`, `waitingMinutes = 15`, để đủ thời gian cho các lượt gọi tool dài của agy mà vẫn phát hiện worker thực sự không còn hoạt động.
- **Giới hạn**: Khi một profile chạy hai slot đồng thời, run chưa lưu conversation id nên dùng file conversation mới nhất của profile, có thể đánh dấu hoạt động của slot còn lại.
- **Hiệu năng**: Sau mỗi lần đo, conversation/worktree được cache tối đa 30 giây trên từng run; mỗi lần quét ưu tiên log, conversation và `.git/index`, chỉ đệ quy worktree khi cần và dừng sớm khi gặp mtime mới hơn cache.

## DEC-004: Cảnh báo rủi ro hardlink trong cache node_modules

- **Bối cảnh**: Worktree dùng hardlink tới cache để tiết kiệm ổ đĩa. Worker sửa trực tiếp một file trong `node_modules` sẽ sửa luôn inode trong cache và ảnh hưởng các worktree khác.
- **Quyết định**: Chỉ dùng cache cho dependency đã chuẩn bị; khi lockfile đổi hoặc kiểm tra native thất bại thì cài riêng trong worktree. Lệnh `agenthub clean --dedupe --verify` (hoặc một bước verify tương đương trong tương lai) cần được dùng để phát hiện cache bị thay đổi và cảnh báo trước khi tái sử dụng.
- **Hệ quả**: Hardlink không bảo vệ cache khỏi thao tác ghi của worker; việc kiểm tra integrity/verify là trách nhiệm của quy trình dọn dẹp và chuẩn bị dependency.

## DEC-005: Dùng cờ paused trên running task thay vì thêm status mới vào schema SQLite

- **Bối cảnh**: Bảng `tasks` trong SQLite có ràng buộc `CHECK(status IN ('draft', 'queued', 'running', 'review', 'done', 'failed', 'waiting_quota'))`. Việc thêm trạng thái `paused` vào SQLite CHECK constraint yêu cầu tạo bảng tạm và migrate toàn bộ dữ liệu, đồng thời có thể gây lỗi các truy vấn hiện hữu dựa trên giả định task đang chạy có `status = 'running'`.
- **Quyết định**: Áp dụng phương án được đề bài cho phép ("hoặc cờ `paused` trên task running — chọn cách ít ảnh hưởng nhất"). Giữ nguyên `status = 'running'` và quản lý trạng thái tạm dừng thông qua cờ `paused: boolean`, `pauseReason: 'manual' | 'load' | null`, `pausedAt: number | null` trên `RunningTask` của Scheduler và đối tượng task trả về qua API (`/api/status`, `/api/tasks/:id`).
- **Hệ quả**:
  - Không phá vỡ cấu trúc cơ sở dữ liệu SQLite hay yêu cầu database migration phức tạp.
  - Tích hợp trơn tru với các logic hiện hữu: khi `paused = true`, scheduler đóng băng đồng hồ `timeoutAt` (cộng thêm thời gian đã dừng khi resume), bỏ qua kiểm tra stall và no-commit watchdog.
  - Phục hồi an toàn: khi daemon tắt hoặc khởi động lại, các tiến trình đang paused đều được gửi `SIGCONT` để tránh bị kẹt trong trạng thái dừng `T`.

## DEC-001: Bổ sung endpoint GET/PUT /api/config cho cấu hình hệ thống và chuỗi model mặc định

- **Bối cảnh**: Theo đề bài `docs/tasks/a2-web.md` (mục 4 - Cài đặt) và `docs/PLAN.md` (mục 3.5, 3.9), trang Cài đặt trên Web dashboard cần xem và chỉnh sửa chuỗi model mặc định (hard / easy) và cấu hình liên quan (như timeout). Hợp đồng API ban đầu tại mục 3.7 chưa có endpoint cấu hình.
- **Quyết định**: Bổ sung endpoint vào API contract cho task `a1-api-mcp` và `a2-web`:
  - `GET /api/config`: Trả về cấu hình hiện tại từ `~/.agenthub/config.json`:
    ```json
    {
      "modelChains": {
        "hard": ["claude-opus-4-6-thinking", "codex:gpt-5.6-luna", "gemini-3.8-flash-high"],
        "easy": ["gemini-3.8-flash-medium", "codex:gpt-5.6-luna"]
      },
      "runTimeoutHours": 3
    }
    ```
  - `PUT /api/config`: Cập nhật cấu hình và lưu vào `config.json`. Payload có cùng cấu trúc với `GET /api/config`.
- **Hệ quả**: Backend `a1-api-mcp` sẽ triển khai 2 endpoint này tương thích với schema trên. Frontend `a2-web` dùng endpoint này cho trang Cài đặt và mock tương ứng trong MSW.

## DEC-002: Nâng cấp ThemeContext sang 3 chế độ (dark, light, system) và try/catch localStorage

- **Bối cảnh**: Theo đề bài `docs/tasks/t-ui-dark.md`, người dùng yêu cầu mặc định dark theme, lựa chọn theme lưu trong `localStorage` (bọc try/catch), và công tắc trên header có 3 chế độ: Tối / Sáng / Theo hệ thống. Lần đầu mở thì dùng Tối.
- **Quyết định**: Nâng cấp `web/src/context/ThemeContext.tsx` và `web/src/components/Layout.tsx`:
  - `ThemeMode` hỗ trợ: `'dark' | 'light' | 'system'`.
  - Mặc định khi chưa có dữ liệu lưu trữ là `'dark'`.
  - Mọi thao tác đọc/ghi `localStorage` được bọc try/catch an toàn.
  - Chế độ `'system'` tự động lắng nghe sự kiện `matchMedia('(prefers-color-scheme: dark)')` để chuyển đổi giao diện động.
  - Công tắc trên header và menu mobile hiển thị 3 tùy chọn (Tối / Sáng / Hệ thống).
- **Hệ quả**: Giao diện khởi động mặc định ở dark theme không bị nháy sáng, an toàn trong mọi môi trường trình duyệt.

## DEC-005: Dùng dagre cho bố cục đồ thị tự động trong TaskDag (c-dag-view)

- **Bối cảnh**: Theo đề bài `c-dag-view`, component `TaskDag` cần vẽ sơ đồ quan hệ phụ thuộc giữa các task dạng đồ thị có hướng (DAG), bố cục tự động từ trái sang phải (`LR`), hỗ trợ zoom/kéo và hiển thị đường găng. Đề bài cho phép chọn giữa `dagre` hoặc `elkjs` và yêu cầu ghi lý do vào tài liệu nếu thêm thư viện.
- **Quyết định**: Bổ sung thư viện `dagre` (và `@types/dagre` trong `devDependencies`) vào `web/package.json`.
- **Lý do chọn dagre thay vì elkjs**:
  1. `dagre` là thư viện JavaScript thuần, nhẹ (~300KB), chạy đồng bộ và tương thích tốt với Vite/React mà không cần cấu hình thêm Web Worker hoặc nạp file nhị phân WASM như `elkjs`.
  2. Hỗ trợ thuật toán Sugiyama chuẩn cho đồ thị có hướng (DAG), hỗ trợ tùy chọn `rankdir: 'LR'` hoàn hảo cho sơ đồ luồng tiến trình từ trái sang phải.
  3. Cung cấp tọa độ tâm `(x, y)` cho từng nút và các điểm bẻ góc `points` cho từng cạnh, giúp render SVG vector sắc nét, dễ dàng điều khiển pan/zoom và tùy biến CSS.
- **Hệ quả**: Bổ sung `dagre` vào dependencies của ứng dụng web, đảm bảo render sơ đồ DAG nhanh chóng, mượt mà và không phát sinh lỗi nạp async trong môi trường kiểm thử Vitest/jsdom.

## DEC-006: Từ chối thao tác ghi ngoài roots của bộ não

- **Bối cảnh**: Bộ não dự án chỉ được phép thay đổi repo dự án và worktree của chính dự án; các đường dẫn reference chỉ phục vụ đọc. Bộ não hệ thống giữ các roots chung của daemon.
- **Quyết định**: `BrainPolicy` trả về `deny` cho Write/Edit ngoài roots được phép, bao gồm cả thao tác ghi vào reference và ghi sang dự án khác. Các thao tác đọc trong reference vẫn được phép.
- **Lý do**: Từ chối rõ ràng an toàn hơn việc trả về `null` để chờ người dùng phê duyệt một thay đổi ngoài phạm vi phiên; phiên bộ não không được tự ý mở rộng phạm vi tác động.



## DEC-007: Ngoại lệ hẹp cho PLAN 2.1 — đọc `access_token` của agy để lấy ảnh đại diện và gói tài khoản

- **Bối cảnh**: PLAN 2.1 cấm đọc nội dung file `antigravity-oauth-token`. Hồ sơ đăng nhập bằng refresh token lấy được ảnh Google lúc nhập, còn hồ sơ đăng nhập qua terminal thì không có cách nào khác để lấy ảnh. Người dùng đã đồng ý mở ngoại lệ (2026-10-21).
- **Quyết định**: Cho phép `readAgyAccessToken()` (`src/profiles/agyToken.ts`) đọc file token, với giới hạn:
  - Chỉ hồ sơ `engine=agy`, `kind=isolated`; không bao giờ chạm keyring hay HOME thật.
  - Chỉ lấy trường `access_token`, và chỉ khi `expiry` còn hạn. **Không** dùng `refresh_token`, **không** tự đổi token, **không** ghi lại file token.
  - Chỉ chạy khi người dùng bấm "Kiểm tra" hồ sơ (`runProfileCheck`) hoặc nút "Làm mới" quota (`refreshUsage`), hoặc ngay khi phiên đăng nhập terminal của hồ sơ đó kết thúc; không chạy nền theo chu kỳ.
  - Access token chỉ được gửi tới `https://www.googleapis.com/oauth2/v3/userinfo` (ảnh đại diện) và `https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist` (gói Google AI: `paidTier.id`/`currentTier.id`, cách Cockpit tools dùng); không log, không lưu DB, không trả qua API. Chỉ lưu kết quả đã chuẩn hoá (`free`/`pro`/`ultra`) vào `profiles.plan`.
  - Nếu email Google trả về khác email của hồ sơ thì bỏ qua ảnh.
- **Hệ quả**: Hồ sơ terminal có ảnh sau lần "Kiểm tra" hoặc "Làm mới" đầu tiên khi token còn hạn (agy làm mới token mỗi lần chạy). Token hết hạn thì giữ ảnh cũ hoặc ảnh chữ cái. Mọi quy tắc khác của PLAN 2.1 giữ nguyên.

## DEC-008: Cho phép xoá mềm hồ sơ keyring của agy

- **Bối cảnh**: Hồ sơ keyring mặc định (`chinh` / `agy-default`) trước đây không xoá được. Người dùng không dùng tài khoản này và muốn bỏ nó khỏi hub (2026-10-21).
- **Quyết định**: `DELETE /api/profiles/:name` chấp nhận hồ sơ `kind=keyring` nhưng chỉ **xoá mềm** (`deletedAt`):
  - Bỏ qua `purgeHome` cho keyring vì `home` là HOME thật; không đụng keyring hệ thống (PLAN 2.1).
  - `registerAll()` vẫn đếm cả hồ sơ đã xoá khi kiểm tra keyring, nên không tự tạo lại `agy-default`.
  - Hồ sơ `kind=system` (Claude) vẫn bị chặn như cũ.
- **Hệ quả**: Popup xoá ẩn ô "Xoá cả thư mục dữ liệu đăng nhập" với hồ sơ keyring và giải thích chỉ ẩn hồ sơ.

## DEC-009: Giới hạn nhận diện externalRef ở đầu câu trong Telegram bot

- **Bối cảnh**: Lệnh Telegram `/newtask <ref> <mô tả>` cho phép nhập mã tham chiếu bên ngoài (`externalRef`) ở đầu câu. Nếu nhận diện các từ chỉ gồm chữ cái không có ký hiệu phân cách (như toàn chữ hoa, camelCase, hoặc từ thường non-ASCII đứng trước từ viết hoa), các mô tả kỹ thuật thông thường như `API timeout khi gọi`, `README cần cập nhật`, `GitHub Actions bị lỗi`, `iPhone crash`, `sửa Login bug` sẽ bị nhận nhầm từ đầu tiên là `externalRef`. Khi project cấu hình template commit có `{ref}`, điều này khiến autocheck commit-message fail trên các commit bình thường.
- **Quyết định**:
  1. Loại trừ token kết thúc bằng dấu câu thông thường (`:`, `,`, `.`, `;`, `!`, `?`) hoặc chỉ là số thứ tự / danh mục (`1.`, `1`).
  2. Chỉ nhận diện token có marker rõ ràng (bắt đầu bằng `#` như `#abc`, `#123` hoặc bao bởi ngoặc vuông `[...]`), hoặc token có ký tự phân tách (`-`, `_`, `#`, `/`, `:`) giữa các thành phần chữ/số (như `PROJ-45`, `OP#123`, `ĐỀ-123`, `営業-1`, `ABC-foo`, `ref:đề`).
  3. Từ chỉ gồm chữ cái không có dấu nối (kể cả chữ hoa, Unicode hay Han/kana như `ĐỀ`, `営業`, `đề`) sẽ không được tự động đoán là `externalRef` nhằm bảo vệ mô tả task thông thường; người dùng muốn đặt ref dạng này cần dùng cú pháp tường minh (`#đề`, `#営業`, `ref:đề` hoặc `ĐỀ-123`, `営業-1`).
- **Hệ quả**: Đảm bảo 100% không nhận nhầm tiêu đề mô tả thường thành ref, đồng thời hỗ trợ đầy đủ mọi ref tự do có marker hoặc dấu nối quy chuẩn.

## DEC-010: Dùng `macos-15-intel` và tạm thời không chặn publish bởi macOS

- **Bối cảnh**: `macos-13` đã bị GitHub bắt đầu loại bỏ và không còn là runner hợp lệ; release cần tạo archive native cho cả Intel và Apple Silicon. Các lỗi cũ trên macOS (PTY, process stats, launchctl) cũng có thể làm archive được phát hành nhưng không cài/chạy được.
- **Quyết định**: Dùng `macos-15-intel` cho archive/smoke Intel và `macos-latest` cho Apple Silicon. Các matrix entry macOS trong `package` và toàn bộ `smoke-macos` tạm thời có `continue-on-error`, để lỗi runner/native không chặn việc phát hành artifact Linux. Khi runner hoạt động, artifact macOS vẫn được gom vào release và được smoke test; nếu macOS fail hoặc runner không tồn tại thì release phải được coi là thiếu bản macOS.
- **Rủi ro/giới hạn**: Worker chỉ kiểm chứng được Linux bằng shim; chưa có bằng chứng từ runner macOS thật trong phiên này. Claude phải chạy lại workflow sau khi push để xác nhận PTY, native `better-sqlite3`, `spawn-helper`, process stats và `launchctl`. Sau khi xác nhận thành công trên cả hai kiến trúc, bỏ `continue-on-error` và đổi quyết định này thành bắt buộc; nếu không, cần tiếp tục ghi rõ việc thiếu artifact macOS trong release notes.

## DEC-011: Quản lý dependency và phân định hai loại worktree tích hợp (merge và deploy)

- **Bối cảnh**:
  - Hệ thống AgentHub hỗ trợ hai cơ chế worktree tích hợp:
    1. **Worktree tích hợp tự quản lý (Hub-managed)**: Kích hoạt khi `settings.integration.enabled = true`. Đường dẫn mặc định là `~/.agenthub/integration/<projectId>` hoặc `<worktree.root>/.integration` (nếu dự án cấu hình `settings.worktree.root`), checkout nhánh tích hợp (mặc định `agenthub/integration`).
    2. **Worktree khai báo thủ công (Legacy/External)**: Khai báo qua trường `worktrees` trong JSON merge (`project.merge.worktrees[baseRef]`), trỏ đến một đường dẫn tuyệt đối bất kỳ ngoài hub.
  - Sự cố ngày 26/10: Dự án cấu hình cả `project.merge.worktrees` ngoài thư mục và `settings.integration.enabled = true`. AgentHub ưu tiên worktree tự quản lý tại `<worktree.root>/.integration` cho merge và deploy. Tuy nhiên, worktree này trước đó không tự động cài `node_modules` (trong khi task worktree có `worktree.install: auto`), dẫn tới việc các merge-check (`npm run lint`, `npm run typecheck`) thất bại với lỗi môi trường `sh: 1: eslint: not found / tsc: not found`, khiến reviewer hiểu nhầm là mã nguồn task bị lỗi.
- **Quyết định**:
  1. **Thống nhất vai trò hai loại worktree**:
     - Worktree tự quản lý (`settings.integration.enabled = true`) là cơ chế tiêu chuẩn và được ưu tiên tuyệt đối cho cả thao tác merge (`mergeTaskIntoBase`), merge-check và post-merge self-deploy (`DeployService.resolveWorktree`).
     - Worktree khai báo trong `project.merge.worktrees` chỉ là cơ chế tương thích ngược (legacy) dành cho các dự án chưa kích hoạt `settings.integration.enabled`. Khi `settings.integration.enabled = true`, cấu hình legacy này không được sử dụng.
  2. **Đồng bộ chính sách cài đặt dependency (`worktree.install`)**:
     - Áp dụng cùng chính sách cài đặt dependency cho worktree tích hợp như worktree của task (`worktree.install`: `auto` dùng cache/hardlink hoặc `npm ci`, `skip` để bỏ qua).
     - Tự động chuẩn bị `node_modules` khi tạo hoặc sử dụng worktree tích hợp (khi bắt đầu task, khi merge, khi deploy).
     - Tự động kiểm tra thay đổi file lock (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `web/package-lock.json`, `web/pnpm-lock.yaml`) sau khi merge commit; nếu có thay đổi thì tự động cài lại dependency trước khi chạy merge-check.
  3. **Kiểm tra nhanh dependency trước merge-check và phân loại lỗi môi trường**:
     - Trước khi chạy merge-check, thực hiện kiểm tra nhanh sự tồn tại của `node_modules` và `node_modules/.bin` đối với các công cụ cần thiết (ví dụ `eslint`, `tsc`). Nếu thiếu, tự động cài trước; nếu không cài được hoặc bị tắt cài đặt, báo lỗi rõ ràng "Worktree tích hợp thiếu dependency".
     - Khi merge-check thất bại do nguyên nhân môi trường (mã thoát 127, tiến trình không tìm thấy, thiếu dependency):
       - Tự động rollback merge commit (về `ORIG_HEAD`) để giữ worktree sạch.
       - Trả về mã lỗi HTTP riêng: `statusCode: 503`, `error: 'environment_error'`.
       - Phát sự kiện `merge.failed` kèm cờ `environment: true`, gửi thông báo Telegram rõ ràng "Lỗi môi trường khi tự động gộp" và ghi chú vào task.
       - Reviewer không coi đây là lỗi của worker và hệ thống không tạo task sửa merge (`<slug>-fix-merge`) để tránh giao việc sai.
- **Hệ quả**:
  - Khắc phục hoàn toàn lỗi thiếu `node_modules` trên worktree tích hợp.
  - Tách biệt rõ ràng trách nhiệm giữa lỗi code do worker và sự cố môi trường hệ thống.

## DEC-012: Di chuyển cấu hình brain của phòng ban sang 'inherit' và thứ tự ưu tiên cấu hình

- **Bối cảnh**:
  - Trước đây, bảng `departments` có các trường `brain*` với mặc định: `brainEngine = 'claude'`, `brainModel = 'sonnet'`, `brainPermissions = 'full'`, `brainMaxTurnsPerHour = 20`. Mọi project đều thuộc phòng ban `chung`.
  - Điều này dẫn đến việc các thiết lập mặc định của phòng ban vô tình đè lên cấu hình toàn cục (`brain.permissions = standard`) và lựa chọn của project (ví dụ cấu hình wizard chọn "sensitive", cấu hình `maxTurnsPerHour` hoặc `dailyTokenBudget`).
  - Do SQLite không lưu lịch sử chỉnh sửa từng cột, không thể phân biệt được giá trị nào do người dùng chủ động sửa tay trùng với giá trị mặc định cũ và giá trị nào do hệ thống tự sinh ra.
- **Quyết định**:
  1. **Thứ tự ưu tiên cấu hình**: Luôn tuân theo thứ tự rõ ràng: **`project > department > global`**.
  2. **Giá trị mặc định**: Mọi trường `brain*` của phòng ban hỗ trợ `'inherit'` (hoặc `0` đối với budget/turns), và mặc định khi tạo mới là `'inherit'`.
  3. **Migration 58**: Đổi toàn bộ các giá trị phòng ban đang bằng giá trị mặc định cũ (`brainEngine = 'claude'`, `brainModel = 'sonnet'`, `brainPermissions = 'full'`, `brainMaxTurnsPerHour = 20`) sang `'inherit'` (và `0` cho turns).
- **Hệ quả**:
  - Project được tôn trọng các thiết lập `maxTurnsPerHour`, `dailyTokenBudget`, `permissions`, `engine`, `model`.
  - Cấu hình phòng ban chỉ ghi đè khi được người dùng chủ động cấu hình khác `'inherit'`.

## DEC-013: Giữ trạng thái waiting_quota và phân biệt lý do chờ bằng waitReason

- **Bối cảnh**:
  - Sự cố ngày 2026-11-03: Ổ `/home` chỉ còn 0,5 GB trống khiến scheduler chuyển các task sang trạng thái `waiting_quota` và hiển thị trên cột Kanban "Chờ quota", dù nguyên nhân thực tế là chờ dung lượng đĩa.
  - Ngoài ra, project agenthub có worktree root nằm trên ổ `/media/veracrypt8` còn 13 GB trống, nhưng cơ chế kiểm tra đĩa cũ quét mọi thư mục worktree (bao gồm `~/.agenthub/worktrees` trên `/home`) và chặn toàn bộ các project như nhau.
- **Quyết định**:
  1. **Giữ nguyên trạng thái `status = 'waiting_quota'`**: Nhằm giảm thiểu tối đa tác động lên schema cơ sở dữ liệu, các truy vấn SQL, REST API, SSE event stream và công cụ MCP hiện hữu.
  2. **Dùng `waitReason` để phân biệt 5 nhóm lý do chờ**:
     - `quota`: Chờ quota model / tài khoản (kèm `no_department_profile`, `no_matching_profile`).
     - `disk`: Chờ dung lượng ổ đĩa (ổ worktree của chính project hoặc ổ dữ liệu hub home).
     - `slot`: Chờ slot song song / tài khoản rảnh (`slot`, `parallel`, `department_parallel`, `profile_busy`).
     - `load`: Chờ tải máy (CPU/RAM/I/O pressure) phục hồi sau khi quá tải.
     - `dependency`: Chờ các task phụ thuộc (`dependsOn`) hoàn thành.
  3. **Đổi tên cột Kanban và nhãn trạng thái**:
     - Cột Kanban cho trạng thái `waiting_quota` đổi tên hiển thị thành "Đang chờ" ("Waiting" trên bản tiếng Anh) thay vì "Chờ quota".
     - Badge trên từng task hiển thị chi tiết theo `waitReason` tương ứng (ví dụ "Chờ ổ đĩa", "Chờ quota model", "Chờ slot song song", "Chờ tải máy giảm", "Chờ task phụ thuộc").
  4. **Kiểm tra đĩa theo từng project**:
     - Khi dispatch, chỉ kiểm tra ổ chứa worktree root của chính project đó cộng các `extraPaths`.
     - Tách riêng việc kiểm tra ổ chứa dữ liệu hub (`~/.agenthub` chứa DB, log, cache) với ngưỡng riêng `disk.hubHomeMinFreeGB` (mặc định 1 GB). Nếu ổ này dưới ngưỡng thì chặn mọi project và thông báo rõ "Ổ chứa dữ liệu hub (~/.agenthub) sắp đầy".
  5. **Telegram và `hub_status`**: Báo cáo chính xác nguyên nhân chờ (ví dụ "đang chờ 3 (3 chờ đĩa)") thay vì hiển thị "chờ quota".
- **Hệ quả**:
  - Đảm bảo tính nhất quán và tương thích ngược của hệ thống.
  - Thông tin hiển thị trên Web, Telegram và MCP phản ánh đúng bản chất lý do chờ của task.

## DEC-014: Ngoại lệ hẹp — đọc `access_token` Codex để lấy quota và gói qua API

- **Bối cảnh**: Quota Codex trước đây chỉ đọc từ log phiên của Codex CLI, nên hồ sơ mới nhập chưa có quota, và hồ sơ đăng nhập qua terminal không có gói. Cockpit tools lấy cả hai qua `GET https://chatgpt.com/backend-api/wham/usage`. Người dùng đồng ý làm giống (2026-10-22).
- **Quyết định**: `readCodexAccessToken()` (`src/quota/codex-api.ts`) được đọc `auth.json`, với giới hạn:
  - Chỉ hồ sơ `engine=codex`, `kind=isolated` (CODEX_HOME do hub quản lý); không đọc `~/.codex` thật.
  - Chỉ lấy `tokens.access_token` và `tokens.account_id`; **không** dùng `refresh_token`/`id_token`, **không** tự làm mới token, **không** ghi lại file.
  - Chỉ chạy khi người dùng bấm "Làm mới" quota (Check xong UI cũng gọi Làm mới); không chạy nền theo chu kỳ.
  - Token chỉ gửi tới endpoint trên (kèm header `ChatGPT-Account-Id`), không log, không lưu DB, không trả qua API. Chỉ lưu quota và `plan_type` đã chuẩn hoá.
- **Hệ quả**: Hồ sơ Codex có quota 5h/tuần và tag gói ngay sau lần Làm mới đầu tiên. Access token hết hạn thì báo HTTP 401 và để Codex tự làm mới khi chạy task. Quota từ log phiên không còn đè lên số mới hơn lấy từ API.

## DEC-015: macOS — hồ sơ agy isolated giả lập phiên SSH để bỏ qua Keychain

- **Bối cảnh**: Mục 2.1 của PLAN chỉ chặn keyring trên Linux, bằng cách đặt `DBUS_SESSION_BUS_ADDRESS` tới một địa chỉ không tồn tại. macOS không dùng DBus. Khi `HOME` của hồ sơ không có `Library/Keychains`, mỗi lần agy lưu phiên thì macOS bật hộp thoại "A keychain cannot be found to store "antigravity"". Nếu người dùng bấm "Reset To Defaults", login keychain thật bị thay bằng một keychain trống.
- **Quyết định**: Gom môi trường của hồ sơ isolated vào `applyIsolatedAgyEnv()` (`src/agy.ts`). Hàm này dùng cho worker, đăng nhập (CLI và PTY), đọc quota và wakeup. Trên `darwin`, hàm đặt thêm `SSH_CONNECTION=127.0.0.1 0 127.0.0.1 0` nếu biến này chưa có. agy 1.4.11 phát hiện phiên SSH và ghi log `Using file-based token storage because SSH session detected` (đã kiểm chứng với HOME tạm, không có token).
- **Hệ quả**: Không còn hộp thoại Keychain cho các hồ sơ isolated. Phiên vẫn được lưu ở `<HOME>/.gemini/antigravity-cli/antigravity-oauth-token`, đúng với cách hub nhận biết trạng thái đăng nhập. Hồ sơ `keyring` (tài khoản mặc định) giữ nguyên env. Nếu agy đổi cách phát hiện SSH, hộp thoại có thể xuất hiện lại và cần kiểm chứng lại.
