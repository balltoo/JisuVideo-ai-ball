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
| R2 | 相同 key 换包冲突 | 服务层 | `409 IDEMPOTENCY_KEY_REUSED`；`dramas +0` | 通过 |
| R3 | 并发确认（5 并发、同 key 同指纹） | 服务层 | 5 次全为 `completed`/`replayed:false`；幂等表仅 1 行；`dramas +5`；**4 个孤儿项目** | **缺陷 2** |
| R4 | 快照过期 | 服务层 | `410 PACKAGE_PREVIEW_EXPIRED`；快照行回收至 0 | 通过 |
| R5 | 快照篡改（`upload.zip` 被替换） | 服务层 | `409 PACKAGE_SNAPSHOT_MISMATCH` | 通过 |
| R6 | Confirm 写入阶段失败 | 服务层 | `500 PACKAGE_IMPORT_FAILED`；幂等行收口 `failed` 且 `error_json` 可诊断；`dramas +0`；同 key 重放恒 `failed`；换 key 重试 `completed` | 通过（含 1 项语义待确认，见 §3） |
| R7 | 数据清洁（成功路径） | 服务层 | `episodes/characters/scenes = 2/2/2`（与包一致）；`source_versions = 1`；孤儿 `episode_characters`、`episode_scenes` 均为 0 | 通过 |
| R8 | Preview 租约与清理边界 | 服务层 | 过期快照回收 8 行、残留 0；孤儿目录回收 1 个 | 通过 |
| M1 | `target_mode` 四项逻辑身份（契约 §5.2/§5.3） | 服务层 | 缺陷基线 `6384cec` 未覆盖（无 `target_mode` 输入、无该列、错误码未用 `IDEMPOTENCY_KEY_REUSED`）；已由 Issue #117 补齐，复验见 §7 | 通过（2026-09-12 补齐） |
| T1 | `npm run typecheck` | — | 通过 | — |
| T2 | `npm test`（全量，真实 MySQL，基线 `6384cec`） | — | **0 fail，0 skipped**（该基线当时总数 280） | — |

> 上表为缺陷发现时的实测（基线 `6384cec`）；A3/R3 对应两个缺陷。修复后健康目标复验见 §6。
>
> **M1 的契约边界（已关闭）**：契约 §5.2/§5.3 要求的四项逻辑身份
> `confirm_idempotency_key + package_fingerprint + validation_fingerprint + target_mode`
> 在缺陷基线 `6384cec` 上只有前两项被纳入比对。该缺口曾拆出为独立阻塞任务 **Issue #117**，
> 已于 2026-09-12 落地：`ConfirmImportInput` 增加 `targetMode`、
> `production_package_imports` 增加 `target_mode` 列（含存量回填）、身份比对四项化，
> 同 key 换 `package_fingerprint` / `validation_fingerprint` / `target_mode` 统一返回契约
> 定义的 `IDEMPOTENCY_KEY_REUSED`。复验证据见 §7。

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
| R1/R2/R4–R8 | 均通过（同 key 幂等 1 行、换包 409 `IDEMPOTENCY_KEY_REUSED`、过期 410 + 清理、篡改 409、失败 `failed` 收口且无半成品、数据清洁无孤儿、租约/孤儿目录回收） |
| typecheck / npm test | 通过；**0 fail，0 skipped**（含 e2e A1/A2、reliability R1–R8、fix 回归 4 用例） |

### 隔离说明

`production-package-import-e2e` / `-reliability` / `-fix` 三个测试文件通过
`backend/tests/fixtures/production-package/mysql-isolate.mjs` 各自使用唯一隔离库
（CREATE → 设置 `MYSQL_DATABASE` → `initMySqlSchema` → 结束 DROP），避免 npm test
多文件并发与既有真实 MySQL 测试共用开发/CI 库时互相污染（如 preview 的 nonce 配额用例）。

### 测试总数口径（避免与 CI 数字对不上）

上表按 owner 门禁要求**只报 fail/skip，不报总数**——测试总数会随仓库演进变化，
写死在验收文档里迟早失准。当前实测（head `584d128`）：

| 环境 | 命令 | 结果 |
| --- | --- | --- |
| CI（权威） | `backend (typecheck + npm test with MySQL)`，node 22.23.2 + MySQL 8.0，run `34544635684` | 279 pass / 0 fail / 0 skipped |
| 本机 | `npx -y node@22 --import tsx/esm --test --test-force-exit`，node 22.23.2 + MySQL 8.4（Docker） | 289 pass / 0 fail / 0 skipped |

**279 与 289 的差异（10 个）已定位，与本报告无关**：缺的 10 个全部在既有文件
`backend/tests/fixtures/production-package/production-package.test.mjs` 的 856–1062 行
（契约语义期望登记守卫、T10/T12 只读与无副作用守卫、T99 fixture 自校验、样本版权扫描等）。
该文件在 HEAD、master、PR merge ref 三处**完全一致**（均 1071 行、均含这 10 个测试），
且 CI 该文件的测试严格按源文件行号 44 → 846 递增执行、**846 行之后 CI 未再执行任何测试**
（CI 最后一个来自该文件的用例是 846 行的「B5 BOM 阻断」，紧随其后的 856 行用例未出现在
CI 日志中）。本机用与 CI 完全相同的 node 22.23.2 复跑全量得到 289，说明差异来自 CI
（node 22.23.2 + MySQL 8.0）运行该既有 fixture 文件时的环境行为，不是本 PR 引入的测试，
也不影响本报告的三项验收（e2e A1/A2、reliability R1–R8、fix 回归 4 用例）——它们
在 CI 与本机两侧均实际执行并通过。

### 遗留待办

- "**可信网关/BFF 如何代表浏览器签名**"的接线（Issue #112，主账号认领中）不是本修复范围。
- 失败后同 key 恒定重放 `failed` 语义已确认可接受；前端（#107）需在失败时引导用户"重新上传/重新发起"（新 key）。
- ~~**`target_mode` 四项逻辑身份（阻塞，见 §2 M1）**~~ **已关闭**：Issue #117 于 2026-09-12 落地，复验证据见 §7。

## 7. Issue #117 补齐：`target_mode` 四项逻辑身份（2026-09-12）

- 任务：Issue #117（`[BLOCKER] Confirm 链路缺失 target_mode：契约 §5.2/§5.3 未覆盖`）
- 实施账号 / 线：`Aibrother258` / `production-reliability`
- 实施分支：`fix/issue-117-confirm-target-mode`；基线：`master @ 46c1180`（PR #115 合入后）

### 7.1 变更

| 层 | 变更 |
| --- | --- |
| 服务 | `ConfirmImportInput` 增加 `targetMode`；幂等身份比对由两项扩展为契约四项（`package_fingerprint` + `validation_fingerprint` + `target_mode`）；支持性校验放在原子 claim 之后、`COMMIT` 之前 |
| 错误码 | 同 key 换 `package_fingerprint` / `validation_fingerprint` / `target_mode` 统一返回 `IDEMPOTENCY_KEY_REUSED`（409）；不支持的 mode 返回 `PACKAGE_TARGET_UNSUPPORTED`（400） |
| 数据库 | `production_package_imports` 增加 `target_mode VARCHAR(32) NOT NULL DEFAULT 'new_project'`；启动时经 `information_schema` 幂等补列，`DEFAULT` 回填存量行；Drizzle schema 同步 |
| 路由 | Confirm 请求体透传 `target_mode` |
| 前端 | Confirm 提交携带 `target_mode`；新增 `IDEMPOTENCY_KEY_REUSED` / `PACKAGE_TARGET_UNSUPPORTED` 文案映射（旧码保留兼容） |

### 7.2 语义顺序（为何支持性校验必须晚于身份比对）

契约同时要求两条，且表面互斥：

- C3：Confirm 携带 `target_mode=update` → `PACKAGE_TARGET_UNSUPPORTED`；
- T09：同一 key 换 `target_mode` → `IDEMPOTENCY_KEY_REUSED`。

若在参数校验阶段就拒绝所有非 `new_project`，T09 会被 C3 抢先拦截，永远无法返回契约要求的
`IDEMPOTENCY_KEY_REUSED`。因此实现为：**先按四项身份比对既有幂等记录**（不一致即
`IDEMPOTENCY_KEY_REUSED`）；**首次 claim 之后、`COMMIT` 之前**才拒绝不支持的 mode，并在
抛错时由既有 catch 回滚 claim。效果是既满足 T09，又保证 C3 零幂等残留、零业务写入。

### 7.3 复验结果（本机真实 MySQL 8.4，隔离库）

| 场景 | 复验结果 |
| --- | --- |
| M1 同 key 同指纹换 `target_mode` | `409 IDEMPOTENCY_KEY_REUSED`；幂等表仍 1 行；`dramas +0` |
| M2 首次 `existing_project` / 未知 mode（`update`） | `400 PACKAGE_TARGET_UNSUPPORTED`；幂等表 0 行（claim 已回滚）；`dramas +0` |
| M3 schema 迁移 | `target_mode` 列存在、`IS_NULLABLE=NO`、`COLUMN_DEFAULT=new_project` |
| R2 回归 | 同 key 换包 → `409 IDEMPOTENCY_KEY_REUSED`（错误码随契约对齐） |
| 定向 | `production-package-import-{e2e,reliability,fix,input}` 共 20 pass / 0 fail / 0 skipped |
| 全量 | `npm run typecheck` 通过；`npm test` **293 pass / 0 fail / 0 skipped**（较基线 289 增加本任务 4 个用例） |

> 说明：本报告 §6 的 CI 数字（279）为本任务之前的快照；本任务的 CI 数字以对应 PR 的 Actions 结果为准。
