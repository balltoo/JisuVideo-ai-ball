# 生产包导入端到端可靠性验收记录（Issue #108）

- 实施账号 / 实施线：`balltoo` / `production-reliability`
- 发现缺陷基线：`6384cec`；修复与复验基线：`3b1ac20`（fix PR #113 已合入）
- 验收分支：`test/issue-108-production-package-e2e-reliability`；修复分支：`fix/issue-108-production-package-import`（PR #113）
- 契约：`docs/production-package-zip-transport-v0.1.md`
- 结论摘要：验收（HTTP + 真实 MySQL）发现 **2 个 P0 真实缺陷**（HTTP 层 Confirm 恒 401；并发同幂等键重复创建项目并留孤儿），已由 fix(#108)/PR #113 最小修复并合入；本文档保留缺陷证据（§2/§3）与修复后的健康目标复验（§6）。

---

## 1. 环境前提（可复跑）

| 项 | 说明 |
| --- | --- |
| 运行时 | Node.js（backend `npm test` = `node --import tsx/esm --test --test-force-exit`） |
| 数据库 | MySQL 8.x，必须提供；无 `MYSQL_HOST` / `DATABASE_URL` 时，测试中的数据库段按仓库既有约定 skip（CI 提供 `mysql:8.0` service） |
| 本机差异 | Docker MySQL 映射到宿主机 `3307`（CI 为 `3306`）；凭据仅通过 `MYSQL_*` 环境变量注入，**不写入 fixture / 日志 / 本报告** |
| 生产拓扑开关 | 与 `docker-compose.yml` 一致：`PREVIEW_PACKAGE_SNAPSHOT_STORE=mysql`、`PREVIEW_AUTH_NONCE_STORE=mysql`、`PREVIEW_REQUEST_RESOURCE_STORE=mysql`；测试内将 `PREVIEW_SNAPSHOT_ROOT` 指向临时目录 |
| 依赖 | `npm install`（master 后新增 `yazl` 等，缺依赖会导致 `ERR_MODULE_NOT_FOUND`） |

复跑命令（凭据自行注入，端口按环境调整）：

```bash
cd backend
npm run typecheck
npm test                                             # 全量（含真实 MySQL 段）
node --import tsx/esm --test --test-force-exit tests/production-package-import-e2e.test.mjs
node --import tsx/esm --test --test-force-exit tests/production-package-import-reliability.test.mjs
node --import tsx/esm --test --test-force-exit tests/production-package-import-fix.test.mjs
```

> 单独运行新增测试请加 `--test-force-exit`：MySQL 连接池常驻会阻止进程自行退出。
> 新增的三个测试文件各自使用唯一**隔离库**（见 §6），不污染共享开发/CI 库，也不受其它真实 MySQL 测试并发影响。

## 2. 覆盖矩阵与实测结果

| # | 场景 | 层 | 实测结果 | 结论 |
| --- | --- | --- | --- | --- |
| A1 | 签名身份 → `POST /api/v1/production-packages/preview` | HTTP | `200`，下发 `preview_token` | 通过 |
| A2 | `GET /api/v1/production-packages/preview/{token}` | HTTP | `200` | 通过 |
| A3 | `POST /api/v1/production-packages/import/confirm` | HTTP | `401 PACKAGE_PREVIEW_UNAUTHORIZED` | **缺陷 1（阻塞）** |
| A4 | 同一包、同参数直连 `confirmProductionPackageImport` | 服务层 | `{"status":"completed","replayed":false}` | 业务层正常 → 缺陷 1 定位于认证层 |
| R1 | 相同幂等键重放 | 服务层 | 首次 `replayed:false`；重放 `replayed:true` 且 `drama_id` 相同；`dramas +1` | 通过 |
| R2 | 相同 key 换包冲突 | 服务层 | `409 PACKAGE_IMPORT_IDEMPOTENCY_CONFLICT`；`dramas +0` | 通过 |
| R3 | 并发确认（5 并发、同 key 同指纹） | 服务层 | 5 次全为 `completed`/`replayed:false`；幂等表仅 1 行；`dramas +5`；**4 个孤儿项目** | **缺陷 2** |
| R4 | 快照过期 | 服务层 | `410 PACKAGE_PREVIEW_EXPIRED`；快照行回收至 0 | 通过 |
| R5 | 快照篡改（`upload.zip` 被替换） | 服务层 | `409 PACKAGE_SNAPSHOT_MISMATCH` | 通过 |
| R6 | Confirm 写入阶段失败 | 服务层 | `500 PACKAGE_IMPORT_FAILED`；幂等行收口 `failed` 且 `error_json` 可诊断；`dramas +0`；同 key 重放恒 `failed`；换 key 重试 `completed` | 通过（含 1 项语义待确认，见 §3） |
| R7 | 数据清洁（成功路径） | 服务层 | `episodes/characters/scenes = 2/2/2`（与包一致）；`source_versions = 1`；孤儿 `episode_characters`、`episode_scenes` 均为 0 | 通过 |
| R8 | Preview 租约与清理边界 | 服务层 | 过期快照回收 8 行、残留 0；孤儿目录回收 1 个 | 通过 |
| T1 | `npm run typecheck` | — | 通过 | — |
| T2 | `npm test`（全量，真实 MySQL） | — | **280 / 280 通过，0 fail，0 skipped** | — |

> 上表为缺陷发现时的实测（基线 `6384cec`）；A3/R3 对应两个缺陷。修复后健康目标复验见 §6。

## 3. 发现的两个 P0 缺陷

### 缺陷 1 —— HTTP 层 Confirm 恒 401（导入链路不可用）

- 现象：Preview/获取 Preview 均 200，Confirm 恒定 `401 PACKAGE_PREVIEW_UNAUTHORIZED`。
- 定位：`backend/src/middleware/preview-auth.ts` 的 `PREVIEW_PATH_PATTERN` 只覆盖 `production-packages/preview[/token]`，而 `src/index.ts` 把该中间件应用于整个 `/production-packages/*`（含 `production-packages/import/confirm`）。服务层直连可成功导入 → 只在认证层被拒。
- 影响：HTTP 级导入链路完全不可用；同时阻塞 #107（前端导入页面）联调。
- 状态：**已修复** —— fix(#108) / PR #113（精确三端点白名单）已合入，复验见 §6。

### 缺陷 2 —— 并发相同幂等键重复创建项目（孤儿项目）

- 现象：5 个并发请求共享同一幂等行（同一 `import_id`），却分别写入 5 个项目且全部返回 `replayed: false`；其中 4 个项目没有任何幂等记录指向（孤儿）。唯一键 `uq_production_package_import_key` 存在且生效（无重复 key 行）。
- 可疑点：`existingImport()` 在事务外先查；"是否本次插入"依赖 `INSERT ... ON DUPLICATE KEY UPDATE` 的 `affectedRows === 1`；业务写入在**另一条连接/事务**执行，缺少 `processing → writing` 的 CAS 保护。
- 影响：违反验收标准「相同 key 重复确认只创建一个项目」；产生需人工清理的孤儿项目。
- 状态：**已修复** —— fix(#108) / PR #113（原子 claim）已合入，复验见 §6。

### 待确认语义（非缺陷）

失败后**同一个 key** 再次提交会恒定重放 `failed`（`replayed: true`），需换 key 才能重试成功。已满足「失败幂等记录具备可诊断状态」，请确认这就是预期的重试语义，还是要求"failed 后同 key 可重新写入"。

## 4. 已知限制

1. **服务层与 HTTP 层分工**：R1–R8 在服务层精确控制 DB 状态/注入点验证；HTTP 层主链路与幂等重放见 e2e（A1/A2）；修复回归见 `production-package-import-fix.test.mjs`。
2. 失败注入方式：通过替换连接池返回的 `connection.execute`，使 `INSERT INTO dramas` 抛错，模拟"写入阶段失败"；**未**模拟进程被 kill / 断连的模糊提交场景。
3. 并发场景固定为单进程 5 并发、同 key；未覆盖多实例并发（生产 `replicas: 1`；并发 claim 已由 DB 唯一键 + INSERT 判定保证单实例内正确）。
4. 未覆盖超大包边界（25 MiB）、上传预算 429 等（现有 `production-package-preview.test.mjs` 已覆盖）。
5. 本机端口/凭据与 CI 不同，报告中不记录任何真实凭据与本地绝对路径。
6. 隔离库支持 `MYSQL_HOST/MYSQL_USER/MYSQL_PASSWORD` 形态（CI 与本机均满足）；仅提供 `DATABASE_URL` 时退化为共享库并需自行注意清理。

## 5. 后续监测建议

1. 缺陷修复后，为 `production_package_imports` 增加孤儿巡检：`dramas` 中无幂等记录指向的项目应告警（缺陷 2 曾产生 4 个）。
2. 监控 `preview_package_snapshots` 行数与 `PREVIEW_SNAPSHOT_ROOT` 目录体积，确认 TTL/清理周期有效。
3. 对 `status = 'failed'` 的幂等记录与 `processing` 超时（> 租约时长）记录建立告警。
4. 在 CI 保留 backend + MySQL service，确保本目录测试不被静默 skip（skip 只应发生在未配置 MySQL 环境变量时）。

## 6. 修复与复验（2026-09-10）

### 修复内容（fix PR #113，基线 `6384cec`）

- `backend/src/middleware/preview-auth.ts`：端点白名单收敛为精确 `POST /preview`、`GET /preview/:token`、`POST /import/confirm`（method 与路径精确匹配；不放宽为通配；不新增浏览器侧签发层，密钥仍在服务端/BFF）。
- `backend/src/services/production-package-import.ts`：并发幂等改为**原子 claim**（INSERT 成功即唯一 owner；重复键只读既有记录并回放/拒绝；未取得 claim 的请求绝不进入 `writeImport`；失败收口语义不变）。

### 复验结果（基线 `3b1ac20`，健康目标）

| 场景 | 复验结果 |
| --- | --- |
| HTTP 主链路（A1/A2） | `200 completed` + `replayed:false`；同 key 二次 `200` + `replayed:true` + 同一 `drama_id`；创建结果可查询 |
| 白名单收敛 | 同 owner `GET /preview/:token`=200；`POST /preview/:token`、`GET /preview`、`PUT /import/confirm` 均 401 |
| R3 并发 5× 同 key | `created=1`、唯一 drama、孤儿 0；其余 4 个全部 `409 PACKAGE_IMPORT_IN_PROGRESS` |
| R1/R2/R4–R8 | 均通过（同 key 幂等 1 行、换包 409、过期 410 + 清理、篡改 409、失败 `failed` 收口且无半成品、数据清洁无孤儿、租约/孤儿目录回收） |
| typecheck / npm test | 通过；**283 / 283 ×2 次复跑，0 fail，0 skipped**（含 e2e A1/A2、reliability R1–R8、fix 回归 3 用例） |

### 隔离说明

`production-package-import-e2e` / `-reliability` / `-fix` 三个测试文件通过
`backend/tests/fixtures/production-package/mysql-isolate.mjs` 各自使用唯一隔离库
（CREATE → 设置 `MYSQL_DATABASE` → `initMySqlSchema` → 结束 DROP），避免 npm test
多文件并发与既有真实 MySQL 测试共用开发/CI 库时互相污染（如 preview 的 nonce 配额用例）。

### 遗留待办

- "可信网关/BFF 如何代表浏览器签名"的接线（Issue #112，主账号认领中）不是本修复范围。
- 失败后同 key 恒定重放 `failed` 语义已确认可接受；前端（#107）需在失败时引导用户"重新上传/重新发起"（新 key）。
