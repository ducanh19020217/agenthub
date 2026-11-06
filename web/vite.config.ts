import { defineConfig, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import fs from 'node:fs';
import type { ClientRequest, IncomingMessage } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Daemon chỉ nhận Origin cùng cổng (7700). Request từ dev server mang Origin :5173 nên bị 403;
// chỉ đổi Origin của chính dev server, Origin lạ vẫn bị daemon chặn.
const DEV_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1):5173$/i;
const rewriteDevOrigin: ProxyOptions['configure'] = (proxy) => {
  const rewrite = (proxyReq: ClientRequest, req: IncomingMessage) => {
    if (req.headers.origin && DEV_ORIGIN.test(req.headers.origin)) proxyReq.setHeader('origin', 'http://127.0.0.1:7700');
  };
  proxy.on('proxyReq', rewrite);
  proxy.on('proxyReqWs', rewrite);
};

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'strip-mock-service-worker',
      closeBundle() {
        const swPath = path.resolve(__dirname, '../dist/web/mockServiceWorker.js');
        if (fs.existsSync(swPath)) {
          fs.unlinkSync(swPath);
        }
      },
    },
  ],
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-xterm': ['xterm', '@xterm/addon-fit'],
          'vendor-markdown': ['react-markdown'],
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api/pty': {
        target: 'ws://127.0.0.1:7700',
        ws: true,
        changeOrigin: true,
        configure: rewriteDevOrigin,
      },
      '/api': {
        target: 'http://127.0.0.1:7700',
        changeOrigin: true,
        configure: rewriteDevOrigin,
      },
    },
  },
});
