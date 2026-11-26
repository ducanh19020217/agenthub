import { Locale } from '../locales';

export function getActiveLocale(): Locale {
  if (typeof window !== 'undefined') {
    try {
      const saved = localStorage.getItem('agenthub_locale');
      if (saved === 'vi' || saved === 'en') return saved;
      const htmlLang = document.documentElement.lang;
      if (htmlLang === 'vi' || htmlLang === 'en') return htmlLang;
    } catch {
      // Storage unavailable
    }
  }
  return 'vi';
}

export const VN_DIACRITICS_REGEX = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i;

const ERROR_CODE_TRANSLATIONS: Record<string, { en: string; vi: string }> = {
  not_found: { en: 'Resource not found', vi: 'Không tìm thấy tài nguyên' },
  bad_request: { en: 'Bad request', vi: 'Yêu cầu không hợp lệ' },
  conflict: { en: 'Resource conflict', vi: 'Xung đột dữ liệu' },
  config: { en: 'Merge configuration error', vi: 'Lỗi cấu hình merge' },
  forbidden: { en: 'Permission denied', vi: 'Không có quyền truy cập' },
  unauthorized: { en: 'Unauthorized', vi: 'Chưa xác thực' },
  unavailable: { en: 'Service temporarily unavailable', vi: 'Dịch vụ tạm thời không khả dụng' },
  service_unavailable: { en: 'Service temporarily unavailable', vi: 'Dịch vụ tạm thời không khả dụng' },
  cycle_detected: { en: 'Dependency cycle detected', vi: 'Phát hiện vòng phụ thuộc' },
  rate_limited: { en: 'Rate limit exceeded', vi: 'Vượt quá giới hạn tần suất' },
  confirmation_required: { en: 'Confirmation required', vi: 'Cần xác nhận' },
  telegram_error: { en: 'Telegram connection error', vi: 'Lỗi kết nối Telegram' },
  pty_unavailable: { en: 'Terminal PTY unavailable', vi: 'Terminal PTY không khả dụng' },
  internal_error: { en: 'Internal server error', vi: 'Lỗi máy chủ nội bộ' },
  internal_server_error: { en: 'Internal server error', vi: 'Lỗi máy chủ nội bộ' },
  server_error: { en: 'Internal server error', vi: 'Lỗi máy chủ nội bộ' },
  provider_policy: { en: 'Provider account limit reached', vi: 'Đã đạt giới hạn tài khoản của nhà cung cấp' },
  invalid_logo: { en: 'Invalid logo file', vi: 'File logo không hợp lệ' },
  unprocessable_entity: { en: 'Unprocessable entity', vi: 'Thực thể không thể xử lý' },
  compact_failed: { en: 'Context compaction failed', vi: 'Nén ngữ cảnh thất bại' },
  mcp_install_failed: { en: 'MCP server installation failed', vi: 'Cài đặt MCP server thất bại' },
  summary_failed: { en: 'Summary generation failed', vi: 'Tạo tóm tắt thất bại' },
  gateway_timeout: { en: 'Gateway timeout', vi: 'Hết thời gian phản hồi máy chủ' },
  ambiguous: { en: 'Ambiguous reference', vi: 'Tham chiếu không rõ ràng' },
};

const VN_TO_EN_PATTERNS: Array<{ pattern: RegExp; replace: (...args: string[]) => string }> = [
  { pattern: /^Task "([^"]+)" không tồn tại$/i, replace: (_, id) => `Task "${id}" does not exist` },
  { pattern: /^Project "([^"]+)" không tồn tại$/i, replace: (_, id) => `Project "${id}" does not exist` },
  { pattern: /^Hồ sơ "([^"]+)" không tồn tại$/i, replace: (_, name) => `Profile "${name}" does not exist` },
  { pattern: /^Hồ sơ "([^"]+)" đã tồn tại$/i, replace: (_, name) => `Profile "${name}" already exists` },
  { pattern: /^Task "([^"]+)" đã tồn tại$/i, replace: (_, id) => `Task "${id}" already exists` },
  { pattern: /^Project ID "([^"]+)" đã tồn tại.*$/i, replace: (_, id) => `Project ID "${id}" already exists` },
  { pattern: /^Department "([^"]+)" không tồn tại$/i, replace: (_, id) => `Department "${id}" does not exist` },
  { pattern: /^Department ID "([^"]+)" đã tồn tại$/i, replace: (_, id) => `Department ID "${id}" already exists` },
  { pattern: /^Đợt "([^"]+)" không tồn tại$/i, replace: (_, id) => `Batch "${id}" does not exist` },
  { pattern: /^Task nguồn "([^"]+)" không tồn tại$/i, replace: (_, id) => `Source task "${id}" does not exist` },
  { pattern: /^Claude session "([^"]+)" không tồn tại$/i, replace: (_, id) => `Claude session "${id}" does not exist` },
  { pattern: /^Task phụ thuộc "([^"]+)" không tồn tại$/i, replace: (_, id) => `Dependent task "${id}" does not exist` },
  { pattern: /^Task "([^"]+)" không thuộc project$/i, replace: (_, id) => `Task "${id}" does not belong to project` },
  { pattern: /^Task "([^"]+)" không thuộc đợt "([^"]+)"$/i, replace: (_, taskId, batchId) => `Task "${taskId}" does not belong to batch "${batchId}"` },
  { pattern: /^Chỉ có thể sửa task ở trạng thái draft, queued, waiting_quota hoặc failed \(hiện tại: ([^)]+)\)$/i, replace: (_, s) => `Can only edit task in draft, queued, waiting_quota, or failed status (current: ${s})` },
  { pattern: /^Chỉ có thể retry task ở trạng thái failed hoặc blocked \(hiện tại: ([^)]+)\)$/i, replace: (_, s) => `Can only retry task in failed or blocked status (current: ${s})` },
  { pattern: /^Chỉ có thể giao đợt ở trạng thái draft.*$/i, replace: () => 'Can only dispatch batch in draft status' },
  { pattern: /^Chỉ có thể huỷ đợt ở trạng thái draft.*$/i, replace: () => 'Can only cancel batch in draft status' },
  { pattern: /^Chỉ có thể thêm task vào đợt ở trạng thái draft$/i, replace: () => 'Can only add task to batch in draft status' },
  { pattern: /^Chỉ có thể bỏ task khỏi đợt ở trạng thái draft$/i, replace: () => 'Can only remove task from batch in draft status' },
  { pattern: /^Chỉ có thể bỏ task ở trạng thái draft.*$/i, replace: () => 'Can only remove task in draft status' },
  { pattern: /^Chỉ có thể xoá task ở trạng thái draft.*$/i, replace: () => 'Can only delete task in draft status' },
  { pattern: /^Task "([^"]+)" không ở trạng thái running$/i, replace: (_, id) => `Task "${id}" is not in running status` },
  { pattern: /^Task "([^"]+)" không ở trạng thái review.*$/i, replace: (_, id) => `Task "${id}" is not in review status` },
  { pattern: /^Task "([^"]+)" không ở trạng thái chờ người duyệt$/i, replace: (_, id) => `Task "${id}" is not waiting for manual approval` },
  { pattern: /^Task đang được duyệt$/i, replace: () => 'Task is currently being reviewed' },
  { pattern: /^Phát hiện vòng phụ thuộc trong đợt$/i, replace: () => 'Dependency cycle detected in batch' },
  { pattern: /^Phát hiện vòng phụ thuộc: (.+)$/i, replace: (_, cycle) => `Dependency cycle detected: ${cycle}` },
  { pattern: /^Phát hiện chu trình phụ thuộc$/i, replace: () => 'Circular dependency detected' },
  { pattern: /^Danh sách dependsOn tạo vòng phụ thuộc$/i, replace: () => 'dependsOn list creates a circular dependency' },
  { pattern: /^Chế độ Đầy đủ chưa được bật trên máy chủ$/i, replace: () => 'Full mode is not enabled on server' },
  { pattern: /^Không thể xóa phiên đang bận$/i, replace: () => 'Cannot delete a busy session' },
  { pattern: /^Claude đang trả lời$/i, replace: () => 'Claude is currently answering' },
  { pattern: /^Không thể kết nối Telegram$/i, replace: () => 'Cannot connect to Telegram' },
  { pattern: /^Bot token không được để trống$/i, replace: () => 'Bot token cannot be empty' },
  { pattern: /^Chưa cấu hình logo$/i, replace: () => 'Logo is not configured' },
  { pattern: /^Chưa xác thực hoặc token không hợp lệ$/i, replace: () => 'Unauthenticated or invalid token' },
  { pattern: /^Thiếu token xác thực$/i, replace: () => 'Missing authentication token' },
  { pattern: /^Token không hợp lệ hoặc đã hết hạn$/i, replace: () => 'Token is invalid or expired' },
  { pattern: /^Lỗi (\d+): (.+)$/i, replace: (_, status, text) => `Error ${status}: ${text}` },
  { pattern: /^Không thể mở trình đăng nhập$/i, replace: () => 'Cannot open login terminal' },
  { pattern: /^Kiểm tra thất bại$/i, replace: () => 'Check failed' },
  { pattern: /^Kiểm tra thành công$/i, replace: () => 'Check succeeded' },
  { pattern: /^Không thể xuất phiên trò chuyện$/i, replace: () => 'Failed to export chat session' },
  { pattern: /^Không thể xuất Markdown$/i, replace: () => 'Failed to export Markdown' },
  { pattern: /^Không tìm thấy lệnh (.+)$/i, replace: (_, cmd) => `Command not found: ${cmd}` },
  { pattern: /^Setup log không tồn tại$/i, replace: () => 'Setup log does not exist' },
  { pattern: /^Chỉ thị không tồn tại$/i, replace: () => 'Directive does not exist' },
  { pattern: /^Mục kiến thức không tồn tại$/i, replace: () => 'Knowledge entry does not exist' },
  { pattern: /^Không thể xóa hồ sơ "([^"]+)" đang chạy task$/i, replace: (_, name) => `Cannot delete profile "${name}" while running a task` },
  { pattern: /^Không thể đổi tên hồ sơ "([^"]+)" đang chạy task$/i, replace: (_, name) => `Cannot rename profile "${name}" while running a task` },
  { pattern: /^Hồ sơ "([^"]+)" đang được kiểm tra$/i, replace: (_, name) => `Profile "${name}" is currently being checked` },
  { pattern: /^Không thể xóa project khi còn task đang chạy.*$/i, replace: () => 'Cannot delete project while tasks are running' },
  { pattern: /^Đường dẫn repo phải là đường dẫn tuyệt đối: (.+)$/i, replace: (_, p) => `Repository path must be an absolute path: ${p}` },
  { pattern: /^Đường dẫn phải là đường dẫn tuyệt đối$/i, replace: () => 'Path must be an absolute path' },
  { pattern: /^Thư mục repo không tồn tại: (.+)$/i, replace: (_, p) => `Repository directory does not exist: ${p}` },
  { pattern: /^Thư mục không phải là git repository: (.+)$/i, replace: (_, p) => `Directory is not a git repository: ${p}` },
  { pattern: /^Nhánh mặc định "([^"]+)" không tồn tại trong repository$/i, replace: (_, b) => `Default branch "${b}" does not exist in repository` },
  { pattern: /^Cấp Toàn quyền cần confirm: true vì cho phép Claude chạy mọi lệnh$/i, replace: () => 'Granting full access requires confirm: true because it allows Claude to run any command' },
  { pattern: /^Cấp Toàn quyền mặc định cần confirm: true$/i, replace: () => 'Granting default full access requires confirm: true' },
  { pattern: /^Quyết định đã hết hạn hoặc đã trả lời$/i, replace: () => 'Decision has expired or already answered' },
  { pattern: /^Tên phòng ban không hợp lệ$/i, replace: () => 'Invalid department name' },
  { pattern: /^Không thể đọc logo$/i, replace: () => 'Failed to read logo file' },
  { pattern: /^Logo base64 không hợp lệ$/i, replace: () => 'Invalid base64 logo data' },
  { pattern: /^Logo cần mimeType và data base64$/i, replace: () => 'Logo requires mimeType and base64 data' },
  { pattern: /^Dữ liệu không phải là chuỗi JSON hợp lệ$/i, replace: () => 'Data is not valid JSON string' },
  { pattern: /^Trường "tokens" không phải là JSON hợp lệ$/i, replace: () => 'Field "tokens" is not valid JSON' },
  { pattern: /^Danh sách token trống$/i, replace: () => 'Token list is empty' },
  { pattern: /^Không thể xóa hồ sơ hệ thống$/i, replace: () => 'Cannot delete system profile' },
  { pattern: /^Trùng slug "([^"]+)" trong cùng đợt$/i, replace: (_, s) => `Duplicate slug "${s}" in the same batch` },
  { pattern: /^Đợt "([^"]+)" không có task nào ở trạng thái draft$/i, replace: (_, id) => `Batch "${id}" has no tasks in draft status` },
  { pattern: /^Task chưa có run để lưu kết quả kiểm tra$/i, replace: () => 'Task has no run to store check results' },
  { pattern: /^Check database chưa sẵn sàng$/i, replace: () => 'Check database is not ready' },
  { pattern: /^Chat service chưa sẵn sàng$/i, replace: () => 'Chat service is not ready' },
  { pattern: /^Telegram bot service chưa sẵn sàng$/i, replace: () => 'Telegram bot service is not ready' },
  { pattern: /^Directive service chưa sẵn sàng$/i, replace: () => 'Directive service is not ready' },
  { pattern: /^AppService chưa sẵn sàng$/i, replace: () => 'AppService is not ready' },
  { pattern: /^Setup service chưa sẵn sàng$/i, replace: () => 'Setup service is not ready' },
  { pattern: /^Database chưa sẵn sàng$/i, replace: () => 'Database is not ready' },
  { pattern: /^Merge bị xung đột$/i, replace: () => 'Merge conflict' },
  { pattern: /^Xung đột merge ở: (.+)$/i, replace: (_, details) => `Merge conflict in: ${details}` },
  { pattern: /^Project chưa cấu hình merge tự động$/i, replace: () => 'Project has not configured auto-merge' },
  { pattern: /^Cấu hình merge không hợp lệ$/i, replace: () => 'Invalid merge configuration' },
  { pattern: /^Merge tự động chưa được bật hoặc chưa có worktree tích hợp$/i, replace: () => 'Auto-merge is not enabled or integration worktree is missing' },
  { pattern: /^Project thiếu id hoặc path để quản lý worktree tích hợp$/i, replace: () => 'Project is missing id or path for integration worktree' },
  { pattern: /^Không thể chuẩn bị worktree tích hợp: (.+)$/i, replace: (_, err) => `Cannot prepare integration worktree: ${err}` },
  { pattern: /^Chưa khai báo worktree tích hợp cho baseRef "([^"]+)"$/i, replace: (_, ref) => `Integration worktree not declared for baseRef "${ref}"` },
  { pattern: /^Không thể giao worker: baseRef chưa có worktree tích hợp\. Hãy sửa cấu hình hoặc đổi baseRef về nhánh mặc định\.$/i, replace: () => 'Cannot assign worker: baseRef has no integration worktree. Fix configuration or change baseRef to the default branch.' },
  { pattern: /^worktree tích hợp có thay đổi chưa commit$/i, replace: () => 'Integration worktree has uncommitted changes' },
  { pattern: /^Worktree tích hợp (.+) có thay đổi chưa commit; không thể chuyển sang nhánh (.+)$/i, replace: (_, path, branch) => `Integration worktree ${path} has uncommitted changes; cannot switch to branch ${branch}` },
  { pattern: /^Nhánh (.+) đang được checkout tại (.+); chọn tên nhánh tích hợp khác$/i, replace: (_, branch, at) => `Branch ${branch} is checked out at ${at}; select another integration branch name` },
  { pattern: /^Không thể đổi quyền khi brain đang chạy$/i, replace: () => 'Cannot change permissions while brain is running' },
  { pattern: /^Hãy đợi lượt chat hiện tại kết thúc trước khi đổi model$/i, replace: () => 'Please wait for the current chat turn to complete before changing model' },
  { pattern: /^Phiên đang bận và hàng đợi đã đầy$/i, replace: () => 'Session is busy and queue is full' },
  { pattern: /^Phiên đang bận$/i, replace: () => 'Session is busy' },
  { pattern: /^AGENTS\.md đã tồn tại trong project$/i, replace: () => 'AGENTS.md already exists in project' },
  { pattern: /^Thư mục "([^"]+)" đã tồn tại trên đĩa$/i, replace: (_, dir) => `Directory "${dir}" already exists on disk` },
  { pattern: /^Không thể xóa dữ liệu dự án vì còn liên kết dữ liệu; không có dữ liệu nào bị xóa$/i, replace: () => 'Cannot delete project data due to existing references; no data was deleted' },
  { pattern: /^Quy tắc không tồn tại$/i, replace: () => 'Rule does not exist' },
  { pattern: /^Yêu cầu cấp quyền không tồn tại hoặc đã được xử lý$/i, replace: () => 'Permission request does not exist or has already been processed' },
  { pattern: /^Chế độ full chưa được cho phép trong cấu hình$/i, replace: () => 'Full mode is not permitted in configuration' },
  { pattern: /^Model chat phải là mặc định, sonnet hoặc haiku$/i, replace: () => 'Chat model must be default, sonnet, or haiku' },
  { pattern: /^Task tóm tắt không tồn tại$/i, replace: () => 'Summary task does not exist' },
  { pattern: /^Deploy service chưa sẵn sàng$/i, replace: () => 'Deploy service is not ready' },
  { pattern: /^Claude session service chưa sẵn sàng$/i, replace: () => 'Claude session service is not ready' },
  { pattern: /^SavingsService chưa được khởi tạo$/i, replace: () => 'SavingsService is not initialized' },
  { pattern: /^TaskBatchRepo chưa được khởi tạo$/i, replace: () => 'TaskBatchRepo is not initialized' },
  { pattern: /^TaskNoteRepo chưa được khởi tạo$/i, replace: () => 'TaskNoteRepo is not initialized' },
  { pattern: /^chat id không hợp lệ$/i, replace: () => 'Invalid chat ID' },
  { pattern: /^chatId không hợp lệ$/i, replace: () => 'Invalid chatId' },
  { pattern: /^token phải là chuỗi$/i, replace: () => 'token must be a string' },
  { pattern: /^enabled phải là boolean$/i, replace: () => 'enabled must be a boolean' },
  { pattern: /^apiKey là bắt buộc$/i, replace: () => 'apiKey is required' },
  { pattern: /^text là bắt buộc$/i, replace: () => 'text is required' },
  { pattern: /^question là bắt buộc$/i, replace: () => 'question is required' },
  { pattern: /^Logo không hợp lệ$/i, replace: () => 'Invalid logo' },
];

export function translateApiErrorMessage(message: string, code?: string, locale?: Locale): string {
  const targetLocale = locale || getActiveLocale();
  const normalizedCode = code?.trim().toLowerCase();
  const codeTranslation = normalizedCode ? ERROR_CODE_TRANSLATIONS[normalizedCode] : undefined;

  if (targetLocale === 'vi') {
    if (codeTranslation) {
      // If message is untranslated (e.g. English, raw code, or unaccented without Vietnamese characters),
      // fallback to the error code's Vietnamese translation.
      if (!VN_DIACRITICS_REGEX.test(message)) {
        return codeTranslation.vi;
      }
    }
    return message;
  }

  // English translation mode
  // 1. Check specific regex patterns first to preserve detailed contextual translations
  for (const item of VN_TO_EN_PATTERNS) {
    if (item.pattern.test(message)) {
      return message.replace(item.pattern, item.replace);
    }
  }

  // 2. Fallback to error code translation for any untranslated message
  if (codeTranslation) {
    return codeTranslation.en;
  }

  return message;
}
