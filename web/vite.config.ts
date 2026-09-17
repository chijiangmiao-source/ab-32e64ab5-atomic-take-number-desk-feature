import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// 本地开发 / 端到端测试时，把 /api 代理到镜号服务。
// 目标地址可用 VITE_API_PROXY_TARGET 覆盖（Playwright 会注入它）。
const apiTarget = process.env.VITE_API_PROXY_TARGET ?? 'http://localhost:8000';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
