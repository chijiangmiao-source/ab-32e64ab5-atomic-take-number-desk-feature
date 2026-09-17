import fs from 'node:fs';
import path from 'node:path';

// 每次端到端运行都从一份全新的空数据库开始，保证镜号从 1 开始、结果可重复。
export default function globalSetup(): void {
  const tmpDir = path.resolve(process.cwd(), '.e2e-tmp');
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });
}
