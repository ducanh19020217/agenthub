# Quyết định kiến trúc (Decisions Log)

## DEC-OPENPROJECT-TRIAGE

- `manual` là action nội bộ bổ sung cho hợp đồng `do|split|ask|skip`, dùng cho kết luận `việc thủ công`; action này đánh dấu ticket để người dùng tự xử lý và không tạo task sửa.

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

## DEC-016: Xấp xỉ thời gian chờ và tương tác cho timesheet

- `run` được tính theo phần giao giữa thời gian chạy và ngày đang lập bảng.
- `wait` dùng các event trạng thái chờ check/review/merge làm mốc bắt đầu, kéo dài tới mốc kế tiếp hoặc hết ngày, rồi giới hạn không vượt `run`. Đây là xấp xỉ vì schema event hiện chưa lưu khoảng chờ riêng.
- `chat` tính các event review/comment/question/decision/blocked trong ngày; mỗi lượt quy đổi thành 10 phút. Nội dung `## Cần quyết định` trong payload được tính thêm khi event không có type tương ứng.
- Khi nhiều task cùng ticket có level khác nhau, `weight` cộng theo từng task; trường `level` hiển thị là level hiệu dụng (trung bình có trọng số) để khớp với tổng weight.

## DEC-017: Không gán profileName cho các bước trong task.reviewChain

- **Bối cảnh**: Task `t-model-agent-badge` yêu cầu hiển thị agent (engine và profile) cạnh model. Đối với `task.reviewChain`, task quy định: nếu việc lấy `profileName` từ review tương ứng cho từng bước review chain phức tạp thì ghi vào `docs/DECISIONS.md` và bỏ qua, phần UI dùng engine suy từ `reviewer`.
- **Vấn đề**: Bảng `reviews` trong SQLite không lưu `reviewStep`. Hơn nữa, khi một task bị `changes_requested` và scheduler quay lại vòng lặp mới (`reviewStep` được reset về 0), lịch sử review có thể chứa nhiều lượt đánh giá của cùng một loại reviewer qua các vòng. Việc ánh xạ theo chỉ số mảng dẫn tới gán sai profile giữa các bước hoặc giữa các vòng review (như trường hợp chain gồm nhiều bước cùng engine hoặc task lặp lại nhiều vòng).
- **Quyết định**: Không cố gắng suy đoán hoặc gán `profileName` cho các bước của `task.reviewChain` khi trả về API (`profileName` luôn là `null`). API trả về `engine` suy ra từ `step.reviewer` (`codex` nếu bắt đầu bằng `codex:`, `claude` nếu là `claude`). Phần UI `ModelBadge` sử dụng `engine` này và icon tương ứng để hiển thị bên cạnh tên model của bước review. Profile thực tế đã chạy từng review vẫn được hiển thị chính xác và đầy đủ trong mục Lịch sử review (`task.reviews[]`) và Timeline sự kiện.

## DEC-018: Ô review trong sơ đồ Quy trình được coi là đang hoạt động khi có task chờ duyệt

- **Bối cảnh**: Yêu cầu task t-flow-live-animation quy định ô trạng thái "đang hoạt động" gồm `running`, `checking`, và "review khi reviewer đang chạy". Tuy nhiên, view Quy trình (`TaskFlow.tsx`) truy vấn số đếm task theo trạng thái (`useStatusTotal`) và API REST hiện tại không trả về tín hiệu phân biệt liệu một task ở trạng thái `review` có tiến trình reviewer nền đang thực thi hay đang ở hàng chờ / chờ người dùng duyệt qua UI.
- **Quyết định**: Coi ô `review` là "đang hoạt động" (`data-active="true"`, có viền sáng pulse, icon review chớp nhẹ, cạnh luồng animated) mỗi khi tổng số task ở trạng thái `review` > 0 (`total > 0`), đồng bộ với cách xử lý của `running` và `checking`.
- **Hệ quả**: Giữ logic frontend đơn giản, không phát sinh thêm truy vấn kiểm tra subprocess nền của reviewer làm tăng tải API, đảm bảo trải nghiệm người dùng trực quan khi có task ở bước duyệt.

## DEC-019: Cấu hình publish thuộc phạm vi project thay vì hệ thống

- **Bối cảnh**: Tính năng tự động push sau khi hoàn thành task (`t-auto-push-after-done`) cần cấu hình bật/tắt, remote (`origin`), nhánh đích, và tùy chọn push cả nhánh integration.
- **Quyết định**: `publish` được đặt ở cấp độ project (`projects.settings.publish`, tương tự `integration`, `worktree`, `gitea`, `remoteDeploy`) thay vì cấu hình toàn hệ thống (`AgentHubConfig`):
  1. Mỗi git repository có cấu hình remote (`origin`, `upstream`...) và chính sách phân nhánh (default branch, target branch) riêng biệt.
  2. Các preset (`safe`, `balanced`, `auto`) cấu hình cờ `publish.enabled` khi áp dụng cho project: `auto` bật `true`, `safe` và `balanced` để `false`.
  3. Tránh việc một cấu hình remote/nhánh toàn cục gây ảnh hưởng ngoài ý muốn lên các repo khác nhau trong cùng một hub.

## DEC-020: Múi giờ hiển thị thời gian phía web và duy trì tương thích các hàm quota reset

- **Bối cảnh**: `web/src/lib/time.ts` ban đầu cố định `TIME_ZONE = 'Asia/Ho_Chi_Minh'`. Yêu cầu mới đặt ra là giao diện phải hiển thị thời gian theo múi giờ địa phương trên máy của người dùng (trình duyệt). Tuy nhiên, các hàm tính thời điểm reset quota của Claude (`formatReset`, `formatResetCompact`, `formatExpiry`, `formatTimeTitle`) đang phục vụ các component thuộc phạm vi task song song `web-time-format-rest` và có bộ test hiện tại gắn liền với múi giờ Việt Nam.
- **Quyết định**:
  1. Các hàm định dạng thời gian chung mới (`formatDateTime`, `formatTime`, `formatDateTimeWithAgo`) mặc định không truyền `timeZone` cố định vào `Intl.DateTimeFormat`, cho phép sử dụng múi giờ của máy người dùng/trình duyệt. Hỗ trợ tùy chọn `timeZone` trong `opts` để phục vụ unit test và các ngữ cảnh cần cố định timezone.
  2. Các hàm reset quota cũ (`formatReset*`, `formatExpiry`, `formatTimeTitle`) tiếp tục sử dụng `TIME_ZONE = 'Asia/Ho_Chi_Minh'` làm mặc định để giữ nguyên vẹn kết quả test và tương thích với component quota đang do task song song xử lý.
- **Hệ quả**: Đảm bảo hiển thị ngày giờ chuẩn xác theo môi trường người dùng ở các trang chính (Task Detail, Dashboard...) mà không gây xung đột chéo hay phá vỡ test của các tính năng quota.

## DEC-021: Đồng bộ một chiều tài khoản từ Cockpit Tools (t-cockpit-account-sync)

- **Bối cảnh & Bản quyền**: Người dùng quản lý tài khoản qua Cockpit Tools (Rust/Tauri, bản tham chiếu v1.3.81, giấy phép CC BY-NC-SA 4.0). AgentHub chỉ đọc dữ liệu định dạng JSON từ thư mục lưu trữ ngoài (`~/.cockpit_tools` hoặc `~/.antigravity_cockpit` hoặc `COCKPIT_TOOLS_DATA_DIR`), tuyệt đối không sao chép bất kỳ mã nguồn nào của Cockpit Tools vào repo AgentHub.
- **Nguồn tham chiếu từ Cockpit Tools v1.3.81**:
  - `crates/cockpit-core/src/modules/data_paths.rs`: xác định thư mục `DATA_DIR` (`~/.cockpit_tools` và fallback `~/.antigravity_cockpit`).
  - `accounts.json` và `accounts/<id>.json`: cấu trúc Antigravity chứa `email`, `token: { access_token, refresh_token, expires_in }`.
  - `codex_accounts.json` và `codex_accounts/<id>.json`: cấu trúc Codex chứa `email`, `auth_mode`, `tokens: { id_token, access_token, refresh_token }`, `account_id`.
  - `claude_accounts.json` và `claude_accounts/<id>.json` (và logic sync CLI trong `src-tauri/src/modules/claude_account_cli_sync.rs`): cấu trúc Claude chứa `email`, `auth_mode`, `claude_credentials_raw: { claudeAiOauth: { accessToken, refreshToken, subscriptionType } }`.
- **Định dạng Cockpit hỗ trợ & Các trường hợp bỏ qua**:
  - *Antigravity*: Nhập tài khoản OAuth (email + refresh_token). Cho phép đồng bộ lặp lại vì Google OAuth refresh token không bị xoay vòng khi đổi access token. Bỏ qua các envelope token mã hoá kiểu cũ (`account-token.key`, ciphertext) với lý do yêu cầu người dùng mở Cockpit để nâng cấp.
  - *Codex*: Nhập tài khoản `auth_mode = "oauth"`. Bỏ qua tài khoản API key (`auth_mode != "oauth"` hoặc có `openai_api_key`) và tài khoản ChatGPT plan nội bộ của Cockpit (`cockpit_chatgpt_plan`).
  - *Claude*: Nhập tài khoản `auth_mode = "oauth"`. Bỏ qua tài khoản `desktop_oauth` và tài khoản `api_key`.
  - *File hỏng*: Xử lý try/catch độc lập cho từng file tài khoản, đánh dấu `importable: false` kèm `skipReason = "File JSON hỏng"` mà không làm gián đoạn cả phiên quét.
- **Chính sách xoay vòng token (Token Rotation Policy)**:
  - Token OAuth của Codex và Claude có thể bị xoay vòng (refresh token cũ bị thu hồi khi cấp refresh token mới). Nếu cả Cockpit và AgentHub cùng chạy tiến trình refresh độc lập, tài khoản sẽ bị đăng xuất ở một trong hai bên.
  - Vì vậy, hồ sơ Codex và Claude chỉ được **nhập một lần**, đánh dấu `source: 'cockpit'` và `cockpitId`. Các lần sync tiếp theo không ghi đè token của hồ sơ đã tồn tại, chỉ báo `exists` / `skipped`. Giao diện hiển thị cảnh báo rõ ràng cho người dùng.
- **Phương pháp xác thực token Claude**:
  - Không chạy binary `claude` CLI thật trên máy.
  - Sử dụng Anthropic OAuth profile endpoint (`https://api.anthropic.com/api/oauth/profile`) để lấy email, uuid, và subscription/billing plan.
  - Hồ sơ Claude isolated được tạo với `<home>/.credentials.json` (chứa `claudeAiOauth`) và `<home>/.claude.json` với quyền file nghiêm ngặt `0600`.
- **Tính an toàn và bảo mật**:
  - Thư mục Cockpit chỉ đọc (read-only), kiểm tra hash/mtime trước và sau đảm bảo không ghi bất kỳ byte nào vào thư mục Cockpit.
  - API scan chỉ trả về metadata, không trả token ra ngoài.
  - Sự kiện `profile.imported` và log hệ thống tuyệt đối không chứa token hay JWT secret.
  - MCP tool `hub_cockpit_scan` chỉ cung cấp metadata phục vụ tham khảo, không có công cụ import tự động qua MCP.
## DEC-022: Worker sống qua restart service bằng KillMode=process

- systemd unit dùng `KillMode=process` để khi daemon nhận SIGTERM, systemd chỉ quản lý tiến trình chính; worker detached không nằm trong nhóm bị kết thúc khi service restart. `TimeoutStopSec=20` giới hạn thời gian daemon thoát sạch.
- launchd dùng `AbandonProcessGroup=true` với cùng mục tiêu trên macOS.
- `agenthub service upgrade` ghi lại unit/plist hiện hành và thực hiện thao tác reload/activate của platform thông qua luồng cài service. `scripts/run-prod.sh` gọi lệnh này sau mỗi build production.
- Giữ `KillMode=process` thay vì `mixed`: mục tiêu handoff yêu cầu worker không bị SIGTERM/SIGKILL theo vòng đời service manager; scheduler chịu trách nhiệm kill worker chỉ trong luồng người dùng chọn dừng hẳn.

## DEC-023: Cơ chế Pre-publish Audit Gate và quản lý kiểm tra trước khi push

- **Bối cảnh**: Tính năng audit trước khi publish (`t-prepublish-audit`) đảm bảo các thay đổi code được rà soát nghiêm ngặt bằng agent chỉ đọc trước khi đẩy (`git push`) lên remote, tránh đẩy code sai đề bài, ngoài phạm vi, gây lỗi tiềm ẩn (hồi quy), hoặc mất code khi giải xung đột merge (`merge_loss`).
- **Quyết định thiết kế**:
  1. **Bộ nhớ đệm (Cache) audit trong bộ nhớ**:
     - Kết quả audit pass được lưu trong `auditPassCache` dạng `Map<string, PrePublishAuditResult>` theo key `${taskId}:${commitSha}`.
     - Quyết định lưu trong bộ nhớ (in-memory) thay vì database để tối ưu hiệu năng và giữ trạng thái nhẹ nhàng cho daemon. Khi daemon restart, cache được làm sạch tự nhiên; các task chưa push sẽ được audit lại với commit SHA hiện tại nếu cần.
  2. **Bộ đếm vòng sửa audit độc lập**:
     - Thay vì dùng chung và tiêu hao trực tiếp bộ đếm `reviewerChangesRequested` của quy trình review thông thường (vốn có thể khiến task đã qua review bị dừng ngay ở lần audit fail đầu tiên), hệ thống quản lý bộ đếm vòng sửa audit riêng biệt dựa trên bản ghi review `actor: 'audit-prepublish'` trong `reviewRepo` và `pushResult.auditFixRounds`.
     - Cấu hình `maxFixRounds` được giới hạn trong khoảng `1..10` (mặc định 2) thông qua Zod schema nhằm ngăn ngừa worker lặp vô hạn khi không sửa được phát hiện của audit.
  3. **Xác định dải task chưa push và trích xuất diff**:
     - Danh sách task cần audit được xác định dựa trên dải commit chuẩn bị được đẩy lên remote: `remote/target..source` (với `refs/remotes/<remote>/<targetBranch>` được fetch sớm trước khi audit gate chạy). Bất kỳ task nào có commit hoặc branch tip đã là tổ tiên (`--is-ancestor`) của `remote/target` sẽ được bỏ qua vì đã tồn tại trên remote.
     - Trích xuất diff và commit SHA: ưu tiên tìm merge commit của task trên nhánh tích hợp hoặc nhánh đích (`<merge>^1 <merge>`) thông qua `--ancestry-path` hoặc commit message grep. Việc dùng merge commit diff đảm bảo kiểm tra được toàn bộ thay đổi bao gồm cả phần giải xung đột merge (`merge_loss`), đồng thời cung cấp commit SHA ổn định cho cache ngay cả khi nhánh task đã bị xoá. Nếu không có merge commit (ví dụ rebase/fast-forward), fallback về `merge-base..branch`.
     - Giới hạn kích thước diff: diff nhúng vào prompt được cắt tối đa 40.000 ký tự kèm thông báo hướng dẫn agent tự chạy các lệnh đọc an toàn (`git show <commitSha>`, `git diff`) trong repo để tránh tràn context window hoặc timeout.
  4. **Chính sách Fail-Closed và Retryable**:
     - Khi reviewer engine gặp lỗi nội bộ, hết quota, timeout (mặc định 300s, tự động dọn timer và kill process group) hoặc trả về output JSON sai cú pháp, hệ thống dừng publish ngay lập tức (`fail-closed`), đánh dấu `retryable: true` trong `PublishFailedResult` và cập nhật vào `pushResult` của cả task đang audit lẫn task yêu cầu publish mà không tự ý trả task về worker sửa.

## DEC-024: Mặc định bật Publish cho mọi project và cập nhật an toàn working tree local

- **Bối cảnh**:
  - Ban đầu (DEC-019), publish chỉ được bật mặc định cho preset `auto`, còn `safe`, `balanced` và `DEFAULT_PROJECT_SETTINGS.publish` đặt tắt (`enabled: false`).
  - Khi thực tế triển khai, hầu hết project chưa có cấu hình `settings.publish` nên tính năng publish không hoạt động theo kỳ vọng của người dùng.
  - Ngoài ra, việc cập nhật con trỏ nhánh local bằng `git update-ref refs/heads/<target>` khi thư mục làm việc chính (`project.path`) đang checkout đúng nhánh đích sẽ làm lệch giữa con trỏ nhánh và các file thực tế trong working tree, khiến `git status` báo người dùng sửa ngược toàn bộ thay đổi.
- **Quyết định thiết kế**:
  1. **Mặc định bật publish toàn diện**:
     - `DEFAULT_PROJECT_SETTINGS.publish.enabled = true`, cấu hình mặc định kèm `audit: { enabled: true, maxFixRounds: 2 }`, remote `origin`, nhánh đích fallback theo `project.defaultBranch`.
     - Cả 3 preset (`safe`, `balanced`, `auto`) đều đặt `publish.enabled: true`. Riêng `safe` vẫn duy trì yêu cầu duyệt và merge thủ công trước khi publish.
     - Mọi project mới đăng ký (UI, MCP `hub_register_project`, CLI, setup import) đều được bật publish mặc định.
  2. **Migration một lần cho các project hiện hữu**:
     - Hàm `ensureProjectPublishMigration` chạy một lần khi khởi tạo database: duyệt qua toàn bộ project chưa có `settings.publish` để bật mặc định.
     - Project nào đã đặt rõ ràng `publish.enabled = false` (như drone-strike-online) được giữ nguyên tuyệt đối không ghi đè, đồng thời lưu danh sách vào `meta` và phát thông báo qua event/log để người dùng chủ động kiểm tra.
     - Các project không có remote `origin` vẫn bật cấu hình nhưng khi publish sẽ báo lỗi rõ ràng, retryable và không làm crash hệ thống.
     - Việc đồng bộ `publish.enabled: true` ở cả 3 preset và default settings đảm bảo cơ chế `detectProjectPreset` và `effective-config` tính toán chính xác, không biến các project thành `custom`.
  3. **An toàn khi cập nhật nhánh local đang checkout**:
     - Kiểm tra nhánh đang checkout tại `project.path` qua `git symbolic-ref --short HEAD`.
     - Nếu đang ở chính nhánh đích (`targetBranch`):
       - Thư mục sạch (kiểm tra `git status --porcelain -uno`, bỏ qua file untracked): cập nhật bằng `git merge --ff-only <pushedCommit>` thay vì `update-ref`, giúp file trong working tree khớp hoàn toàn với con trỏ nhánh.
       - Thư mục bẩn (có thay đổi tracked đã sửa hoặc staged), hoặc lệnh `merge --ff-only` thất bại: không đụng vào nhánh local, chỉ đẩy lên remote, đánh dấu `pushResult.localUpdate = 'skipped_dirty'` và gửi thông báo cảnh báo đến người dùng.
     - Nếu nhánh đích không được checkout (ở nhánh khác hoặc detached HEAD): tiếp tục dùng `git update-ref` trực tiếp như trước.
  4. **Giao diện & i18n**:
     - Project Settings Drawer hiển thị toggle publish bật mặc định.
     - TaskDetailPage hiển thị banner cảnh báo `publish-skipped-dirty-banner` khi `localUpdate === 'skipped_dirty'`.
     - Thêm đầy đủ chuỗi bản dịch `publishSkippedDirty` cho cả tiếng Việt và tiếng Anh.
