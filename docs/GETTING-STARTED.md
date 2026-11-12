# Bắt đầu với AgentHub

[English](en/GETTING-STARTED.md) | **Tiếng Việt**

## Đổi tên ứng dụng

Vào **Cài đặt → Tên ứng dụng** để đổi tên, tên ngắn, slogan và màu nhấn hiển thị. Có thể đổi nhanh bằng CLI:

```bash
agenthub config set branding.name "Tên mới"
```

Việc này chỉ đổi tên hiển thị. Lệnh `agenthub`, service, thư mục `~/.agenthub`, MCP server, biến môi trường `AGENTHUB_*` và tên gói release vẫn giữ nguyên. Logo PNG/SVG có thể tải lên trong Cài đặt; logo tối đa 256KB và SVG được kiểm tra an toàn.

Hướng dẫn cho người mới: cài AgentHub, kết nối tài khoản AI và giao việc cho các worker.

AgentHub chạy trên máy của bạn. Nó chia việc lập trình cho các worker AI (Gemini qua Antigravity CLI, Codex CLI). Mỗi task chạy trong một git worktree riêng. Hub theo dõi quota, tải máy, dung lượng ổ đĩa và tự chạy kiểm tra (lint, test…) khi worker làm xong. **Claude Code** đóng vai trò "bộ não": lên kế hoạch, giao việc, review và merge.

> **Chọn cách dùng:** Xem [Hai cách dùng AgentHub](USAGE-MODES.md) để chọn hub độc lập qua Web/Telegram hoặc Claude Code qua MCP. Tài liệu đó cũng nêu điều kiện, thiết lập `brain.mode` và vòng làm việc hoàn chỉnh.

## Thiết lập nhanh bằng chat

Mở Dashboard, bấm **Thiết lập bằng chat** ở checklist, trang Thiết lập hoặc Cài đặt. Claude sẽ hỏi từng câu theo [SETUP-PLAYBOOK](setup/SETUP-PLAYBOOK.md), kiểm tra cấu hình hiệu lực, luôn cho xem dry-run diff trước khi ghi và dùng trang nhập bí mật an toàn cho key/token. Bạn có thể dừng bất kỳ lúc nào rồi mở lại phiên setup để tiếp tục.

## Chuyển sang máy mới

Trên máy cũ chạy:

```bash
agenthub setup export --out agenthub-setup.json
```

Chuyển file này sang máy mới (file không chứa token, key, password, secret hoặc đường dẫn tuyệt đối riêng của máy), rồi nói với Claude: “đọc `docs/setup/SETUP-PLAYBOOK.md` và cài theo `agenthub-setup.json`”. Claude sẽ chạy import dry-run, báo project cần clone và chỉ hỏi lại bí mật còn thiếu qua `hub_request_secret`:

```bash
agenthub setup import agenthub-setup.json --dry-run
agenthub setup import agenthub-setup.json
```

---

## 1. Yêu cầu

| Thành phần | Ghi chú |
|---|---|
| **Linux** | Đã kiểm chứng trên Ubuntu. Dùng `/proc`, `nice`/`ionice` và systemd user service. |
| **macOS** | Được hỗ trợ: tiến trình đọc bằng `ps`/`lsof`, ưu tiên chỉ dùng `nice`, trình duyệt dùng `open`, service dùng LaunchAgent. `ionice` và systemd không có trên macOS. |
| **Windows** | Không hỗ trợ trực tiếp. Dùng WSL2 và chạy AgentHub trong môi trường Linux. |
| **Node.js 22** | Installer release tự tải trên macOS/Linux khi PATH chưa có Node; cài thủ công có thể dùng [nvm](https://github.com/nvm-sh/nvm). |
| **git** | Các dự án được giao việc phải là git repository. |
| **Ít nhất một worker CLI** | `agy` (Antigravity CLI, đăng nhập Google) và/hoặc `codex` (Codex CLI, đăng nhập OpenAI). |
| **Claude Code** | Bắt buộc nếu muốn để Claude điều phối (cài extension Claude Code cho VS Code, hoặc CLI `claude`). |
| **Tài nguyên máy** | Mỗi worker có thể build/test nặng. Tham khảo: máy 12 nhân / 15 GB RAM chạy ổn ~4 worker song song. |

### Cài Antigravity CLI (`agy`)

Trong trang **Thiết lập**, bấm **Cài đặt** ở dòng Antigravity CLI để chạy bộ cài chính thức. AgentHub hiển thị log và kiểm tra lại binary sau khi chạy:

```sh
curl -fsSL https://antigravity.google/cli/install.sh | bash
```

Nếu cài xong nhưng AgentHub vẫn báo thiếu `agy`, daemon có thể có PATH khác shell tương tác. Đặt đường dẫn tuyệt đối bằng `AGENTHUB_AGY_BIN=/đường/dẫn/agy` rồi khởi động lại daemon. AgentHub tự dò PATH, `~/.local/bin/agy` và `~/.gemini/bin/agy`; log ở `~/.agenthub/logs/setup-agy.log`.

## 2. Cài đặt

Cách cài đặt một lệnh (hãy đọc script trước khi chạy):

```bash
curl -fsSL https://raw.githubusercontent.com/ducanh19020217/agenthub/main/scripts/install.sh -o /tmp/agenthub-install.sh
less /tmp/agenthub-install.sh
sh /tmp/agenthub-install.sh --from-release
```

Có thể xem trước thao tác bằng `sh /tmp/agenthub-install.sh --dry-run`. Gỡ cài đặt giữ nguyên dữ liệu bằng `sh /tmp/agenthub-install.sh --uninstall`; chỉ dùng `--purge` khi muốn xoá dữ liệu và đã xác nhận.

Gỡ cài đặt:

```bash
sh /tmp/agenthub-install.sh --uninstall
sh /tmp/agenthub-install.sh --uninstall --purge
```

Thử bộ cài trên máy sạch:

```bash
scripts/smoke-install.sh release/agenthub-*.tar.gz
```

Nếu đã có bản phát hành, không cần clone hoặc build mã nguồn:

```bash
sh /tmp/agenthub-install.sh --from-release
agenthub setup
```

Installer kiểm tra `SHA256SUMS`, cài dependencies production theo máy hiện tại, và giữ lại hai bản cũ trong `~/.agenthub-app/` để rollback qua symlink `current`.

Trên macOS, không cần cài Node, nvm hoặc Xcode Command Line Tools để cài từ release. Installer tải Node.js 22 chính thức đúng kiến trúc (`darwin-arm64`/`darwin-x64`), kiểm tra `SHASUMS256.txt` và lưu tại `~/.agenthub/runtime/node-v22.x`. Nếu muốn dùng nvm, truyền rõ `--use-nvm`. Các lỗi thường gặp gồm checksum hỏng, archive sai kiến trúc, thiếu `curl`/`tar`; nếu cài từ source báo thiếu Command Line Tools, chạy `xcode-select --install` rồi chạy lại.

### Cài lỗi thì sao?

Không cần dọn thủ công. Nếu tải, kiểm tra native module, `setup`, symlink hoặc service thất bại, bộ cài tự xoá thư mục tạm và hoàn tác `current`, CLI cùng service về bản trước (nếu có). Chi tiết lỗi được giữ tại `${TMPDIR:-/tmp}/agenthub-install-<time>.log`; hãy gửi file này khi cần hỗ trợ. Bản trước vẫn hoạt động.

```bash
git clone https://github.com/ducanh19020217/agenthub.git ~/agenthub
cd ~/agenthub
source ~/.nvm/nvm.sh && nvm install 22 && nvm use 22

npm ci
npm --prefix web ci
npm run build
npm run build:web

node dist/cli.js link     # tạo lệnh `agenthub` trong ~/.local/bin (đảm bảo thư mục này có trong PATH)
agenthub doctor           # kiểm tra Node, git, agy, codex, cổng 7700
```

Dữ liệu (DB SQLite, token, log, worktree) nằm ở `~/.agenthub/`. Muốn đặt chỗ khác thì dùng biến môi trường `AGENTHUB_HOME`.

## 3. Chạy hub nền và mở dashboard

```bash
agenthub install-service          # Linux: systemd; macOS: ~/Library/LaunchAgents/dev.agenthub.plist
agenthub stop                     # tắt êm, task đang chạy sẽ resume
agenthub stop --disable           # tắt và không tự bật khi đăng nhập
agenthub start                    # bật lại
agenthub restart                  # yêu cầu khởi động lại khi rảnh, giữ worker đang chạy
agenthub restart --now             # khởi động lại ngay (cảnh báo: dừng worker)
agenthub restart --when-idle --wait # chờ đến khi drain hoàn tất
# Đóng tab web không tắt hub; uninstall-service là gỡ service.
loginctl enable-linger "$USER"    # (tuỳ chọn) chạy cả khi chưa đăng nhập màn hình
systemctl --user status agenthub  # kiểm tra đang chạy

agenthub open                     # mở http://127.0.0.1:7700/#token=...
```

`agenthub restart` mặc định chờ hub rảnh; thêm `--wait` để chờ lệnh kết thúc drain. Chỉ dùng `--now`/`--force` khi chấp nhận dừng worker đang chạy. `./scripts/run-prod.sh --restart` và `./scripts/stop-prod.sh` cũng dùng drain mặc định, còn `--force` là dừng ngay.

Nếu service đã được cài trước phiên bản hỗ trợ restart an toàn, chạy lại `agenthub install-service` (hoặc `./scripts/run-prod.sh --build-only` rồi `node dist/cli.js install-service`) để unit systemd nhận `KillMode=process`; sau đó kiểm tra bằng `systemctl --user cat agenthub`. Không cần restart worker đang chạy để cập nhật unit, vì drain sẽ tự khởi động lại hub khi rảnh.

- Dashboard chỉ nghe ở `127.0.0.1` và cần token (lấy bằng `agenthub open --no-browser`).
- Xem dashboard từ máy khác: **dùng SSH tunnel**, không mở cổng ra mạng:
  `ssh -L 7700:127.0.0.1:7700 user@may-chay-hub` rồi mở `http://127.0.0.1:7700/#token=...` trên máy của bạn.
- Cập nhật phiên bản mới: `git pull && npm ci && npm --prefix web ci && npm run build && npm run build:web && ./scripts/run-prod.sh --restart` (mặc định restart khi rảnh; dùng `--force` nếu cần dừng ngay).

## 4. Kết nối tài khoản worker (Gemini, Codex)

Mở **Tài khoản (Profiles)**, bấm **Thêm tài khoản**, chọn nhà cung cấp và nhập tên. Dashboard mở trình hướng dẫn cạnh terminal; mỗi bước sẽ được đánh dấu theo output terminal.

- **Antigravity (Gemini):** Hub chọn `Google OAuth` trong menu `agy` (nếu menu còn hiện, bấm Enter). Bấm **Mở trang đăng nhập Google**, đăng nhập đúng tài khoản muốn thêm. Khi Google chuyển tới `antigravity.google`, copy mã xác thực, dán vào ô mã trên dashboard và bấm **Gửi**. Chờ thông báo đăng nhập thành công; Hub tự đọc email. Mã chỉ có hiệu lực khoảng 60 giây, nên bấm **Đăng nhập lại** nếu hết hạn. Dùng tài khoản Google khác các hồ sơ hiện có để có quota riêng.
- **Codex (OpenAI):** Hub chạy `codex login --device-auth`. Mở link, đăng nhập ChatGPT, copy mã thiết bị hiển thị trên dashboard và dán vào ô mã; chờ xác nhận.

Trạng thái hồ sơ gồm **Đã đăng nhập**, **Chưa đăng nhập**, **Cần xác minh** và **Lỗi**. Thẻ cũng hiển thị quota 5 giờ/tuần, task đang chạy, cảnh báo trùng email và menu **Kiểm tra**, **Sửa**, **Đổi tên**, **Xoá**. Xoá có thể giữ lại hoặc xoá cả thư mục dữ liệu đăng nhập.

Nếu không thấy link, kiểm tra terminal đầy đủ và dùng **Kết nối lại**. Nếu mã hết hạn, bấm **Đăng nhập lại**; nếu tài khoản cần xác minh, mở link xác minh trên thẻ rồi bấm **Kiểm tra**. Khi thấy cảnh báo trùng email, đăng nhập lại bằng tài khoản Google khác.

### Accounts & provider terms

Mặc định AgentHub chỉ cho một hồ sơ **personal** trên mỗi engine để tránh khuyến khích xoay vòng nhiều tài khoản cá nhân nhằm vượt giới hạn. Hồ sơ **API key** và **Team** vẫn được phép thêm. Nếu bật `multiplePerProvider`, dashboard sẽ cảnh báo và bạn chịu trách nhiệm tuân thủ điều khoản của nhà cung cấp; nhiều gói cá nhân cấm chia sẻ hoặc vượt giới hạn. Khi dùng chung, nên ưu tiên API key hoặc gói Team thay vì nhiều gói cá nhân.

## 5. Đăng nhập tài khoản Claude

Claude đóng vai trò là "bộ não điều phối" (Brain) của AgentHub: tiếp nhận yêu cầu từ bạn, chia nhỏ thành các task độc lập, giao việc cho các worker AI (Gemini, Codex), theo dõi tiến độ và review nghiệm thu mã nguồn.

### Thư mục lưu trữ biệt lập
Mỗi hồ sơ Claude được lưu trữ độc lập tại:
```
~/.agenthub/claude-homes/<tên_hồ_sơ>/
```
Thư mục được bảo vệ tự động với quyền `0700` (chỉ user hiện tại có quyền truy cập), chứa file cấu hình `.claude.json` và chứng thực `.credentials.json`.

### Cách tạo và đăng nhập hồ sơ Claude

1. **Qua Web Dashboard (khuyến nghị)**:
   - Vào mục **Tài khoản (Profiles)**, bấm **Thêm tài khoản**.
   - Chọn nhà cung cấp **Claude**, nhập tên hồ sơ (ví dụ: `claude-main` hoặc `claude-work`) và chọn loại tài khoản (`personal`, `team`, hoặc `api_key`).
   - Bấm **Tạo & Đăng nhập**. Dashboard sẽ mở cửa sổ terminal tương tác PTY và tự động gửi lệnh `/login`.
   - Chọn loại gói tài khoản Claude (Claude Pro / Team / Enterprise).
   - Nhấp vào đường link đăng nhập được cung cấp để mở trình duyệt, đăng nhập vào tài khoản Anthropic của bạn.
   - Sao chép mã ủy quyền xác thực (OAuth authorization code), dán vào ô nhập trên dashboard và bấm **Gửi**.
   - Chờ terminal hoàn tất xác thực; Hub sẽ tự động đọc email tài khoản và cập nhật trạng thái **Đã đăng nhập**.

2. **Qua CLI**:
   ```bash
   # Tạo hồ sơ Claude mới
   agenthub profile add claude-main --engine claude

   # Mở phiên đăng nhập tương tác
   agenthub profile login claude-main
   ```

### Nhận diện trạng thái tự động
Hệ thống tự động kiểm tra định kỳ tính hợp lệ của token đăng nhập. Thẻ hồ sơ Claude trên trang **Profiles** hiển thị:
- **Đã đăng nhập**: Hiển thị địa chỉ email gắn với tài khoản.
- **Chưa đăng nhập**: Phiên đăng nhập hết hạn hoặc chưa hoàn tất, kèm nút **Đăng nhập** nhanh.
- **Thao tác quản lý**: Hỗ trợ **Kiểm tra** kết nối, **Đổi tên** hồ sơ, hoặc **Xoá** hồ sơ (có tùy chọn giữ lại hoặc xóa sạch thư mục dữ liệu).

## 6. Đăng ký dự án (Thêm dự án)

Trong AgentHub, một **project** là một git repository trên máy của bạn. Khi AI worker (Gemini hoặc Codex) nhận task, hub sẽ tự động tạo một git worktree riêng (nhánh `agenthub/<slug>`), giúp worker làm việc độc lập mà hoàn toàn không đụng vào thư mục hoặc nhánh bạn đang code dở.

### 3 bước thêm dự án:

1. **Chuẩn bị repo**: Clone repo về máy (nếu chưa có). Đảm bảo repo đã được khởi tạo git và có nhánh mặc định (như `main`).
2. **Đăng ký project vào hub**:
   - **Đưa dự án có sẵn vào hub**: Truy cập trang **Projects**, mở **Trình hướng dẫn đăng ký**, chọn **Repo có sẵn trên máy**, nhập đường dẫn tuyệt đối rồi để AgentHub dò nhánh, lockfile, hooks, ngôn ngữ, tài liệu hướng dẫn và các phiên Claude Code cũ. Kiểm tra các gợi ý trước khi tạo; phần **Nâng cao** vẫn cho phép điền tay.
   - **Tạo dự án mới**: Trong cùng trình hướng dẫn, chọn **Dự án mới**. AgentHub sẽ tạo thư mục mới, chạy `git init`, tạo commit rỗng và nhánh mặc định ngay trên máy trước khi đăng ký project.
   - Luôn kiểm tra đường dẫn và nhánh gốc. Nhánh tích hợp (nếu bật) chỉ được hub merge local, không bao giờ tự push.
   - **Hoặc qua CLI**:
     ```bash
     agenthub project add <tên> /đường/dẫn/tuyệt/đối/tới/repo
     ```
3. **Giao việc**: Sau khi đăng ký, bạn có thể giao task cho worker qua lệnh `/newtask` trên Telegram, qua khung chat với Claude trên Web Dashboard, hoặc tạo trực tiếp trên trang **Tasks**.

### Các trường cấu hình trong form đăng ký:

- **Tên Project (Name)**: Tên hiển thị của dự án (hệ thống tự động sinh ID dự án từ tên này).
- **Đường dẫn Git repo (Path)**: Đường dẫn tuyệt đối tới thư mục gốc repo git trên máy của bạn. Thư mục này bắt buộc phải tồn tại và là một git repository hợp lệ.
- **Nhánh mặc định (Default Branch)**: Nhánh cơ sở (mặc định là `main`) để worker tách nhánh công việc ra và merge kết quả về sau khi được duyệt. Nhánh này phải tồn tại trong repo.
- **Giới hạn worker song song (maxParallel)**: Số lượng task tối đa được phép chạy cùng lúc cho dự án này (mặc định: 3).

### Mục Nâng cao (Advanced - thu gọn mặc định):

- **Mẫu biến môi trường (`envTemplate` - định dạng JSON)**: Cấu hình tạo file `.env` riêng biệt cho từng worktree, giúp các worker chạy song song mà không bị xung đột cổng mạng hoặc trùng cơ sở dữ liệu. Hỗ trợ các biến thay thế:
  - `{slot}`: Số thứ tự slot worker (1 đến 9).
  - `{slug}`: Mã định danh của task (vd: `add-login`).
  - `{slug_underscored}`: Mã task thay gạch ngang bằng gạch dưới (vd: `add_login`).

  *Ví dụ `envTemplate`:*
  ```json
  {
    "PORT": "300{slot}",
    "DATABASE_URL": "postgresql://postgres:postgres@localhost:5432/myapp_t_{slug_underscored}"
  }
  ```

- **Kiểm tra tự động (`checks` - JSON array)**: Danh sách lệnh kiểm tra tự động chạy sau khi worker hoàn thành (ví dụ `lint`, `test`):
  ```json
  [
    { "name": "lint", "cmd": ["npm", "run", "lint"] },
    { "name": "test", "cmd": ["npm", "test"] }
  ]
  ```

- **Hooks `onWorktreeRemoved`**: Các lệnh dọn dẹp chạy sau khi xoá worktree (ví dụ: `docker exec my_postgres psql -U user -d postgres -c "DROP DATABASE IF EXISTS myapp_t_{slug_underscored}"`).
- **Merge tự động**: Khai báo worktree tích hợp cho từng nhánh đích và các lệnh kiểm tra sau merge (vd. `pnpm lint`, `pnpm typecheck`). Khi duyệt kèm merge, hub merge nhánh task, chạy kiểm tra và tự hoàn tác nếu xung đột hoặc kiểm tra thất bại.

> **Quy ước dự án**: Trong repo dự án nên có file `AGENTS.md` mô tả quy ước (cách chạy, cách test, những gì không được làm). Worker đọc file này trước khi làm việc.

## 7. Điều khiển hub: Web Dashboard, Telegram và Claude Code trong VS Code

Chi tiết lựa chọn giữa hai mô hình và cách kết hợp theo từng project nằm trong [USAGE-MODES.md](USAGE-MODES.md). Phần dưới đây giữ lại tham chiếu lệnh MCP và hướng dẫn Telegram cụ thể.

Bạn có thể tương tác và điều khiển Claude theo 3 phương thức linh hoạt:

### 7.1 Trò chuyện trực tiếp trên Web Dashboard

Khung chat trên Web Dashboard cho phép bạn trao đổi trực tiếp với Claude Code mà không cần rời trình duyệt:

1. Nhấp vào mục **Trò chuyện** (Chat) trên thanh điều hướng hoặc biểu tượng Brain.
2. **Chọn Model & Chế độ**:
   - Model: `sonnet` (suy luận sâu, phù hợp điều phối task phức tạp) hoặc `haiku` (phản hồi nhanh, tiết kiệm quota).
   - Chế độ: **An toàn (`safe`)** (mặc định — chỉ dùng MCP an toàn và các lệnh đọc kiểm tra) hoặc **Đầy đủ (`full`)** (toàn quyền thực thi, cần bật `chat.allowFullMode: true` trong cấu hình).
3. **Quản lý phiên hội thoại**:
   - Danh sách phiên bên cạnh hỗ trợ tìm kiếm, ghim phiên quan trọng lên đầu, đổi tên, lưu trữ và xoá có hộp thoại xác nhận.
   - Nút **Xuất Markdown**: tải toàn bộ lịch sử trao đổi của phiên ra file `.md`.
   - Danh sách tin nhắn ảo hóa (virtualized) với cơ chế cuộn tải dần lịch sử (`before=`) mượt mà.
4. **Duyệt quyền công cụ (Tool Permissions)**:
   - Khi Claude cần chạy công cụ hoặc lệnh ngoài danh mục an toàn, hộp thoại xin quyền tương tác sẽ xuất hiện trực tiếp trong khung chat với 3 lựa chọn: **Cho phép**, **Luôn cho phép** (ghi nhớ cho lệnh tương tự trong phiên) hoặc **Từ chối**.
   - Watchdog tự động tạm dừng đếm thời gian im lặng khi đang chờ bạn đưa ra quyết định, không lo bị timeout.
5. **Nén ngữ cảnh & Mở phiên tóm tắt**:
   - Khung **ContextMeter** hiển thị trực quan số token bối cảnh hiện tại.
   - Nút **Nén ngữ cảnh** (`/compact`): yêu cầu Claude tinh gọn ngữ cảnh để tiếp tục phiên dài.
   - Nút **Mở phiên mới kèm tóm tắt** (`/fork-summary`): Claude tóm tắt kết quả phiên hiện tại và khởi tạo một phiên chat mới sạch sẽ với bản tóm tắt làm bối cảnh đầu vào.
   - Tự động nén: Hệ thống tự động kích hoạt nén khi bối cảnh vượt ngưỡng `autoCompactPercent` (mặc định 85% của 200.000 tokens).

### 7.2 Điều khiển qua Claude Code trong VS Code (MCP)

Nếu bạn quen làm việc trong VS Code hoặc terminal:

1. Đăng ký MCP server của hub với Claude Code (chỉ cần chạy một lần):
   ```bash
   agenthub mcp-install            # = claude mcp add --scope user agenthub -- node .../dist/cli.js mcp
   ```
2. Mở thư mục dự án trong **VS Code**, mở khung **Claude Code**.
3. Nói với Claude bằng ngôn ngữ tự nhiên. Claude dùng các công cụ MCP sau:

| Công cụ | Dùng để |
|---|---|
| `hub_status`, `hub_tasks`, `hub_task`, `hub_task_log` | Xem tình trạng hub, danh sách task, chi tiết và log |
| `hub_create_task`, `hub_update_task` | Tạo task (đề bài, nhánh gốc, model, phụ thuộc), sửa đề bài/phụ thuộc |
| `hub_review` | Duyệt (`approved`, kèm merge nếu đã cấu hình) hoặc trả về (`changes_requested` + nhận xét) |
| `hub_retry`, `hub_cancel` | Chạy lại task lỗi/bị chặn, huỷ task (`hub_cancel` bắt buộc có `reason`, hiện ở trang chi tiết task) |
| `hub_wait` | Chờ đến khi có task cần review |
| `hub_projects`, `hub_register_project`, `hub_profiles`, `hub_mark_quota` | Quản lý dự án, tài khoản, đánh dấu hết quota |
| `hub_git`, `hub_savings`, `hub_claude_usage`, `hub_brain` | Xem git của task, thống kê tiết kiệm token, mức dùng Claude |

Câu lệnh mẫu:

- *"Đọc docs/PLAN.md, chia giai đoạn 2 thành các task nhỏ chạy song song rồi giao cho hub."*
- *"Có task nào chờ review không? Review và merge những task đạt, task chưa đạt thì trả về kèm lỗi cụ thể."*
- *"Task X chạy lâu quá, xem log và xử lý."*

Không có Claude Code thì vẫn tạo task tay được: trang **Tasks → Tạo task** trên dashboard, hoặc `agenthub task add`.

## 8. Điều khiển từ xa qua Telegram

AgentHub tích hợp bot Telegram cho phép bạn giám sát tiến độ, duyệt code và trò chuyện với Claude từ điện thoại ở bất kỳ đâu.

### Bước 1: Tạo bot với @BotFather
1. Mở ứng dụng Telegram, tìm kiếm tài khoản chính thức **`@BotFather`**.
2. Gửi lệnh `/newbot`.
3. Nhập tên hiển thị cho bot (ví dụ: `MyAgentHubBot`).
4. Nhập username cho bot (phải kết thúc bằng chữ `bot`, ví dụ: `my_agenthub_remote_bot`).
5. `@BotFather` sẽ gửi lại mã HTTP API token (dạng: `123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ`).

### Bước 2: Cấu hình Token vào AgentHub
- **Cách 1: Qua Web Dashboard**:
  Mở trang **Settings**, cuộn đến mục **Telegram Bot**, dán Bot Token vào ô nhập và bấm **Lưu token**.
- **Cách 2: Lưu vào file**:
  ```bash
  mkdir -p ~/.agenthub/secrets
  echo "YOUR_BOT_TOKEN_HERE" > ~/.agenthub/secrets/telegram.token
  chmod 0600 ~/.agenthub/secrets/telegram.token
  ```
- **Khai báo cấu hình trong `~/.agenthub/config.json`**:
  ```json
  {
    "telegram": {
      "enabled": true,
      "botTokenFile": "~/.agenthub/secrets/telegram.token",
      "allowedChatIds": [],
      "notify": {
        "reviewReady": true,
        "failed": true,
        "blocked": true,
        "quota": true,
        "fallback": true
      }
    }
  }
  ```

### Bước 3: Ghép đôi thiết bị (Pairing flow)
Để đảm bảo an toàn tuyệt đối, bot chỉ phản hồi các cuộc trò chuyện đã ghép đôi thành công:
1. Vào trang **Settings** trên Web Dashboard, tìm mục Telegram và bấm **Tạo mã ghép đôi** (hoặc gọi API `POST /api/telegram/pair-code`).
2. Hệ thống tạo một mã xác thực 6 chữ số ngẫu nhiên (hiệu lực trong 5 phút).
3. Mở cuộc trò chuyện với bot trên Telegram, bấm **Start** hoặc gửi trực tiếp mã 6 số (hoặc cú pháp `/start <mã>` / `/pair <mã>`).
4. Bot phản hồi thông báo ghép đôi thành công và lưu `chatId` của bạn vào danh sách cho phép.

### Danh sách lệnh Telegram

| Lệnh | Mô tả |
|---|---|
| `/status` | Xem tổng quan trạng thái hệ thống: task đang chạy/chờ, CPU/RAM, ổ đĩa, quota các tài khoản |
| `/tasks [trạng thái]` | Liệt kê danh sách task (ví dụ: `/tasks review`, `/tasks running`, `/tasks failed`) |
| `/task <id>` | Xem chi tiết task: đề bài, kết quả kiểm tra autocheck, link xem trên dashboard |
| `/log <id>` | Xem 30 dòng log thực thi mới nhất của task |
| `/approve <id>` | Duyệt task hoàn thành (tự động merge nếu dự án đã cấu hình worktree merge) |
| `/reject <id> <nhận xét>` | Trả về task kèm nhận xét yêu cầu worker chỉnh sửa |
| `/cancel <id>` | Hủy task (hiển thị nút inline xác nhận an toàn trước khi hủy) |
| `/retry <id>` | Chạy lại task bị lỗi (`failed`) hoặc bị chặn (`blocked`) |
| `/pause` | Tạm dừng giao task mới cho worker (task đang chạy vẫn tiếp tục) |
| `/resume` | Tiếp tục giao task mới cho worker |
| `/new` | Khởi tạo phiên trò chuyện mới với Claude |
| `/stop` | Dừng lượt phản hồi hiện tại của Claude |
| `/help` | Hiển thị hướng dẫn và danh sách lệnh |

*Ghi chú: `<id>` có thể là `slug` ngắn (nếu không trùng) hoặc dạng đầy đủ `project/slug`.*

### Chat với Claude & Duyệt quyền bằng nút bấm
- **Chat tự nhiên**: Mọi tin nhắn văn bản thông thường (không bắt đầu bằng dấu `/`) gửi đến bot sẽ được chuyển tiếp trực tiếp vào phiên chat Claude (`telegram:<chatId>`). Bạn có thể giao việc, nhờ giải thích code hay yêu cầu điều phối task ngay trên điện thoại.
- **Duyệt quyền bằng nút bấm**: Khi Claude cần thực thi lệnh kiểm tra hoặc chạy công cụ, bot tự động gửi tin nhắn xin quyền kèm 3 nút inline: **Cho phép**, **Luôn cho phép** và **Từ chối**. Bạn chỉ cần bấm nút trực tiếp trên Telegram.
- **Nút thao tác nhanh**: Khi có thông báo task hoàn thành kiểm tra (`reviewReady`), tin nhắn Telegram đi kèm các nút inline: **Duyệt**, **Trả về** và **Xem log**.

### Bảo mật của Telegram Bot
- **Chỉ chat đã ghép đôi mới có quyền điều khiển**: Mọi tin nhắn từ người dùng lạ chưa ghép đôi đều bị từ chối (`🚫 Bạn chưa được phép điều khiển bot này`) và ghi log cảnh báo.
- **Token lưu với quyền 0600**: File token bot chỉ cho phép user hiện tại đọc/ghi (`chmod 0600`).
- **Che giấu token an toàn**: Token không bao giờ lưu trong cơ sở dữ liệu `hub.db`, không xuất hiện trong log và không trả về qua API (chỉ báo `{ configured: true }`).

## 9. Chuỗi dự phòng khi hết token (Claude Fallback Chain)

Khi tài khoản Claude chính gặp giới hạn tốc độ (rate limit / HTTP 429) hoặc hết hạn mức sử dụng (usage limits), AgentHub không làm gián đoạn luồng làm việc mà tự động kích hoạt **Chuỗi dự phòng (Fallback Chain)** được cấu hình trong `brain.fallback`.

### Các bước dự phòng hỗ trợ

1. **Đổi hồ sơ Claude (`profile`)**:
   `{ "type": "profile", "profile": "claude-team" }`  
   Chuyển sang một hồ sơ Claude dự phòng khác đã đăng nhập (ví dụ tài khoản Team hoặc tài khoản phụ). Nếu bỏ trống `profile`, hub sẽ tự động tìm hồ sơ Claude bất kỳ đang ở trạng thái đã đăng nhập và kích hoạt.

2. **Hạ cấp model (`model`)**:
   `{ "type": "model", "model": "haiku" }`  
   Tạm thời hạ từ `sonnet` xuống model nhẹ hơn như `haiku` để tiếp tục điều phối với mức tiêu tốn quota thấp hơn.

3. **Anthropic API Key (`apiKey`) có trần chi phí**:
   `{ "type": "apiKey", "dailyCapUSD": 5 }`  
   Tạm thời chuyển sang dùng API key trả tiền trực tiếp cho Anthropic khi hết hạn mức thuê bao.

   > [!WARNING] **Cảnh báo chi phí API key**
   > Khác với các gói thuê bao cố định tháng (Claude Pro / Team), Anthropic API key tính phí trực tiếp trên từng token gửi nhận (pay-as-you-go). Nếu không kiểm soát, chi phí có thể tăng nhanh khi task nặng.
   > AgentHub bảo vệ bạn bằng cách **bắt buộc thiết lập trần chi phí mỗi ngày** (`dailyCapUSD`, ví dụ tối đa 5 USD/ngày). Khi chi phí trong ngày đạt ngưỡng trần, hệ thống tự động khóa bước API key và chuyển tiếp sang bước dự phòng tiếp theo trong chuỗi.
   > Token API key được lưu biệt lập tại `~/.agenthub/secrets/anthropic.key` với quyền bảo mật nghiêm ngặt `0600`, không bao giờ hiển thị trên API hay giao diện web (chỉ hiển thị cờ `apiKeyConfigured: true`).

4. **Codex CLI reviewer / engine (`engine`)**:
   `{ "type": "engine", "engine": "codex" }`  
   Kích hoạt OpenAI Codex CLI (ở chế độ chỉ đọc `readOnly: true`) để đảm nhận vai trò review code hoặc điều phối dự phòng.

5. **Chờ mở khóa hạn mức (`wait`)**:
   `{ "type": "wait" }`  
   Tạm dừng hệ thống và chờ đến thời điểm mở khóa quota tiếp theo của Claude (`resetAt`).

### Ví dụ cấu hình trong `~/.agenthub/config.json`

```json
{
  "brain": {
    "fallback": [
      { "type": "profile", "profile": "claude-team" },
      { "type": "model", "model": "haiku" },
      { "type": "apiKey", "dailyCapUSD": 5 },
      { "type": "engine", "engine": "codex" },
      { "type": "wait" }
    ]
  }
}
```

Để xem dashboard từ thiết bị trong LAN, có thể cấu hình bind address và các hostname/IP được phép:

```json
{
  "host": "0.0.0.0",
  "allowedHosts": ["192.168.111.15"]
}
```

Hai biến môi trường tương ứng là `AGENTHUB_HOST` và `AGENTHUB_ALLOWED_HOSTS` (phân tách bằng dấu phẩy). Mặc định daemon chỉ bind `127.0.0.1`; chỉ bật LAN khi cần, khai báo địa chỉ cụ thể và không chia sẻ bearer token.

Bạn cũng có thể xem trạng thái bước fallback hiện tại, chi phí tiêu thụ trong ngày và cấu hình trực quan trên trang **Settings** của Web Dashboard.

## 10. Vòng đời một task

`queued` → `running` (worker làm trong worktree riêng, commit theo bước) → worker tạo `.agenthub/DONE` (hoặc `BLOCKED`) → `checking` (hub chạy kiểm tra tự động) → `review` → Claude/bạn **duyệt & merge** hoặc **trả về** (task chạy lại với nhận xét) → `done`.

Nhãn chờ trên dashboard:

- **Chờ slot song song**: dự án đã chạy đủ `maxParallel` task.
- **Chờ tài khoản rảnh**: mọi tài khoản phù hợp đang bận.
- **Chờ ổ đĩa**: ổ worktree hoặc ổ Docker dưới ngưỡng.
- **Chờ quota model**: tài khoản hết lượt.

## 11. Cấu hình bảo vệ máy (khuyến nghị bật)

Trang **Settings** (hoặc `PUT /api/config`):

```json
{
  "load": { "enabled": true, "high": 16, "ok": 11, "pressureHigh": 20, "pressureIoHigh": 40, "pressureOk": 10, "minFreeMemGB": 1.5, "recoverAfterSec": 300 },
  "disk": {
    "minFreeGB": 3,
    "extraPaths": [{ "path": "/var/lib/docker", "minFreeGB": 1.5, "label": "Docker" }]
  },
  "defaultTimeout": 5400,
  "multiplePerProvider": false
}
```

- **load**: máy quá tải thì tạm giảm mỗi dự án xuống 1 task. `pressureIoHigh` mặc định là 40% và I/O PSI chỉ được coi là quá tải khi memory PSI đồng thời đạt `pressureOk` (mặc định 10%); I/O nền thấp hơn ngưỡng không đánh thức brain. Máy ổn định đủ `recoverAfterSec` thì trả lại.
- **disk**: ổ dưới ngưỡng thì không giao task mới. Thêm ổ chứa dữ liệu Docker nếu dự án dùng Docker.
- **defaultTimeout**: giới hạn thời gian mỗi lượt chạy (giây). Ngoài ra hub cảnh báo khi task chạy lâu mà không commit, hoặc khi chạy lặp lại một lệnh.

Worker và lệnh kiểm tra chạy với ưu tiên thấp (`nice`/`ionice` trên Linux, chỉ `nice` trên macOS), nên IDE và trình duyệt của bạn vẫn mượt.

## 12. Hạn chế và lưu ý

- **Quyền hạn khi chat**: Khung chat mặc định chạy ở chế độ An toàn (`safe`). Khi Claude cần chạy lệnh công cụ, bạn có thể bấm phê duyệt trực tiếp trên giao diện chat hoặc qua Telegram. Nếu muốn cấp quyền rộng hơn, bạn có thể bật `chat.allowFullMode: true` trong cấu hình.
- **Chế độ dự phòng:** Khi Claude hết quota, chuỗi dự phòng `brain.fallback` tự động kích hoạt. Nếu chuyển sang reviewer Codex, các task được duyệt bởi Codex **không tự động merge**, bạn cần kiểm tra lại và thực hiện merge các task đó.
- Chỉ hỗ trợ chạy cục bộ, một người dùng. Dashboard không có phân quyền nhiều người.
- Worker được chạy với quyền cao trong worktree. Chỉ giao việc cho repo bạn tin tưởng, không đưa secret thật vào `.env` mẫu.
- **Không cho worker chạy `docker build/pull`** trên máy có ổ Docker gần đầy: đầy ổ có thể làm sập Postgres của các dự án khác.

## 13. Xử lý sự cố nhanh

| Hiện tượng | Cách xử lý |
|---|---|
| Dashboard trắng/không vào được | `systemctl --user status agenthub`, xem `~/.agenthub/logs/daemon.out` |
| Task đứng ở "chờ" lâu | Xem nhãn lý do chờ (mục 10). Kiểm tra dung lượng đĩa, tải máy, quota trên Dashboard |
| Máy chậm | Giảm `maxParallel`. Kiểm tra tiến trình mồ côi trên Dashboard (nút "Dọn") |
| Worker báo thiếu thư viện | Hub tự chạy `pnpm/npm install` khi tạo worktree. Nếu lỗi, xem log run của task |
| Task chạy lặp, không commit | Huỷ, rồi tạo lại với phạm vi hẹp hơn và yêu cầu commit sau mỗi bước |
| Telegram bot không phản hồi | Kiểm tra token trong `secrets/telegram.token` và xác thực ghép đôi trên Dashboard |

Xem thêm: [USAGE.md](USAGE.md) (quy trình chi tiết), [FEATURES.md](FEATURES.md) (danh sách tính năng), [PLAN.md](PLAN.md) (kiến trúc).

## 14. Tự triển khai sau merge

Các bước deploy chỉ được khai báo trong `~/.agenthub/config.json`, không qua API/MCP. Ví dụ cho chính repo AgentHub:

```json
{
  "deploy": {
    "agenthub": {
      "steps": [["npm", "run", "build"], ["npm", "run", "build:web"], ["node", "scripts/install-web.mjs"]],
      "timeoutSec": 900,
      "restartHub": true,
      "push": {
        "remote": "origin",
        "from": "integration",
        "to": "main",
        "ffOnly": true,
        "minIntervalMin": 30
      }
    }
  }
}
```

Mỗi bước chạy bằng argv trong worktree tích hợp, có log tại `~/.agenthub/logs/deploy/<project>/<time>.log`. `push` mặc định tắt; khi bật chỉ fast-forward.

### Worktree tích hợp cho merge và deploy

AgentHub hỗ trợ hai cách cấu hình worktree tích hợp:
1. **Worktree tự quản lý (`settings.integration.enabled = true`)** (khuyến nghị):
   - Nằm tại `<worktree.root>/.integration` (nếu dự án cấu hình `settings.worktree.root`) hoặc `~/.agenthub/integration/<projectId>`, checkout nhánh `settings.integration.branch` (mặc định `agenthub/integration`).
   - Được dùng cho cả merge tự động (`mergeTaskIntoBase`), chạy merge-checks và tự động triển khai sau merge (self-deploy).
   - AgentHub tự động quản lý vòng đời và áp dụng cùng chính sách cài đặt dependency như worktree của task (`worktree.install`: `auto` dùng cache/symlink hoặc `npm ci`). Nếu `package-lock.json` hoặc file lock thay đổi sau commit merge, hub tự động cài đặt lại dependency trước khi chạy merge-check.
2. **Worktree khai báo thủ công (`project.merge.worktrees`)** (legacy):
   - Khai báo đường dẫn tuyệt đối cho từng baseRef trong cấu hình merge của project.
   - Chỉ áp dụng khi `settings.integration.enabled = false`. Khi bật `settings.integration.enabled = true`, hub ưu tiên worktree tự quản lý và bỏ qua cấu hình legacy này.

Để tránh gây quá tải cho CI khi merge liên tục, hub hỗ trợ **gom lượt push** bằng tuỳ chọn `minIntervalMin` (mặc định 30 phút):
- Sau mỗi lượt deploy thành công, hub chỉ push nếu khoảng cách từ lần push trước đó ≥ `minIntervalMin`.
- Nếu chưa đủ thời gian, hub sẽ tự động lên lịch hẹn push hoãn lại (deferred push, không cần build lại) khi đủ thời gian, gom tất cả các lần merge ở giữa vào 1 lượt push duy nhất. Lịch hẹn và thời điểm push gần nhất được lưu bền vững qua các lần khởi động lại daemon.
- Trạng thái deploy hiển thị thông tin dạng `push lúc HH:MM` hoặc `push đang chờ tới HH:MM`.
- Để đẩy code ngay lập tức (bỏ qua hẹn giờ), gọi `POST /api/projects/:id/deploy` kèm `{"pushNow": true}` hoặc gửi lệnh Telegram `/deploy <dự án> push`.
- **Lưu ý khi phát hành:** Trước khi tạo tag phát hành (release tag), bắt buộc phải chạy `pushNow` và xác nhận nhánh `main == integration` để đảm bảo bản phát hành mang đầy đủ các commit mới nhất.

Có thể chạy lại toàn bộ quy trình deploy bằng nút Deploy trên trang Projects hoặc `/deploy <project>` trong Telegram; `/deploy` không có tham số hiển thị trạng thái gần nhất.
