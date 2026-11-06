#!/usr/bin/env bash
# ==============================================================================
# Tắt AgentHub Production (service nền do scripts/run-prod.sh bật)
# Dự án: AgentHub
# ==============================================================================

set -eo pipefail

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -P "$SCRIPT_DIR/.." && pwd)"

if [ -s "$HOME/.nvm/nvm.sh" ]; then
  export NVM_DIR="$HOME/.nvm"
  # shellcheck source=/dev/null
  . "$NVM_DIR/nvm.sh"
  nvm use 22 >/dev/null 2>&1 || true
fi

cd "$ROOT_DIR"

DISABLE=0
case "${1:-}" in
  -h|--help)
    echo "Cách dùng: $0 [--disable]"
    echo ""
    echo "  (không truyền)   Tắt service, lưu task đang chạy để tiếp tục khi bật lại"
    echo "  --disable        Tắt và không tự bật lại khi đăng nhập/khởi động máy"
    echo ""
    echo "Bật lại bằng: ./scripts/run-prod.sh"
    exit 0
    ;;
  --disable) DISABLE=1 ;;
  "") ;;
  *) echo "❌ Tùy chọn không hợp lệ: $1 (xem --help)"; exit 1 ;;
esac

IS_DARWIN=0
[ "$(uname -s)" = "Darwin" ] && IS_DARWIN=1
LAUNCHD_TARGET="gui/$(id -u)/dev.agenthub"

health_ok() {
  curl -fsS -m 2 http://127.0.0.1:7700/health >/dev/null 2>&1
}

stop_service_directly() {
  if [ "$IS_DARWIN" = 1 ]; then
    launchctl bootout "$LAUNCHD_TARGET" 2>/dev/null || true
  else
    systemctl --user stop agenthub 2>/dev/null || true
    [ "$DISABLE" = 1 ] && systemctl --user disable agenthub 2>/dev/null || true
  fi
}

echo "🛑 Đang tắt AgentHub Production..."

# 1. Tắt êm qua CLI: daemon lưu task đang chạy vào hàng chờ rồi dừng service.
STOP_ARGS=()
[ "$DISABLE" = 1 ] && STOP_ARGS+=(--disable)
if ! health_ok; then
  # Daemon đã tắt sẵn: chỉ dọn service còn nạp (nếu có), tránh lỗi launchctl unload ồn ào từ CLI.
  echo "  Daemon không chạy ở cổng 7700; dọn service còn sót."
  stop_service_directly
elif [ -f dist/cli.js ] && node dist/cli.js stop "${STOP_ARGS[@]}"; then
  :
else
  # 2. Dự phòng khi chưa build hoặc daemon không phản hồi: dừng thẳng service.
  echo "! Không tắt êm được, dừng service trực tiếp..."
  stop_service_directly
fi

# launchctl unload không giữ qua lần đăng nhập sau; disable thì có (run-prod.sh sẽ enable lại).
if [ "$DISABLE" = 1 ] && [ "$IS_DARWIN" = 1 ]; then
  launchctl disable "$LAUNCHD_TARGET" 2>/dev/null || true
fi

for _ in $(seq 1 20); do health_ok || break; sleep 0.5; done
if health_ok; then
  echo "❌ Cổng 7700 vẫn còn phản hồi. Tiến trình đang giữ cổng:"
  lsof -nP -iTCP:7700 -sTCP:LISTEN 2>/dev/null || true
  exit 1
fi

echo "✓ AgentHub Production đã tắt."
if [ "$DISABLE" = 1 ]; then
  echo "  Sẽ không tự bật khi đăng nhập. Bật lại bằng: ./scripts/run-prod.sh"
else
  echo "  Lưu ý: service vẫn tự bật lại khi đăng nhập lần sau. Dùng --disable để tắt hẳn."
fi
