#!/bin/sh
set -e

# ==============================================================================
# AgentHub Installer (POSIX sh, Linux + macOS)
# ==============================================================================

AGENTHUB_DIR="${AGENTHUB_DIR:-$HOME/.agenthub-app}"
AGENTHUB_DATA_DIR="${AGENTHUB_HOME:-$HOME/.agenthub}"
AGENTHUB_REPO="${AGENTHUB_REPO:-https://github.com/ducanh19020217/agenthub.git}"
AGENTHUB_RELEASE_REPO="${AGENTHUB_RELEASE_REPO:-ducanh19020217/agenthub}"
AGENTHUB_RELEASE_BASE="${AGENTHUB_RELEASE_BASE:-}"
AGENTHUB_LINK_DIR="${AGENTHUB_LINK_DIR:-$HOME/.local/bin}"
SYSTEMCTL="${AGENTHUB_SYSTEMCTL:-systemctl}"
LAUNCHCTL="${AGENTHUB_LAUNCHCTL:-launchctl}"

# Release installs use one script-level trap.  This is deliberately POSIX sh:
# the installer is commonly run as `curl ... | sh`, where the shell is dash.
INSTALL_LOG="${INSTALL_LOG:-}"
_install_step=""
_failure_reason=""
_release_tmp=""
_release_stage=""
_release_dir=""
_release_root=""
_release_backup=""
_old_current=""
_old_link=""
_old_service_backup=""
_pointers_changed=0
_install_success=0
_service_file=""

installer_log() {
  [ -n "$INSTALL_LOG" ] || return 0
  printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >> "$INSTALL_LOG"
}

cleanup_stale_tmp_dirs() {
  [ -d "$AGENTHUB_DIR" ] || return 0
  _cleanup_root="$(canonical_dir "$AGENTHUB_DIR")" || return 0
  [ -n "$_cleanup_root" ] || return 0
  for _stale in "$_cleanup_root"/.*.tmp.*; do
    [ -d "$_stale" ] || continue
    _stale_real="$(canonical_dir "$_stale")" || continue
    case "$_stale_real/" in
      "$_cleanup_root/"*) rm -rf "$_stale"; echo "✓ Đã dọn thư mục cài đặt dở: $_stale" ;;
    esac
  done
}

restore_release_state() {
  [ "$_pointers_changed" = "1" ] || return 0
  installer_log "rollback: restoring current=$_old_current link=$_old_link"
  if [ -n "$_release_root" ]; then
    rm -f "$_release_root/current"
    if [ -n "$_old_current" ]; then ln -s "$_old_current" "$_release_root/current"; fi
    if [ -n "$_release_dir" ] && [ -d "$_release_dir" ]; then rm -rf "$_release_dir"; fi
    if [ -n "$_release_backup" ] && [ -d "$_release_backup" ]; then mv "$_release_backup" "$_release_dir"; fi
  fi
  _link_file="$AGENTHUB_LINK_DIR/agenthub"
  rm -f "$_link_file"
  if [ -n "$_old_link" ]; then
    mkdir -p "$AGENTHUB_LINK_DIR"
    ln -s "$_old_link" "$_link_file"
  fi
  if [ -n "$_service_file" ]; then
    rm -f "$_service_file"
    if [ -n "$_old_service_backup" ] && [ -f "$_old_service_backup" ]; then
      mkdir -p "$(dirname "$_service_file")"
      cp "$_old_service_backup" "$_service_file"
    fi
  fi
  case "$(uname -s 2>/dev/null)" in
    Darwin*)
      _uid="$(id -u)"
      "$LAUNCHCTL" bootout "gui/$_uid/dev.agenthub" 2>/dev/null || true
      if [ -n "$_old_service_backup" ] && [ -f "$_old_service_backup" ] && [ -n "$_service_file" ]; then
        "$LAUNCHCTL" bootstrap "gui/$_uid" "$_service_file" 2>/dev/null || true
      fi
      ;;
    Linux*)
      "$SYSTEMCTL" --user daemon-reload 2>/dev/null || true
      ;;
  esac
  echo "! Đã hoàn tác current, symlink CLI và service về bản trước (nếu có)." >&2
}

installer_cleanup() {
  _status="$1"
  set +e
  if [ "$_install_success" != "1" ] && [ "$_status" -ne 0 ] 2>/dev/null; then
    restore_release_state
  fi
  [ -n "$_release_tmp" ] && rm -rf "$_release_tmp"
  [ -n "$_release_stage" ] && rm -rf "$_release_stage"
  [ -n "$_old_service_backup" ] && rm -f "$_old_service_backup"
  if [ -n "$INSTALL_LOG" ] && [ "$_status" -ne 0 ] 2>/dev/null; then
    echo "" >&2
    echo "❌ Cài đặt thất bại ở bước: ${_install_step:-khởi tạo}" >&2
    echo "Nguyên nhân: ${_failure_reason:-lệnh cài đặt trả về lỗi}" >&2
    echo "Khắc phục: sửa nguyên nhân rồi chạy lại; bản trước vẫn được giữ nguyên." >&2
    echo "Log chi tiết: $INSTALL_LOG" >&2
    if [ "$_pointers_changed" = "1" ]; then
      echo "Đã hoàn tác về bản trước; bản trước (nếu có) vẫn dùng được" >&2
    else
      echo "Không có gì bị thay đổi trên máy; bản trước (nếu có) vẫn dùng được" >&2
    fi
  fi
}

installer_signal() {
  _signal="$1"
  _failure_reason="bị ngắt bởi tín hiệu $_signal"
  exit "$2"
}

canonical_dir() {
  (cd "$1" 2>/dev/null && pwd -P)
}

is_safe_app_dir() {
  [ -d "$AGENTHUB_DIR" ] || return 1
  [ -f "$AGENTHUB_DIR/.agenthub-app" ] || return 1

  _app_dir="$(canonical_dir "$AGENTHUB_DIR")" || return 1
  _home_dir="$(canonical_dir "$HOME")" || return 1
  _data_dir="$(canonical_dir "$AGENTHUB_DATA_DIR")" 2>/dev/null || _data_dir="$AGENTHUB_DATA_DIR"

  [ "$_app_dir" != "/" ] || return 1
  [ "$_app_dir" != "$_home_dir" ] || return 1
  [ "$_app_dir" != "$_data_dir" ] || return 1
  case "$_data_dir/" in
    "$_app_dir/"*) return 1 ;;
  esac

  if grep -q '^mode=release$' "$AGENTHUB_DIR/.agenthub-app" 2>/dev/null; then
    [ -L "$AGENTHUB_DIR/current" ] || return 1
    [ -f "$AGENTHUB_DIR/current/package.json" ] || return 1
  else
    [ "$(git -C "$AGENTHUB_DIR" config --get agenthub.installed 2>/dev/null)" = "true" ] || return 1
  fi
  return 0
}

is_safe_data_dir() {
  [ -d "$AGENTHUB_DATA_DIR" ] || return 1
  _data_dir="$(canonical_dir "$AGENTHUB_DATA_DIR")" || return 1
  _home_dir="$(canonical_dir "$HOME")" || return 1
  [ "$_data_dir" != "/" ] || return 1
  [ "$_data_dir" != "$_home_dir" ] || return 1
  [ -f "$AGENTHUB_DATA_DIR/hub.db" ] || [ -f "$AGENTHUB_DATA_DIR/config.json" ] || return 1
  return 0
}

# Helper: Prompt Yes/No
prompt_yes_no() {
  _question="$1"
  _default="$2" # y or n
  _ans=""
  if [ "$_default" = "y" ]; then
    _prompt="[Y/n]"
  else
    _prompt="[y/N]"
  fi

  if [ -t 0 ]; then
    printf "%s %s: " "$_question" "$_prompt"
    read -r _ans
  elif ([ -t 1 ] || [ -t 2 ]) && [ -c /dev/tty ]; then
    if printf "%s %s: " "$_question" "$_prompt" >/dev/tty 2>/dev/null && read -r _ans </dev/tty 2>/dev/null; then
      :
    else
      if [ "$_default" = "y" ]; then
        return 0
      else
        return 1
      fi
    fi
  else
    if [ "$_default" = "y" ]; then
      return 0
    else
      return 1
    fi
  fi

  if [ -z "$_ans" ]; then
    if [ "$_default" = "y" ]; then
      return 0
    else
      return 1
    fi
  fi

  case "$_ans" in
    y*|Y*) return 0 ;;
    *) return 1 ;;
  esac
}

# Helper: Check if Node >= 22
node_is_v22_or_higher() {
  if ! command -v node >/dev/null 2>&1; then
    return 1
  fi
  _v="$(node -v 2>/dev/null | tr -d 'v')"
  _major="$(echo "$_v" | cut -d. -f1)"
  if [ -n "$_major" ] && [ "$_major" -ge 22 ] 2>/dev/null; then
    return 0
  fi
  return 1
}

# ------------------------------------------------------------------------------
# Argument Parsing
# ------------------------------------------------------------------------------
UNINSTALL=0
PURGE=0
DRY_RUN=0
FROM_RELEASE=0
RELEASE_VERSION=""
RELEASE_VERSION_SET=0
USE_NVM=0

while [ "$#" -gt 0 ]; do
  arg="$1"
  case "$arg" in
    --uninstall)
      UNINSTALL=1
      ;;
    --purge)
      PURGE=1
      ;;
    --dry-run)
      DRY_RUN=1
      ;;
    --from-release)
      FROM_RELEASE=1
      if [ "$#" -gt 1 ] && [ "${2#--}" = "$2" ]; then
        RELEASE_VERSION="$2"
        RELEASE_VERSION_SET=1
        shift
      fi
      ;;
    --use-nvm)
      USE_NVM=1
      ;;
    --help|-h)
      echo "AgentHub Installer"
      echo ""
      echo "Cách dùng:"
      echo "  ./scripts/install.sh                      Cài đặt hoặc cập nhật AgentHub"
      echo "  ./scripts/install.sh --uninstall          Gỡ service, symlink và app (giữ dữ liệu)"
      echo "  ./scripts/install.sh --uninstall --purge  Gỡ cài đặt và xoá sạch dữ liệu (hỏi xác nhận)"
      echo "  ./scripts/install.sh --dry-run            Chỉ in các lệnh, không thay đổi hệ thống"
      echo "  ./scripts/install.sh --from-release [version]  Cài từ GitHub Release"
      echo "  ./scripts/install.sh --from-release --use-nvm  Dùng nvm thay vì runtime Node tích hợp"
      echo ""
      echo "Biến môi trường:"
      echo "  AGENTHUB_DIR       Thư mục clone mã nguồn (mặc định: ~/.agenthub-app)"
      echo "  AGENTHUB_HOME      Thư mục lưu trữ dữ liệu (mặc định: ~/.agenthub)"
      echo "  AGENTHUB_REPO      URL git repository (mặc định: GitHub chính thức)"
      echo "  AGENTHUB_RELEASE_REPO  owner/repo hoặc URL GitHub Release"
      echo "  AGENTHUB_RELEASE_BASE  URL hoặc thư mục release để test (ghi đè repo)"
      exit 0
      ;;
  esac
  shift
done

release_repo_path() {
  if [ -n "$AGENTHUB_RELEASE_BASE" ]; then
    case "$AGENTHUB_RELEASE_BASE" in
      http://*|https://*|file://*) printf '%s' "${AGENTHUB_RELEASE_BASE%/}" ;;
      *) printf 'file://%s' "${AGENTHUB_RELEASE_BASE%/}" ;;
    esac
    return
  fi
  case "$AGENTHUB_RELEASE_REPO" in
    http://*|https://*) printf '%s' "$AGENTHUB_RELEASE_REPO" | sed 's#/$##' ;;
    *) printf 'https://github.com/%s' "$AGENTHUB_RELEASE_REPO" ;;
  esac
}

release_checksum() {
  _file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$_file"
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$_file"
  else
    echo "Lỗi: cần sha256sum hoặc shasum để kiểm tra bản tải xuống." >&2
    return 1
  fi
}

# Find a Node binary of the given major version (the one the release's native modules were built
# for). Release installs use a self-contained runtime when PATH has no suitable Node. nvm is only
# considered after the user explicitly passes --use-nvm. Prints the absolute path of the node.
install_node_runtime() {
  _want="$1"
  _os="$2"
  _machine="$3"
  case "$_os:$_machine" in
    Darwin:arm64) _node_platform=darwin-arm64 ;;
    Darwin:x86_64|Darwin:amd64) _node_platform=darwin-x64 ;;
    Linux:arm64|Linux:aarch64) _node_platform=linux-arm64 ;;
    Linux:x86_64|Linux:amd64) _node_platform=linux-x64 ;;
    *)
      echo "Lỗi: không có Node.js $_want tích hợp cho $_os/$_machine." >&2
      _failure_reason="không có Node.js $_want tích hợp cho $_os/$_machine"
      return 1
      ;;
  esac

  _runtime_root="$AGENTHUB_DATA_DIR/runtime"
  _runtime_dir="$_runtime_root/node-v${_want}.x"
  if [ -x "$_runtime_dir/bin/node" ]; then
    printf '%s' "$_runtime_dir/bin/node"
    return 0
  fi

  _node_tmp="${TMPDIR:-/tmp}/agenthub-node.$$"
  mkdir -p "$_node_tmp"
  _node_base="https://nodejs.org/dist/latest-v${_want}.x"
  _install_step="tải Node.js runtime"
  if ! curl -fsSL "$_node_base/SHASUMS256.txt" -o "$_node_tmp/SHASUMS256.txt"; then
    _failure_reason="không tải được danh sách checksum Node.js $_want"
    echo "Lỗi: không tải được Node.js $_want từ $_node_base." >&2
    rm -rf "$_node_tmp"
    return 1
  fi
  _node_archive="$(awk -v suffix="-${_node_platform}.tar.gz" '$2 ~ ("^node-v[0-9][0-9]*\\.[0-9][0-9]*\\.[0-9][0-9]*" suffix "$") { print $2; exit }' "$_node_tmp/SHASUMS256.txt")"
  if [ -z "$_node_archive" ]; then
    _failure_reason="không tìm được archive Node.js $_want cho $_node_platform"
    echo "Lỗi: không tìm được Node.js $_want cho kiến trúc $_node_platform." >&2
    rm -rf "$_node_tmp"
    return 1
  fi
  if ! curl -fsSL "$_node_base/$_node_archive" -o "$_node_tmp/$_node_archive"; then
    _failure_reason="không tải được $_node_archive"
    echo "Lỗi: không tải được $_node_archive." >&2
    rm -rf "$_node_tmp"
    return 1
  fi
  _expected="$(awk -v file="$_node_archive" '$2 == file { print $1; exit }' "$_node_tmp/SHASUMS256.txt")"
  _actual="$(release_checksum "$_node_tmp/$_node_archive" | awk '{print $1}')"
  if [ -z "$_expected" ] || [ "$_expected" != "$_actual" ]; then
    _failure_reason="kiểm tra SHA256 thất bại cho $_node_archive"
    echo "Lỗi: kiểm tra SHA256 thất bại cho $_node_archive." >&2
    rm -rf "$_node_tmp"
    return 1
  fi
  _node_extract="$_node_tmp/extract"
  mkdir -p "$_node_extract" "$_runtime_root"
  tar -xzf "$_node_tmp/$_node_archive" -C "$_node_extract"
  _node_source="$_node_extract/${_node_archive%.tar.gz}"
  if [ ! -x "$_node_source/bin/node" ]; then
    _failure_reason="archive Node.js thiếu bin/node"
    echo "Lỗi: archive Node.js tải xuống không hợp lệ." >&2
    rm -rf "$_node_tmp"
    return 1
  fi
  rm -rf "$_runtime_dir"
  mv "$_node_source" "$_runtime_dir"
  rm -rf "$_node_tmp"
  printf '%s' "$_runtime_dir/bin/node"
}

find_node_major() {
  _want="$1"
  _cur="$(command -v node 2>/dev/null || true)"
  if [ -n "$_cur" ] && [ "$("$_cur" -p 'process.versions.node.split(".")[0]' 2>/dev/null)" = "$_want" ]; then
    printf '%s' "$_cur"; return 0
  fi
  if [ "$USE_NVM" != "1" ]; then
    install_node_runtime "$_want" "$(uname -s)" "$(uname -m)"
    return $?
  fi
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  # shellcheck source=/dev/null
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
  if ! command -v nvm >/dev/null 2>&1; then
    echo "AgentHub cần Node $_want (máy đang có: ${_cur:+$("$_cur" -v)}${_cur:-không có Node})." >&2
    echo "AgentHub không tự cài nvm. Hãy dùng --use-nvm hoặc cài Node $_want rồi chạy lại." >&2
  fi
  if ! command -v nvm >/dev/null 2>&1; then
    echo "Lỗi: cần Node $_want. Cài Node $_want, hoặc chạy lại với --use-nvm." >&2
    return 1
  fi
  _path="$(nvm which "$_want" 2>/dev/null || true)"
  if [ -z "$_path" ] || [ ! -x "$_path" ]; then
    if prompt_yes_no "Cài Node $_want qua nvm cho AgentHub?" "y"; then
      nvm install "$_want" >&2 || return 1
      _path="$(nvm which "$_want" 2>/dev/null || true)"
    fi
  fi
  if [ -z "$_path" ] || [ ! -x "$_path" ]; then
    echo "Lỗi: không tìm được Node $_want qua nvm." >&2
    return 1
  fi
  printf '%s' "$_path"
}

check_native_modules() {
  _native_root="$1"
  # Packages such as node-pty ship prebuilds for every platform; only this host's one can load.
  _native_plat="$("$_node_bin" -p 'process.platform + "-" + process.arch' 2>/dev/null || true)"
  for _native_name in node-pty better-sqlite3; do
    _native_dir="$_native_root/node_modules/$_native_name"
    [ -d "$_native_dir" ] || continue
    # Load the package the way the app does, so it picks the binary built for this platform.
    _native_output="$("$_node_bin" -e 'require(process.argv[1])' "$_native_dir" 2>&1)" || {
      installer_log "native $_native_name ($_native_dir): $_native_output"
      echo "Lỗi: module native không nạp được: $_native_name ($_native_dir)" >&2
      if printf '%s' "$_native_output" | grep -Eqi 'GLIBC_[0-9]+\.[0-9]+'; then
        _glibc_need="$(printf '%s' "$_native_output" | sed -n 's/.*GLIBC_\([0-9][0-9]*\.[0-9][0-9]*\).*/\1/p' | sort -V | tail -n 1)"
        _glibc_have="$(getconf GNU_LIBC_VERSION 2>/dev/null || true)"
        echo "Máy đang có: ${_glibc_have:-không xác định}; ldd: $(ldd --version 2>&1 | head -n 1)" >&2
        echo "Bản phát hành này cần glibc ≥ ${_glibc_need:-yêu cầu trong lỗi}; hãy dùng bản mới hơn hoặc nâng cấp hệ điều hành" >&2
        _failure_reason="$_native_name cần glibc ≥ ${_glibc_need:-phiên bản cao hơn}"
      elif printf '%s' "$_native_output" | grep -Eqi 'NODE_MODULE_VERSION'; then
        _node_abi="$("$_node_bin" -p 'process.versions.modules' 2>/dev/null || echo '?')"
        echo "Node đang dùng: $("$_node_bin" -v 2>/dev/null || echo '?'); ABI đang dùng: $_node_abi; bản gói cần xem trong lỗi trên." >&2
        echo "Hãy dùng đúng Node của bản phát hành hoặc tải lại gói tương thích." >&2
        _failure_reason="$_native_name sai ABI Node"
      elif printf '%s' "$_native_output" | grep -Eqi 'MODULE_NOT_FOUND|cannot open shared object|No such file'; then
        echo "Gói release bị thiếu file native; hãy tải lại bản phát hành." >&2
        _failure_reason="$_native_name bị thiếu file native"
      else
        _failure_reason="$_native_name không nạp được"
      fi
      return 1
    }
  done
  # Also inspect vendor modules with a non-standard package name. This gives a
  # useful filename for corrupt archives instead of hiding it behind setup.
  for _native_file in $(find "$_native_root/node_modules" -type f -name '*.node' -print 2>/dev/null); do
    case "$_native_file" in
      */node-pty/*|*/better-sqlite3/*) continue ;;
      */prebuilds/"$_native_plat"/*) ;;
      */prebuilds/*) continue ;;
    esac
    _native_output="$("$_node_bin" -e 'process.dlopen(module, process.argv[1])' "$_native_file" 2>&1)" || {
      installer_log "native file ($_native_file): $_native_output"
      echo "Lỗi: module native không nạp được: $_native_file" >&2
      if printf '%s' "$_native_output" | grep -Eqi 'GLIBC_[0-9]+\.[0-9]+'; then
        _glibc_need="$(printf '%s' "$_native_output" | sed -n 's/.*GLIBC_\([0-9][0-9]*\.[0-9][0-9]*\).*/\1/p' | sort -V | tail -n 1)"
        echo "Bản phát hành này cần glibc ≥ ${_glibc_need:-yêu cầu trong lỗi}; hãy dùng bản mới hơn hoặc nâng cấp hệ điều hành" >&2
        _failure_reason="file native cần glibc ≥ ${_glibc_need:-phiên bản cao hơn}"
      elif printf '%s' "$_native_output" | grep -Eqi 'NODE_MODULE_VERSION'; then
        echo "Node đang dùng: $("$_node_bin" -v 2>/dev/null || echo '?'); bản gói cần xem trong lỗi trên." >&2
        _failure_reason="file native sai ABI Node"
      else
        echo "Gói release bị thiếu hoặc hỏng file native; hãy tải lại bản phát hành." >&2
        _failure_reason="file native không nạp được"
      fi
      return 1
    }
  done
  return 0
}

validate_release_version() {
  printf '%s\n' "$1" | sed -n '/^[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\(-[0-9A-Za-z.][0-9A-Za-z.]*\)\{0,1\}$/p'
}

extract_release_tag_from_url() {
  _url="$1"
  _tag="$(printf '%s' "$_url" | sed -n 's#.*/releases/tag/\([^/?#]*\).*#\1#p')"
  case "$_tag" in
    [vV]*) _tag="${_tag#[vV]}" ;;
  esac
  printf '%s' "$_tag"
}

extract_release_tag_from_json() {
  _json="$1"
  _nl='
'
  _tag="$(printf '%s' "$_json" | sed "s/\"tag_name\"/\\$_nl&/g" | sed -n 's/^"tag_name"[[:space:]]*:[[:space:]]*"v\{0,1\}\([^"[:space:]]*\)".*/\1/p' | head -n 1)"
  case "$_tag" in
    [vV]*) _tag="${_tag#[vV]}" ;;
  esac
  printf '%s' "$_tag"
}

resolve_latest_release_version() {
  _base="$1"
  _owner_repo=""
  case "$_base" in
    https://github.com/*|http://github.com/*)
      _owner_repo="$(printf '%s' "$_base" | sed -n 's#^https\{0,1\}://github\.com/\([^/][^/]*/[^/][^/]*\).*#\1#p')"
      _owner_repo="${_owner_repo%.git}"
      ;;
  esac

  if [ -n "$_owner_repo" ]; then
    _latest_url="$_base/releases/latest"
    _api_latest="https://api.github.com/repos/$_owner_repo/releases/latest"
    _api_all="https://api.github.com/repos/$_owner_repo/releases?per_page=1"

    # 1. Primary: redirect URL from releases/latest
    _redir_resp="$(curl -fsSLI -o /dev/null -w "HTTP_CODE:%{http_code}\nURL:%{url_effective}" "$_latest_url" 2>/dev/null || true)"
    _redir_code="$(printf '%s\n' "$_redir_resp" | sed -n 's/^HTTP_CODE:\([0-9][0-9]*\)/\1/p')"
    _eff_url="$(printf '%s\n' "$_redir_resp" | sed -n 's/^URL://p')"
    if [ -n "$_eff_url" ] && case "$_eff_url" in */releases/tag/*) true ;; *) false ;; esac; then
      _tag="$(extract_release_tag_from_url "$_eff_url")"
      if [ -n "$_tag" ] && [ -n "$(validate_release_version "$_tag")" ]; then
        RELEASE_VERSION="$_tag"
        installer_log "release resolve: URL $_latest_url redirected to $_eff_url (HTTP ${_redir_code:-unknown}, version $RELEASE_VERSION)"
        return 0
      fi
      installer_log "release resolve: URL $_latest_url redirected to $_eff_url (HTTP ${_redir_code:-unknown}) but tag '$_tag' is not valid semver"
    else
      installer_log "release resolve: URL $_latest_url redirect failed (HTTP ${_redir_code:-unknown}, effective URL: ${_eff_url:-none})"
    fi

    # 2. Fallback 1: GitHub API releases/latest
    _api_resp="$(curl -sSL -w "\nHTTP_CODE:%{http_code}" "$_api_latest" 2>/dev/null || true)"
    _http_code="$(printf '%s\n' "$_api_resp" | sed -n 's/^HTTP_CODE:\([0-9][0-9]*\)/\1/p')"
    _api_body="$(printf '%s\n' "$_api_resp" | sed '/^HTTP_CODE:/d')"
    installer_log "release resolve: URL $_api_latest (HTTP ${_http_code:-unknown})"

    if [ "$_http_code" != "404" ]; then
      _tag="$(extract_release_tag_from_json "$_api_body")"
      if [ -n "$_tag" ] && [ -n "$(validate_release_version "$_tag")" ]; then
        RELEASE_VERSION="$_tag"
        installer_log "release resolve: URL $_api_latest returned version $RELEASE_VERSION"
        return 0
      fi
    fi

    # 3. Fallback 2: GitHub API releases?per_page=1 (includes pre-releases)
    _api_resp="$(curl -sSL -w "\nHTTP_CODE:%{http_code}" "$_api_all" 2>/dev/null || true)"
    _http_code="$(printf '%s\n' "$_api_resp" | sed -n 's/^HTTP_CODE:\([0-9][0-9]*\)/\1/p')"
    _api_body="$(printf '%s\n' "$_api_resp" | sed '/^HTTP_CODE:/d')"
    installer_log "release resolve: URL $_api_all (HTTP ${_http_code:-unknown})"

    _tag="$(extract_release_tag_from_json "$_api_body")"
    if [ -n "$_tag" ] && [ -n "$(validate_release_version "$_tag")" ]; then
      RELEASE_VERSION="$_tag"
      echo "! Cảnh báo: đang dùng phiên bản pre-release (v$RELEASE_VERSION)." >&2
      installer_log "release resolve: URL $_api_all returned pre-release version $RELEASE_VERSION"
      return 0
    fi

    _failure_reason="không xác định được phiên bản release mới nhất"
    echo "Lỗi: không xác định được phiên bản release mới nhất." >&2
    echo "Đã thử các URL:" >&2
    echo "  - $_latest_url" >&2
    echo "  - $_api_latest" >&2
    echo "  - $_api_all" >&2
    echo "Gợi ý: hãy chỉ định phiên bản bằng --from-release <version>." >&2
    return 1
  fi

  # Non-GitHub base (fallback for file://, local directories, or fake servers returning JSON)
  _latest_url="$_base/releases/latest"
  _release_json="$(curl -fsSL "$_latest_url" 2>/dev/null || true)"
  _tag="$(extract_release_tag_from_json "$_release_json")"
  if [ -n "$_tag" ] && [ -n "$(validate_release_version "$_tag")" ]; then
    RELEASE_VERSION="$_tag"
    installer_log "release resolve: URL $_latest_url returned version $RELEASE_VERSION"
    return 0
  fi

  _failure_reason="không xác định được phiên bản release mới nhất"
  echo "Lỗi: không xác định được phiên bản release mới nhất." >&2
  echo "Đã thử URL: $_latest_url" >&2
  echo "Gợi ý: hãy chỉ định phiên bản bằng --from-release <version>." >&2
  return 1
}

install_from_release() {
  _install_step="kiểm tra công cụ"
  if ! command -v curl >/dev/null 2>&1 || ! command -v tar >/dev/null 2>&1; then
    _failure_reason="thiếu curl hoặc tar"
    echo "Lỗi: --from-release cần curl và tar." >&2
    return 1
  fi

  _base="$(release_repo_path)"
  if [ "$RELEASE_VERSION_SET" = "1" ]; then
    case "$RELEASE_VERSION" in
      [vV]*) RELEASE_VERSION="${RELEASE_VERSION#[vV]}" ;;
    esac
    case "$RELEASE_VERSION" in
      ''|*[!0-9A-Za-z._-]*) echo "Lỗi: phiên bản release không hợp lệ." >&2; return 1 ;;
    esac
  fi
  if [ -z "$RELEASE_VERSION" ]; then
    _install_step="xác định phiên bản release"
    if ! resolve_latest_release_version "$_base"; then
      _failure_reason="không xác định được phiên bản release mới nhất"
      return 1
    fi
  fi
  case "$RELEASE_VERSION" in
    [vV]*) RELEASE_VERSION="${RELEASE_VERSION#[vV]}" ;;
  esac
  case "$RELEASE_VERSION" in
    ''|*[!0-9A-Za-z._-]*) echo "Lỗi: phiên bản release không hợp lệ." >&2; return 1 ;;
  esac

  _os="$(uname -s)"
  case "$_os" in Linux*) _platform=linux ;; Darwin*) _platform=macos ;; *) echo "Lỗi: hệ điều hành $_os chưa được hỗ trợ." >&2; return 1 ;; esac
  _machine="$(uname -m)"
  case "$_machine" in
    x86_64|amd64) _arch=x64 ;;
    aarch64|arm64) _arch=arm64 ;;
    *) echo "Lỗi: không có archive AgentHub cho kiến trúc $_machine ($_platform)." >&2; return 1 ;;
  esac
  _archive="agenthub-${RELEASE_VERSION}-${_platform}-${_arch}"
  _archive="${_archive}.tar.gz"
  _install_step="tải release"
  _release_tmp="${TMPDIR:-/tmp}/agenthub-release.$$"
  _tmp="$_release_tmp"
  mkdir -p "$_tmp"
  echo "==> Tải AgentHub v$RELEASE_VERSION..."
  if ! curl -fsSL "$_base/releases/download/v$RELEASE_VERSION/$_archive" -o "$_tmp/$_archive"; then
    _failure_reason="không tải được archive $_archive"
    echo "Lỗi: không tìm thấy archive $_archive cho OS/arch hiện tại ($_os/$_machine)." >&2
    return 1
  fi
  if ! curl -fsSL "$_base/releases/download/v$RELEASE_VERSION/SHA256SUMS" -o "$_tmp/SHA256SUMS"; then
    _failure_reason="không tải được SHA256SUMS"
    return 1
  fi
  _expected="$(awk -v file="$_archive" '$2 == file { print $1; exit }' "$_tmp/SHA256SUMS")"
  _actual="$(release_checksum "$_tmp/$_archive" | awk '{print $1}')"
  if [ -z "$_expected" ] || [ "$_expected" != "$_actual" ]; then
    _failure_reason="kiểm tra SHA256 thất bại cho $_archive"
    echo "Lỗi: kiểm tra SHA256 thất bại cho $_archive." >&2
    return 1
  fi

  _release_root="$AGENTHUB_DIR"
  _release_dir="$_release_root/$RELEASE_VERSION"
  _release_stage="$_release_root/.${RELEASE_VERSION}.tmp.$$"
  _install_step="chuẩn bị thư mục stage"
  mkdir -p "$_release_root"
  cleanup_stale_tmp_dirs
  rm -rf "$_release_stage"
  mkdir -p "$_release_stage"
  _install_step="giải nén release"
  tar -xzf "$_tmp/$_archive" -C "$_release_stage"
  if [ "$_os" = "Darwin" ] && command -v xattr >/dev/null 2>&1; then
    xattr -dr com.apple.quarantine "$_release_stage" 2>/dev/null || true
  fi
  # Pin the Node major the bundled native modules were built for (see scripts/package.mjs).
  _node_major="$(cat "$_release_stage/node-runtime" 2>/dev/null || echo 22)"
  _install_step="tìm Node phù hợp"
  _node_bin="$(find_node_major "$_node_major")" || { _failure_reason="không tìm được Node.js $_node_major"; return 1; }
  printf '%s\n' "$_node_bin" > "$_release_stage/.node-bin"
  echo "✓ Dùng Node $("$_node_bin" -v) cho AgentHub ($_node_bin)"
  PATH="$(dirname "$_node_bin"):$PATH"
  export PATH
  if [ -d "$_release_stage/node_modules" ]; then
    echo "✓ Gói đã có sẵn node_modules production; bỏ qua npm ci."
  else
    echo "==> Gói không có node_modules; kiểm tra compiler để build native..."
    case "$_os" in
      Linux*)
        if ! command -v python3 >/dev/null 2>&1 || ! command -v make >/dev/null 2>&1 || ! command -v g++ >/dev/null 2>&1; then
          echo "Lỗi: thiếu compiler native. Cài bằng: sudo apt install python3 make g++" >&2
          return 1
        fi
        ;;
      Darwin*)
        if ! command -v xcode-select >/dev/null 2>&1 || ! xcode-select -p >/dev/null 2>&1; then
          echo "Lỗi: thiếu Xcode Command Line Tools. Cài bằng: xcode-select --install" >&2
          return 1
        fi
        ;;
    esac
    echo "==> Cài dependencies native theo máy..."
    _install_step="cài dependencies native"
    (cd "$_release_stage" && npm ci --omit=dev) || { _failure_reason="npm ci --omit=dev thất bại"; return 1; }
  fi
  # Run setup before switching the live pointers, without attempting a service install.
  _install_step="kiểm tra module native"
  check_native_modules "$_release_stage" || return 1
  _install_step="setup"
  if ! (cd "$_release_stage" && AGENTHUB_WORKER=1 ./bin/agenthub setup --no-browser); then
    _failure_reason="agenthub setup thất bại"
    return 1
  fi

  _install_step="lưu trạng thái bản trước"
  _old_current=""
  [ -L "$_release_root/current" ] && _old_current="$(readlink "$_release_root/current")"
  _link_file="$AGENTHUB_LINK_DIR/agenthub"
  _old_link=""
  [ -L "$_link_file" ] && _old_link="$(readlink "$_link_file")"
  case "$_os" in
    Darwin*) _service_file="$HOME/Library/LaunchAgents/dev.agenthub.plist" ;;
    *) _service_file="$HOME/.config/systemd/user/agenthub.service" ;;
  esac
  _old_service_backup="$_tmp/service.before"
  [ -f "$_service_file" ] && cp "$_service_file" "$_old_service_backup"

  if [ -e "$_release_dir" ] || [ -L "$_release_dir" ]; then
    _release_backup="$_release_root/.${RELEASE_VERSION}.rollback.$$"
    rm -rf "$_release_backup"
    mv "$_release_dir" "$_release_backup"
  fi
  _install_step="chuyển current"
  mv "$_release_stage" "$_release_dir"
  _release_stage=""
  ln -sfn "$RELEASE_VERSION" "$_release_root/current"
  _pointers_changed=1
  _install_step="tạo symlink CLI"
  if ! "$_release_root/current/bin/agenthub" link; then _failure_reason="không tạo được symlink CLI"; return 1; fi
  _install_step="cài service"
  if ! "$_release_root/current/bin/agenthub" install-service; then _failure_reason="cài service thất bại"; return 1; fi
  _install_step="mở dashboard"
  if ! "$_release_root/current/bin/agenthub" open --no-browser; then _failure_reason="không mở được dashboard"; return 1; fi
  _install_step="ghi metadata"
  printf 'mode=release\nversion=%s\ndate=%s\n' "$RELEASE_VERSION" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" > "$_release_root/.agenthub-app"

  find "$_release_root" -mindepth 1 -maxdepth 1 -type d -name '.*.tmp.*' -exec rm -rf {} +
  _kept=0
  for _old in $(find "$_release_root" -mindepth 1 -maxdepth 1 -type d ! -name '.*' -print | sort -V -r); do
    _name="${_old##*/}"
    [ "$_name" = "$RELEASE_VERSION" ] && continue
    _kept=$((_kept + 1))
    if [ "$_kept" -gt 2 ]; then
      rm -rf "$_old"
    fi
  done
  [ -n "$_release_backup" ] && rm -rf "$_release_backup"
  _install_success=1
  echo "✓ Đã cài AgentHub v$RELEASE_VERSION; bản hiện tại: $_release_root/current"
}

if [ "$FROM_RELEASE" = "1" ]; then
  INSTALL_LOG="${INSTALL_LOG:-${TMPDIR:-/tmp}/agenthub-install-$(date +%s).log}"
  : > "$INSTALL_LOG"
  installer_log "installer started"
  trap 'installer_cleanup "$?"' EXIT
  trap 'installer_signal HUP 129' HUP
  trap 'installer_signal INT 130' INT
  trap 'installer_signal TERM 143' TERM
  if [ "$DRY_RUN" = "1" ]; then
    echo "[dry-run] tải release v${RELEASE_VERSION:-latest} từ $(release_repo_path)"
    echo "[dry-run] kiểm tra SHA256, giải nén vào $AGENTHUB_DIR/<version>, cập nhật symlink current"
    echo "[dry-run] dùng node_modules production trong archive (hoặc npm ci --omit=dev nếu thiếu)"
    echo "[dry-run] agenthub setup --no-browser"
    exit 0
  fi
  install_from_release
  exit $?
fi

# ------------------------------------------------------------------------------
# Handle --uninstall
# ------------------------------------------------------------------------------
if [ "$UNINSTALL" = "1" ]; then
  echo "==> Đang gỡ bỏ AgentHub..."

  if [ "$DRY_RUN" = "1" ]; then
    echo "[dry-run] $SYSTEMCTL --user stop agenthub"
    echo "[dry-run] $SYSTEMCTL --user disable agenthub"
    echo "[dry-run] $SYSTEMCTL --user daemon-reload"
    echo "[dry-run] $LAUNCHCTL bootout gui/$(id -u)/dev.agenthub"
    echo "[dry-run] rm -f $AGENTHUB_LINK_DIR/agenthub"
    if is_safe_app_dir; then
      echo "[dry-run] rm -rf $AGENTHUB_DIR"
    else
      echo "[dry-run] bỏ qua xoá app: không có dấu installer an toàn tại $AGENTHUB_DIR"
    fi
    if [ "$PURGE" = "1" ]; then
      if is_safe_data_dir; then
        echo "[dry-run] rm -rf $AGENTHUB_DATA_DIR (sau khi xác nhận)"
      else
        echo "[dry-run] bỏ qua purge: thư mục dữ liệu không có dấu hiệu an toàn tại $AGENTHUB_DATA_DIR"
      fi
    fi
    exit 0
  fi

  # Only remove exact staging names inside the configured app directory; never
  # recursively delete arbitrary user directories just because their names look temporary.
  cleanup_stale_tmp_dirs

  # 1. Gỡ service theo nền tảng
  OS="$(uname -s)"
  case "$OS" in
    Darwin*)
      UID_NUM="$(id -u)"
      PLIST_FILE="$HOME/Library/LaunchAgents/dev.agenthub.plist"
      if [ -f "$PLIST_FILE" ]; then
        "$LAUNCHCTL" bootout "gui/$UID_NUM/dev.agenthub" 2>/dev/null || "$LAUNCHCTL" bootout "gui/$UID_NUM" "$PLIST_FILE" 2>/dev/null || true
        rm -f "$PLIST_FILE"
        echo "✓ Đã gỡ LaunchAgent dev.agenthub"
      fi
      ;;
    Linux*)
      SERVICE_FILE="$HOME/.config/systemd/user/agenthub.service"
      if [ -f "$SERVICE_FILE" ] || command -v systemctl >/dev/null 2>&1; then
        "$SYSTEMCTL" --user stop agenthub 2>/dev/null || true
        "$SYSTEMCTL" --user disable agenthub 2>/dev/null || true
        rm -f "$SERVICE_FILE"
        "$SYSTEMCTL" --user daemon-reload 2>/dev/null || true
        echo "✓ Đã gỡ systemd user service agenthub"
      fi
      ;;
  esac

  # 2. Gỡ symlink
  LINK_FILE="$AGENTHUB_LINK_DIR/agenthub"
  if [ -L "$LINK_FILE" ] || [ -f "$LINK_FILE" ]; then
    rm -f "$LINK_FILE"
    echo "✓ Đã xoá symlink: $LINK_FILE"
  fi

  # 3. Gỡ thư mục mã nguồn app
  if is_safe_app_dir; then
    rm -rf "$AGENTHUB_DIR"
    echo "✓ Đã xoá thư mục ứng dụng: $AGENTHUB_DIR"
  elif [ -d "$AGENTHUB_DIR" ]; then
    echo "! Bỏ qua xoá thư mục ứng dụng không có dấu installer an toàn: $AGENTHUB_DIR"
  fi

  # 4. Xử lý dữ liệu ~/.agenthub
  if [ "$PURGE" = "1" ]; then
    echo "CẢNH BÁO: Bạn đã chọn cờ --purge."
    echo "Thao tác này sẽ xoá TOÀN BỘ dữ liệu cấu hình, task, và database tại: $AGENTHUB_DATA_DIR"
    if is_safe_data_dir; then
      if prompt_yes_no "Bạn có chắc chắn muốn xoá toàn bộ dữ liệu AgentHub không?" "n"; then
        rm -rf "$AGENTHUB_DATA_DIR"
        echo "✓ Đã xoá toàn bộ dữ liệu tại: $AGENTHUB_DATA_DIR"
      else
        echo "Đã huỷ xoá dữ liệu. Dữ liệu tại $AGENTHUB_DATA_DIR vẫn được giữ nguyên."
      fi
    else
      echo "! Bỏ qua purge: thư mục không có dấu hiệu dữ liệu AgentHub an toàn (cần hub.db hoặc config.json)."
    fi
  else
    echo "Dữ liệu cấu hình và task tại $AGENTHUB_DATA_DIR được giữ nguyên."
    echo "Nếu muốn xoá toàn bộ dữ liệu, chạy lại lệnh với cờ --purge:"
    echo "  install.sh --uninstall --purge"
  fi

  echo "✓ Hoàn tất gỡ cài đặt AgentHub."
  exit 0
fi

# ------------------------------------------------------------------------------
# Normal Installation / Update Flow
# ------------------------------------------------------------------------------
OS="$(uname -s)"
case "$OS" in
  Linux*|Darwin*) ;;
  *)
    echo "Lỗi: Hệ điều hành $OS chưa được hỗ trợ trực tiếp." >&2
    echo "AgentHub hỗ trợ Linux và macOS (hoặc WSL2 trên Windows)." >&2
    exit 1
    ;;
esac

if [ "$DRY_RUN" = "1" ]; then
  echo "[dry-run] git clone/fetch $AGENTHUB_REPO -> $AGENTHUB_DIR"
  echo "[dry-run] npm ci && npm run build && npm run build:web (tại $AGENTHUB_DIR)"
  echo "[dry-run] agenthub link"
  echo "[dry-run] agenthub install-service"
  echo "[dry-run] agenthub setup --no-browser"
  echo "[dry-run] agenthub open --no-browser"
  exit 0
fi

echo "========================================="
echo " Cài đặt AgentHub"
echo " Thư mục ứng dụng : $AGENTHUB_DIR"
echo " Thư mục dữ liệu  : $AGENTHUB_DATA_DIR"
echo "========================================="

# 1. Kiểm tra / cài đặt Node 22 (nvm chỉ khi có --use-nvm)
if [ "$USE_NVM" = "1" ] && [ -s "$HOME/.nvm/nvm.sh" ]; then
  export NVM_DIR="$HOME/.nvm"
  # shellcheck source=/dev/null
  . "$NVM_DIR/nvm.sh"
  nvm use 22 >/dev/null 2>&1 || true
fi

if ! node_is_v22_or_higher; then
  echo ""
  echo "AgentHub yêu cầu Node.js >= 22."
  if [ "$USE_NVM" = "1" ]; then
    export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
    [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
    if ! command -v nvm >/dev/null 2>&1; then
      echo "Lỗi: không tìm thấy nvm. Cài nvm hoặc bỏ --use-nvm để dùng runtime tích hợp." >&2
      exit 1
    fi
    echo "==> Đang cài đặt Node 22 qua nvm..."
    nvm install 22
    nvm use 22
  else
    _node_bin="$(find_node_major 22)" || {
      echo "Lỗi: không tìm được Node.js 22. Cài Node 22, hoặc chạy lại với --use-nvm." >&2
      exit 1
    }
    PATH="$(dirname "$_node_bin"):$PATH"
    export PATH
  fi

  if ! node_is_v22_or_higher; then
    echo "Lỗi: Không tìm thấy Node.js >= 22 sau khi cài đặt." >&2
    exit 1
  fi
fi

echo "✓ Sử dụng Node.js $(node -v) (npm $(npm -v))"

# 2. Clone hoặc cập nhật vào AGENTHUB_DIR
if ! command -v git >/dev/null 2>&1 || ! git --version >/dev/null 2>&1; then
  if [ "$OS" = "Darwin" ] && command -v xcode-select >/dev/null 2>&1 && ! xcode-select -p >/dev/null 2>&1; then
    echo "Lỗi: macOS chưa có Xcode Command Line Tools nên git chưa sẵn sàng." >&2
    echo "Cần chạy: xcode-select --install, xong chạy lại lệnh cài." >&2
    echo "Lệnh cài release không cần git: curl -fsSL https://raw.githubusercontent.com/ducanh19020217/agenthub/main/scripts/install.sh | sh -s -- --from-release" >&2
  else
    echo "Lỗi: cần git để cài từ mã nguồn. Hãy cài git rồi chạy lại lệnh cài." >&2
  fi
  exit 1
fi
if [ ! -d "$AGENTHUB_DIR" ]; then
  echo "==> Đang clone mã nguồn vào $AGENTHUB_DIR..."
  git clone "$AGENTHUB_REPO" "$AGENTHUB_DIR"
  _CLONED_BY_INSTALLER=1
elif [ -d "$AGENTHUB_DIR/.git" ]; then
  echo "==> Cập nhật mã nguồn tại $AGENTHUB_DIR..."
  (
    cd "$AGENTHUB_DIR"
    git fetch --tags origin 2>/dev/null || git fetch --tags 2>/dev/null || true
    _LATEST_TAG="$(git tag -l --sort=-v:refname 2>/dev/null | head -n 1)"
    if [ -n "$_LATEST_TAG" ]; then
      git checkout "$_LATEST_TAG" 2>/dev/null || true
    else
      git pull 2>/dev/null || true
    fi
  )
else
  echo "==> Sử dụng thư mục mã nguồn: $AGENTHUB_DIR"
fi

# 3. npm ci + build + build:web
echo "==> Cài đặt dependencies và build..."
(
  cd "$AGENTHUB_DIR"
  if [ "$USE_NVM" = "1" ] && [ -s "$HOME/.nvm/nvm.sh" ]; then
    export NVM_DIR="$HOME/.nvm"
    # shellcheck source=/dev/null
    . "$NVM_DIR/nvm.sh"
    nvm use 22 >/dev/null 2>&1 || true
  fi
  npm ci
  if [ -f "web/package.json" ]; then
    npm --prefix web ci
  fi
  npm run build
  npm run build:web
)

# 3b. Đánh dấu thư mục do installer quản lý để uninstall có thể tự bảo vệ.
_installed_version="unknown"
if [ -f "$AGENTHUB_DIR/package.json" ]; then
  _installed_version="$(sed -n 's/.*\"version\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p' "$AGENTHUB_DIR/package.json" | head -n 1)"
  [ -n "$_installed_version" ] || _installed_version="unknown"
fi
# Only mark directories this installer created (or marked before): an existing checkout the
# user pointed AGENTHUB_DIR at must never become removable by --uninstall.
if [ "${_CLONED_BY_INSTALLER:-0}" = "1" ] || [ -f "$AGENTHUB_DIR/.agenthub-app" ]; then
  printf 'version=%s\ndate=%s\n' "$_installed_version" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" > "$AGENTHUB_DIR/.agenthub-app"
  if [ -d "$AGENTHUB_DIR/.git" ]; then
    git -C "$AGENTHUB_DIR" config agenthub.installed true
  fi
else
  echo "Lưu ý: $AGENTHUB_DIR không do bộ cài tạo nên sẽ không bị xoá khi --uninstall."
fi

# 4. agenthub link
echo "==> Thiết lập symlink binary CLI..."
"$AGENTHUB_DIR/bin/agenthub" link

case ":$PATH:" in
  *:"$AGENTHUB_LINK_DIR":*) ;;
  *)
    echo "! Lưu ý: $AGENTHUB_LINK_DIR chưa nằm trong PATH."
    echo "  Hãy thêm dòng sau vào ~/.bashrc hoặc ~/.zshrc:"
    echo "    export PATH=\"\$HOME/.local/bin:\$PATH\""
    ;;
esac

# 5. agenthub install-service
echo "==> Cài đặt service chạy nền..."
"$AGENTHUB_DIR/bin/agenthub" install-service

# 6. Chuẩn bị bộ công cụ cho lần chạy đầu tiên
echo "==> Kiểm tra bộ công cụ AgentHub..."
"$AGENTHUB_DIR/bin/agenthub" setup --no-browser

# 7. in URL dashboard
echo ""
echo "==> Web Dashboard URL:"
"$AGENTHUB_DIR/bin/agenthub" open --no-browser
echo ""
echo "================================================="
echo "✓ Cài đặt AgentHub thành công!"
echo "  Để mở Web Dashboard : agenthub open"
echo "  Để kiểm tra hệ thống: agenthub doctor"
echo "  Để cập nhật sau này : agenthub update"
echo "================================================="
