import path from 'node:path';
import { defineConfig } from '@playwright/test';

// 端到端测试从零启动真实的 API 进程（独立临时数据库）与 Vite 开发服务器，
// 浏览器走完整链路：页面 -> Vite 代理 -> FastAPI -> SQLite。
const tmpDir = path.resolve(process.cwd(), '.e2e-tmp');
const dbPath = path.join(tmpDir, 'shotnumbers.db');
const apiPort = Number(process.env.E2E_API_PORT ?? 4317);
const webPort = Number(process.env.E2E_WEB_PORT ?? 5317);

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: true,
  workers: 2,
  retries: 0,
  reporter: [['list']],
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: `${process.env.PYTHON ?? 'python3'} -m uvicorn app.main:app --host 127.0.0.1 --port ${apiPort}`,
      cwd: path.resolve(process.cwd(), '..', 'api'),
      env: {
        SHOT_DB_PATH: dbPath,
        ALLOW_FAILURE_INJECTION: 'true',
      },
      port: apiPort,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: `npm run dev -- --host 127.0.0.1 --port ${webPort} --strictPort`,
      env: {
        VITE_API_PROXY_TARGET: `http://127.0.0.1:${apiPort}`,
      },
      port: webPort,
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
