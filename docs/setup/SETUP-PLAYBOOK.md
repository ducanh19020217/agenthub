# Sổ tay thiết lập AgentHub bằng chat

Đây là quy trình chuẩn cho Claude khi người dùng nói “thiết lập AgentHub”. Mỗi lần chỉ hỏi một câu, đưa ra các lựa chọn ngắn và chờ câu trả lời. Nếu người dùng muốn dừng, ghi nhận bước đang làm và có thể tiếp tục ở lần chat sau.

## Nguyên tắc chung

- Trước mỗi bước, gọi `hub_effective_config` để biết phần nào đã cấu hình; phần đã có thì bỏ qua và chỉ kiểm tra lại nếu người dùng yêu cầu.
- Mọi thay đổi phải gọi tool với `dryRun: true`, trình bày diff dễ đọc, chờ xác nhận rồi mới gọi lại với `dryRun: false`.
- Không hỏi, nhận, in hoặc lưu bí mật trong chat. Dùng `hub_request_secret` (OpenProject key, Gitea token, SSH/deploy secret) và chỉ tiếp tục sau khi tool báo đã lưu.
- Có thể dừng ở bất kỳ bước nào. Khi tiếp tục, đọc lại cấu hình hiệu lực và không lặp lại bước đã xong.

## 1. Kiểm tra máy

**Câu hỏi:** “Bạn muốn kiểm tra máy này ngay không? (Có / Không, tiếp tục tự cài)” — mặc định: Có.

**Tool:** gọi `hub_effective_config`, rồi `hub_doctor` (hoặc `agenthub doctor` nếu đang ở CLI); kiểm tra Node 22, Git, Claude CLI, Codex CLI, agy và daemon.

**Kiểm tra:** chỉ tiếp tục khi Node/Git và daemon đạt; ghi rõ công cụ thiếu để bước 2 xử lý. Không chạy worker thật.

## 2. Cài hoặc cập nhật AgentHub

**Câu hỏi:** “AgentHub đã có trên máy chưa; cài/cập nhật bản release chính thức chứ? (Cài release / Đã có, bỏ qua / Dừng)” — mặc định: Cài release nếu doctor chưa đạt.

**Tool:** dùng installer release chính thức (`agenthub setup`/installer), không cài từ mã nguồn khi người dùng không yêu cầu. Sau đó gọi `hub_doctor` và `hub_effective_config`.

**Kiểm tra:** `agenthub --version`, `agenthub health` hoặc `GET /health`, và daemon đang chạy. Không ghi đè cấu hình hiện tại.

## 3. Đăng ký project

**Câu hỏi:** “Project lấy từ URL Git hay thư mục có sẵn? (URL: … / Thư mục: … / Bỏ qua)” — mặc định: thư mục hiện tại nếu là Git repo.

**Tool:** với URL, clone vào vị trí người dùng chọn rồi gọi `hub_register_project`; với thư mục, gọi `hub_register_project` trực tiếp. Không tự đoán đường dẫn.

**Kiểm tra:** `hub_projects`, xác nhận tên, remote git, nhánh mặc định và project không trùng. Nếu cần ghi, luôn dry-run và cho xem diff trước.

## 4. Chọn preset

**Câu hỏi:** “Bạn chọn mức nào? (safe / balanced / auto)” — mặc định: `balanced`.

`safe` ưu tiên duyệt thủ công và ít tự động; `balanced` là cân bằng giữa tốc độ và kiểm soát; `auto` tự chạy và tự xử lý nhiều bước hơn khi check bảo vệ đã đủ.

**Tool:** gọi `hub_effective_config`, sau đó `hub_apply_preset` với `dryRun: true`; chỉ khi người dùng xác nhận mới gọi `dryRun: false`.

**Kiểm tra:** đọc lại `hub_effective_config`; nếu `auto` chưa có check, gọi discover `checks` để gợi ý và hỏi người dùng trước khi thêm.

## 5. Phòng ban

**Câu hỏi:** “Bạn có cần chia phòng ban không? (Không / Có, tạo phòng ban: …)” — mặc định: Không.

**Tool:** nếu không, để mọi project và tài khoản ở `chung`. Nếu có, dùng tool department hiện có, mỗi thay đổi phải dry-run.

**Kiểm tra:** `hub_effective_config` cho project và xác nhận department; không tự di chuyển project khỏi `chung`.

## 6. Bộ não và duyệt tự động

**Câu hỏi:** “Bộ não nên chạy thế nào? (Gợi ý, tôi duyệt / Tự động khi có check / Tắt)” — mặc định: Gợi ý.

**Tool:** `hub_effective_config`, `hub_apply_config`/preset với dry-run. Nếu chọn tự động mà thiếu check, gọi `hub_discover` với `kind: "checks"`, trình bày đề xuất rồi mới áp dụng.

**Kiểm tra:** đọc lại mode, engine/model, quyền, reviewer và danh sách checks; chạy một dry-run task nhỏ nếu người dùng đồng ý.

## 7. OpenProject

**Câu hỏi:** “Bật OpenProject cho project nào và URL là gì?” — mặc định: bỏ qua nếu đã cấu hình.

**Tool:** `hub_discover` với `kind: "openproject"` để lấy project/status; gọi `hub_request_secret` cho key (không hỏi key trong chat); gọi discover lại sau khi key được lưu. Hiển thị ánh xạ trạng thái và dùng dry-run trước khi ghi.

**Câu hỏi tiếp theo:** “Xác nhận ánh xạ trạng thái này và chọn primary/secondary? (Xác nhận / Sửa / Bỏ qua)” — mặc định: xác nhận mapping được discover.

**Kiểm tra:** `hub_effective_config`, test kết nối/read-only và bảo đảm key chỉ hiện dưới dạng đã cấu hình.

## 8. Gitea

**Câu hỏi:** “Bật đồng bộ Gitea theo lịch nào? (12:00, 18:00 / Lịch khác / Bỏ qua)” — mặc định: không bật.

**Tool:** gọi `hub_discover` với `kind: "gitea"`; gọi `hub_request_secret` để xin token; dùng dry-run cho URL, nhánh và lịch rồi mới ghi.

**Kiểm tra:** test discover/read-only, xác nhận source/target branch và hiển thị lịch theo múi giờ máy. Không in token.

## 9. Deploy từ xa (tuỳ chọn)

**Câu hỏi:** “Có bật deploy từ xa không? (Không / Có, sau đồng bộ Gitea / Có, chạy thủ công)” — mặc định: Không.

**Tool:** nếu có, gọi `hub_request_secret` cho secret deploy; dùng dry-run để trình bày command, health check, timeout và thời gian chờ. Không đưa secret vào diff.

**Kiểm tra:** validate command/URL, chạy health check không phá huỷ và chỉ lưu phần cấu hình không bí mật.

## 10. Telegram (tuỳ chọn)

**Câu hỏi:** “Có bật thông báo Telegram không? (Không / Có, tôi sẽ nhập token an toàn)” — mặc định: Không.

**Tool:** `hub_request_secret` cho bot token, sau đó dry-run cấu hình chat/topic và lịch thông báo.

**Kiểm tra:** gửi test message khi người dùng xác nhận; không bao giờ đưa token vào chat, log hay file export.

## 11. Kiểm tra cuối

**Câu hỏi:** “Chạy toàn bộ kiểm tra cuối bây giờ chứ? (Có / Chưa)” — mặc định: Có.

**Tool:** `hub_effective_config`; test kết nối từng tích hợp đã bật; dry-run sync và cho người dùng xem diff; health check AgentHub; cuối cùng mới ghi thay đổi đã xác nhận.

**Kiểm tra:** tóm tắt project, preset, brain/reviewer, department, tích hợp, mục còn thiếu và cách tiếp tục. Không đánh dấu hoàn tất nếu còn secret hoặc check bắt buộc thiếu.

## Máy mới

Người dùng có thể nói: “đọc `docs/setup/SETUP-PLAYBOOK.md` và cài theo `agenthub-setup.json`”. Claude đọc file, chạy `agenthub setup import <file> --dry-run`, đối chiếu project/đường dẫn/remote và chỉ hỏi lại những bí mật còn thiếu bằng `hub_request_secret`. Sau khi người dùng duyệt diff, chạy import thật; đường dẫn dưới HOME được hiểu là `~`, không dùng đường dẫn tuyệt đối của máy cũ.
