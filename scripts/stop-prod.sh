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
WAIT=0
FORCE=0
for arg in "$@"; do
  case "$arg" in
  -h|--help)
    echo "Cách dùng: $0 [--wait] [--force|--now] [--disable]"
    echo ""
    echo "  (không truyền)   Drain an toàn, không giết worker đang chạy"
    echo "  --wait           Chờ daemon thoát sau khi drain hoàn tất"
    echo "  --force, --now   Dừng ngay, worker đang chạy sẽ bị giết"
    echo "  --disable        Tắt và không tự bật lại khi đăng nhập/khởi động máy"
    echo ""
    echo "Bật lại bằng: ./scripts/run-prod.sh"
    exit 0
    ;;
  --disable) DISABLE=1 ;;
  --wait) WAIT=1 ;;
  --force|--now) FORCE=1 ;;
  *) echo "❌ Tùy chọn không hợp lệ: $arg (xem --help)"; exit 1 ;;
  esac
done

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

# 1. Hỏi daemon trước để không giết worker đang chạy.
if health_ok && [ -f "$HOME/.agenthub/token" ] && [ "$FORCE" = 0 ]; then
  TOKEN=$(cat "$HOME/.agenthub/token" 2>/dev/null || true)
  RESPONSE=$(curl -fsS -m 5 -X POST "http://127.0.0.1:7700/api/system/restart" -H "Authorization: Bearer $TOKEN" -H 'Host: 127.0.0.1:7700' -H 'Content-Type: application/json' --data '{"mode":"when-idle","reason":"stop-prod"}' || true)
  if [ -n "$RESPONSE" ]; then
    RESTART_JSON="$RESPONSE" node -e '
      const state = JSON.parse(process.env.RESTART_JSON || "{}");
      const waiting = state.waitingFor || [];
      console.log(`Sẽ dừng an toàn sau khi ${waiting.length} task chạy xong.`);
      for (const item of waiting) {
        const started = Number(item.startedAt);
        const elapsed = Number.isFinite(started) ? Math.max(0, Math.floor((Date.now() - started) / 60000)) : 0;
        console.log(`  - ${item.taskId} (${item.kind}, đã chạy ${elapsed} phút)`);
      }
    ' 2>/dev/null || true
    if [ "$WAIT" = 1 ]; then
      while health_ok; do sleep 1; done
      echo "✅ Daemon đã thoát sau khi drain."
    fi
    exit 0
  fi
elif [ "$FORCE" = 1 ]; then
  echo "⚠️ Dừng ngay: worker đang chạy sẽ bị giết."
fi

# 2. Tắt trực tiếp: giữ hành vi cũ làm fallback hoặc khi --force.
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
