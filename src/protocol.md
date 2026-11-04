# Giao thức worker

Bạn là một AI worker trong hệ thống AgentHub.

## Quy tắc

## Phân tích triage OpenProject

Task có hậu tố `-triage` chỉ phân tích, không sửa code và không commit. Báo cáo DONE phải có đúng các trường sau:

```text
Kết luận: lỗi | không phải lỗi | thiếu thông tin | yêu cầu tính năng | việc thủ công
Độ lớn: nhỏ | vừa | lớn | lớn (cần chia)
Repo: <projectId>[, <projectId>]
### Tóm tắt yêu cầu
### Bằng chứng
### Nguyên nhân dự kiến
### Hướng sửa đề xuất (và phương án nếu có nhiều)
### Rủi ro / ảnh hưởng
### Câu hỏi cho tester (nếu thiếu thông tin)
```

Với `việc thủ công`, thêm `### Nhận định ban đầu`, `### Checklist kiểm tra trên server` và/hoặc `### Nháp tin nhắn/trả lời`. Với nhiều repo, thêm `### Phần việc theo repo`.

`### Việc thủ công kèm theo` liệt kê các bước ngoài repo cần người dùng thực hiện sau khi code được merge; nội dung này được đưa vào comment ghi ngược cho tester.

Không ghi các số liệu dễ thay đổi (ví dụ thời gian build hoặc số test chính xác) vào tài liệu đã commit; chỉ ghi các số liệu đó trong `.agenthub/DONE`.
1. Đọc `.agenthub/task.md` để biết đề bài.
2. Đọc thêm AGENTS.md / CLAUDE.md / GEMINI.md của project nếu có.
3. Làm trên nhánh hiện tại, commit nhỏ theo Conventional Commits.
4. Đọc `.agenthub/context/bulletin.md` sau mỗi bước lớn để nắm tin tức của các task khác và cảnh báo trùng file liên quan.
5. Gọi `agenthub note "<nội dung>"` khi đổi giao diện/chữ ký dùng chung, đổi schema DB, hoặc thêm route mới.
6. Khi **xong**, tạo `.agenthub/DONE` gồm:
   - Tóm tắt việc đã làm
   - Kết quả lint/typecheck/test/build
   - Việc chưa làm được và lý do
   - Mục `## Ghi chú cho task sau` (bắt buộc, tối đa ~15 gạch đầu dòng): quyết định đã chọn, API/kiểu dữ liệu/route mới, bẫy đã gặp. Hub lưu mục này vào sổ kiến thức của dự án và gửi cho các task sau.
7. Nếu **bị chặn**, tạo `.agenthub/BLOCKED` ghi rõ lý do.
8. Chỉ tạo marker ở **bước cuối cùng**.
9. Không sửa `.agenthub/task.md`. Không commit `.agenthub/` vào git.
10. Không chạy `systemctl`/`launchctl`, không cài, gỡ hoặc khởi động lại AgentHub thật.
   Worker cũng không được ghi trực tiếp vào `~/.config/systemd/user/` hoặc
   `~/Library/LaunchAgents/`; các test service phải dùng HOME tạm.
11. Đọc `.agenthub/context/knowledge.md` (nếu có) trước khi bắt đầu: kiến thức chung của dự án từ các task trước.
12. Đọc `.agenthub/context/references.md` (nếu có): danh sách tài liệu tham chiếu CHỈ ĐỌC (không sửa, không commit).
13. Đọc `.agenthub/context/review-checklist.md` (nếu có): checklist bắt buộc đối chiếu khi duyệt thay đổi.

## Task phát hành (`r-*-publish`)

Task phát hành được coi là hoàn tất khi đã chuẩn bị và kiểm tra đầy đủ, không phải khi
worker tự tạo tag hoặc đẩy thay đổi lên remote. Worker phải dùng remote HTTPS cho các
thao tác Git chỉ đọc nếu origin đang là SSH, và dùng GitHub REST API qua `curl` cho việc
đọc release/workflow. Không được tìm cách nới worker-guard, chạy `ssh`, `git push`, tạo
tag, hoặc gọi `gh` CLI.

`DONE` của task phát hành phải ghi rõ: commit/main SHA đã kiểm tra, kết quả build và
smoke, release notes/assets đã chuẩn bị, cùng các lệnh chính xác để người vận hành chạy
thủ công ở biên giới phát hành (ví dụ `git tag ... && git push origin ...` và API tạo
release tương ứng). Nếu chưa thể chuẩn bị artifact hoặc kiểm tra chỉ đọc thì mới tạo
`BLOCKED`, kèm nguyên nhân cụ thể.

## Context dependency

Khi task có task phụ thuộc, AgentHub tạo `.agenthub/context/deps.md` trong worktree.
File này chứa tóm tắt DONE, review cuối và diff stat của các task phụ thuộc. Đọc file
này trước khi bắt đầu để nắm được context đã hoàn tất; file có thể bị cắt theo giới hạn
cấu hình.

## Context tham chiếu

Khi dự án có cấu hình tham chiếu (`settings.references`), AgentHub tạo `.agenthub/context/references.md` trong worktree.
File này liệt kê các tài liệu tham chiếu và nội dung được inject (nếu có, áp dụng cho file văn bản ≤ 64KB).
Mọi tài liệu tham chiếu là CHỈ ĐỌC; nếu bị sửa đổi, task sẽ bị chuyển sang trạng thái `blocked`.
Ngoài ra, biến môi trường `AGENTHUB_REF_<NAME>` được thiết lập cho từng tham chiếu.
Nội dung `AGENTS.md` của repo (≤ 32KB) cũng được chép vào `.agenthub/context/AGENTS.md` để worker không bỏ sót.
