# 镜号发放系统（Shot Number Issuer）

多台场记终端同时为同一场次领取下一条镜号。系统保证：

- **严格连续**：每个场次的镜号从 1 开始逐个递增，无重复、无缺口；
- **提交顺序**：号码分配顺序等于数据库事务提交顺序；
- **幂等**：相同 `client_op_id` + 相同内容，无论并发、超时重试还是进程重启，永远返回最初发放的号码；
- **冲突拒绝**：相同 `client_op_id` 携带不同内容，返回 `409`；
- **崩溃安全**：服务在“落库后、回包前”崩溃，重试仍能取回已提交的号码。

## 架构

```
浏览器 ──► web (nginx, 静态页面 + /api 反向代理)
              │
              ▼
           api (FastAPI, 单进程)
              │  单个事务内：查映射 → 递增场次计数 → 写操作映射
              ▼
           SQLite (WAL, synchronous=FULL, 命名卷 api-data 持久化)
```

- 镜号分配在 API 请求事务内同步完成，**不依赖任何后台 worker / 队列**；
- 数据库（SQLite 文件，挂载在 `api-data` 卷）是操作映射与场次计数的唯一持久化载体；
- 前端把每次“领取”操作连同 `client_op_id` 持久化在浏览器本地存储中，失败后保留待重试操作，刷新页面不丢失。

## 快速开始（Docker Compose）

```bash
docker compose up --build -d
```

- 页面：<http://localhost:8080>（`WEB_PORT` 可覆盖）
- API：<http://localhost:8000/api/health>（`API_PORT` 可覆盖），交互文档见 `/docs`

覆盖宿主端口：

```bash
WEB_PORT=9000 API_PORT=9001 docker compose up --build -d
```

数据保存在命名卷 `api-data` 中，容器重建、宿主机重启后号码与映射不丢失。

## 一次性验收

```bash
docker compose --profile acceptance up --build --exit-code-from verify verify
```

`verify` 服务依次执行（任一步失败即整体失败，退出码非 0）：

1. 检查 `web → api` 反向代理链路与健康检查；
2. **pytest**：20 并发无重号无缺号、重复提交幂等、409 冲突、**进程重启后映射与计数恢复**、故障注入后重试取回原号码（其中 `test_live_service.py` 直接打向 compose 中运行的 `api` 服务）；
3. **Vitest**：前端待重试保留、本地持久化、重试幂等键不变、409 反馈等逻辑。

## 幂等协议与事务边界

### 客户端协议

1. 每一次“领取下一条镜号”的**新操作**生成一个不再复用的 `client_op_id`（前端默认 `crypto.randomUUID()`；成功领取后页面自动更换新标识，也可手动重新生成）；
2. 提交 `{scene_id, client_op_id, notes}`；
3. 网络异常、5xx、超时等**任何不确定结果**，都必须用**完全相同的三个字段**重试——服务器据此识别这是同一次操作；
4. 只有 `409` 表示该标识已被不同内容占用，重试无意义，需换用新标识。

前端的两道保护：

- **待重试期间改内容再提交**：若表单标识与某个待重试操作相同但内容不同，控制器会为这次新提交另发新标识，原待重试操作原样保留，仍可从待重试入口取回它的号码；
- **不可重试的失败**：`409` 与其它 4xx（如备注超过 4000 字）直接进入“失败操作”列表，不会伪装成可重试；备注超长时表单也会就地阻止提交。

### 服务端事务边界（`api/app/storage.py` 的 `Storage.issue`）

```
BEGIN IMMEDIATE                        -- 立即取得写锁，串行化所有发放事务
  SELECT operations                    -- ① 按 client_op_id 查已提交映射
    ├─ 命中且内容一致 → COMMIT，返回原号码（幂等重放，不动计数器）
    └─ 命中但内容不同 → ROLLBACK，返回 409（不动计数器）
  INSERT INTO scene_counters …         -- ② 场次计数器原子 +1（不存在则从 1 开始）
    ON CONFLICT DO UPDATE … RETURNING
  INSERT INTO operations …             -- ③ 写入 client_op_id → 镜号 的持久映射
COMMIT                                 -- ④ 提交后号码才对其他连接可见
```

关键性质：

- **无重号**：`BEGIN IMMEDIATE` 使写事务互斥，计数器递增与映射插入串行执行；
- **无缺口**：计数器递增与映射插入在**同一事务**中，任何失败整体回滚，不会“烧了号码却没落映射”；
- **提交顺序即号码顺序**：号码在事务内分配、提交后立即可见，并发请求的号码次序等于事务提交次序；
- **崩溃安全**：`synchronous=FULL` + WAL，COMMIT 返回即落盘；响应阶段的崩溃不影响已提交数据，客户端重试走路径 ① 取回号码。

### 故障注入（仅开发模式）

为可重复验收“落库后、回包前崩溃”这一现场故障，请求可携带
`inject_failure_after_commit=true`：

- 仅当服务以 `ALLOW_FAILURE_INJECTION=true` 启动（compose 默认开启，生产应关闭）且该请求**确实新提交了号码**时，接口在 **COMMIT 之后**返回 `503`；
- 此后用相同 `client_op_id` 重试进入幂等重放分支，返回原号码且**不会再次触发故障**（故障只挂在“新插入”路径上）。

页面上“开发选项”中的复选框对应此参数；重试按钮永远不会再携带它。

## API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/shot-numbers` | 领取镜号。新操作返回 `201`，幂等重放返回 `200`（`replayed: true`），内容冲突返回 `409`，注入故障返回 `503` |
| `GET` | `/api/scenes/{scene_id}/operations` | 场次已发放镜号列表（按号码升序） |
| `GET` | `/api/operations/{client_op_id}` | 按操作标识查询（不存在返回 `404`） |
| `GET` | `/api/health` | 健康检查 |

`POST /api/shot-numbers` 请求体：

```json
{
  "scene_id": "A-12",
  "client_op_id": "7f3d…（每次新操作唯一）",
  "notes": "雨夜追车长镜头",
  "inject_failure_after_commit": false
}
```

## 本地开发

```bash
# API（Python 3.11+）
pip install -r api/requirements.txt -r tests/requirements.txt
SHOT_DB_PATH=./data/dev.db ALLOW_FAILURE_INJECTION=true \
  python -m uvicorn app.main:app --reload --app-dir api

# 前端（Node 20+）
cd web && npm install && npm run dev        # http://localhost:5173，/api 已代理到 8000
```

### 测试

```bash
# 后端：并发 / 重启 / 故障注入（自动拉起真实 uvicorn 子进程 + 临时数据库）
python -m pytest tests -v

# 前端单元测试（Vitest）
cd web && npm test

# 浏览器端到端（Playwright，自动拉起真实 API 与 Vite，全程真接口）
cd web && npx playwright install chromium && npm run e2e
```

## 项目结构

```
├── compose.yaml            # api / web / verify 三个服务，WEB_PORT、API_PORT 可覆盖
├── api/                    # FastAPI 应用与 Dockerfile
│   └── app/
│       ├── main.py         # 路由、409/503 语义、故障注入开关
│       └── storage.py      # 事务边界：BEGIN IMMEDIATE … COMMIT（见文件头注释）
├── tests/                  # pytest：并发、重启、故障注入、live 服务验收
├── verify/                 # 一次性验收服务（Dockerfile + run.sh）
└── web/                    # React + TypeScript 前端
    ├── src/lib/issuer.ts   # 待重试操作的持久化与幂等重试
    ├── src/lib/api.ts      # 409/5xx/网络异常分类
    └── e2e/                # Playwright：故障后保留待重试、恢复后显示唯一镜号、409 反馈
```

## 环境变量

| 变量 | 服务 | 默认 | 说明 |
| --- | --- | --- | --- |
| `WEB_PORT` | 宿主 | `8080` | web 容器映射到宿主的端口 |
| `API_PORT` | 宿主 | `8000` | api 容器映射到宿主的端口 |
| `SHOT_DB_PATH` | api | `/data/shotnumbers.db` | SQLite 数据库文件路径 |
| `ALLOW_FAILURE_INJECTION` | api | `false`（compose 中为 `true`） | 是否允许 `inject_failure_after_commit` 故障注入 |
| `API_BASE_URL` | verify | `http://api:8000` | live 验收用例的目标 API |
| `VITE_API_PROXY_TARGET` | web(开发) | `http://localhost:8000` | Vite 开发服务器的 `/api` 代理目标 |
