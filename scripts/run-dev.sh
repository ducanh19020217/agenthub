#!/usr/bin/env bash
# ==============================================================================
# Script khởi chạy môi trường DEV (Backend Daemon + Frontend Web Hot-Reload)
# Dự án: AgentHub
# ==============================================================================

set -eo pipefail

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -P "$SCRIPT_DIR/.." && pwd)"

# 1. Kích hoạt môi trường Node 22 từ NVM nếu có
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  export NVM_DIR="$HOME/.nvm"
  # shellcheck source=/dev/null
  . "$NVM_DIR/nvm.sh"
  nvm use 22 >/dev/null 2>&1 || true
fi

# Kiểm tra phiên bản Node hiện hành
NODE_MAJOR=$(node -v 2>/dev/null | cut -d'.' -f1 | sed 's/v//' || echo "0")
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "❌ Lỗi: AgentHub yêu cầu Node.js >= 22 (Hiện tại: $(node -v 2>/dev/null || echo 'chưa cài đặt'))."
  echo "   Vui lòng kích hoạt Node 22: 'nvm use 22' hoặc cài đặt Node 22."
  exit 1
fi

cd "$ROOT_DIR"

echo "=========================================================="
echo "  🚀 Khởi động môi trường Phát triển (DEV) - AgentHub"
echo "  Node: $(node -v) | NPM: $(npm -v)"
echo "=========================================================="

# 2. Kiểm tra dependencies
if [ ! -d "node_modules" ] || [ ! -d "web/node_modules" ]; then
  echo "📦 Cài đặt dependencies còn thiếu..."
  [ ! -d "node_modules" ] && npm install
  [ ! -d "web/node_modules" ] && npm --prefix web install
fi

# 3. Kiểm tra cổng mạng 7700
PORT_7700_PID=$(fuser 7700/tcp 2>/dev/null || true)
if [ -n "$PORT_7700_PID" ]; then
  echo "⚠️  Cảnh báo: Cổng 7700 đang bị chiếm bởi PID: $PORT_7700_PID"
  # Kiểm tra xem có phải do systemd service agenthub đang chạy không
  if systemctl --user is-active --quiet agenthub 2>/dev/null; then
    echo "   Dịch vụ nền 'agenthub.service' đang chạy. Đang tạm dừng để chạy DEV..."
    systemctl --user stop agenthub
    sleep 1
  else
    echo "   Vui lòng dừng tiến trình đang dùng cổng 7700 (kill $PORT_7700_PID) rồi chạy lại."
    exit 1
  fi
fi

# Kiểm tra cổng 5173 của Vite
PORT_5173_PID=$(fuser 5173/tcp 2>/dev/null || true)
if [ -n "$PORT_5173_PID" ]; then
  echo "⚠️  Cảnh báo: Cổng 5173 (Vite) đang bị chiếm bởi PID: $PORT_5173_PID"
  echo "   Đang giải phóng cổng 5173..."
  kill -9 "$PORT_5173_PID" 2>/dev/null || true
  sleep 1
fi

# 4. Quản lý dọn dẹp tiến trình con khi thoát (Ctrl + C)
PID_BACKEND=""
PID_FRONTEND=""

cleanup() {
  echo ""
  echo "🛑 Đang dừng các tiến trình DEV..."
  if [ -n "$PID_BACKEND" ]; then
    kill "$PID_BACKEND" 2>/dev/null || true
  fi
  if [ -n "$PID_FRONTEND" ]; then
    kill "$PID_FRONTEND" 2>/dev/null || true
  fi
  # Đảm bảo dọn sạch mọi tiến trình con phát sinh từ job
  jobs -p | xargs -r kill 2>/dev/null || true
  echo "✓ Đã dọn dẹp xong. Tạm biệt!"
  exit 0
}

trap cleanup SIGINT SIGTERM EXIT

# 5. Khởi chạy Backend Daemon với tsx --watch
# Ổ mã hoá/mạng (VeraCrypt, NFS…) hay không phát sự kiện file, khiến watcher bỏ sót thay đổi:
# tsx dùng chokidar nên bật polling qua biến môi trường. Đặt AGENTHUB_DEV_POLLING=0 để tắt.
if [ "${AGENTHUB_DEV_POLLING:-1}" != "0" ]; then
  export CHOKIDAR_USEPOLLING=1
  export CHOKIDAR_INTERVAL="${CHOKIDAR_INTERVAL:-1000}"
fi
echo "⚙️  [1/2] Đang khởi chạy Backend Daemon (tsx --watch)..."
npx tsx --watch src/cli.ts daemon &
PID_BACKEND=$!

# tsx --watch chỉ khởi động lại khi có file đổi, không tự bật lại khi daemon thoát.
# Nếu cổng 7700 im lặng 3 lần liên tiếp (~30s) thì chạm src/cli.ts để watcher bật lại daemon.
watch_daemon_health() {
  local misses=0
  sleep 30
  while kill -0 "$PID_BACKEND" 2>/dev/null; do
    if curl -s -o /dev/null --max-time 3 "http://127.0.0.1:7700/" 2>/dev/null; then
      misses=0
    else
      misses=$((misses + 1))
      if [ "$misses" -ge 3 ]; then
        echo "⚠️  Daemon không phản hồi ~30s, đang khởi động lại (tsx --watch)..."
        touch "$ROOT_DIR/src/cli.ts"
        misses=0
        sleep 20
      fi
    fi
    sleep 10
  done
}
watch_daemon_health &

# 6. Khởi chạy Frontend Web với Vite dev server
echo "⚙️  [2/2] Đang khởi chạy Frontend Web Dev Server (Vite)..."
npm --prefix web run dev &
PID_FRONTEND=$!

# 7. Đợi daemon tạo token và in link truy cập
sleep 2
TOKEN_FILE="$HOME/.agenthub/token"
TOKEN=""
if [ -f "$TOKEN_FILE" ]; then
  TOKEN=$(cat "$TOKEN_FILE" 2>/dev/null || true)
fi

echo ""
echo "=========================================================="
echo "  ✅ Môi trường DEV đã sẵn sàng!"
echo "  ► Backend API:       http://127.0.0.1:7700"
echo "  ► Frontend Web:      http://localhost:5173"
if [ -n "$TOKEN" ]; then
  echo "  ► Link đăng nhập:   http://localhost:5173/#token=$TOKEN"
  echo "                      (hoặc http://127.0.0.1:7700/#token=$TOKEN)"
fi
echo "=========================================================="
echo "  (Nhấn Ctrl + C để dừng cả Backend và Frontend)"
echo ""

# Chờ cả 2 tiến trình
wait
