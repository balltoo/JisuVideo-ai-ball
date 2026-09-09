# 生产包导入端到端可靠性验收记录（Issue #108）

- 实施账号 / 实施线：`balltoo` / `production-reliability`
- 基线：`6384cec`（PR #106 合入后的 master）
- 分支：`feat/issue-108-production-package-e2e-reliability`
- 契约：`docs/production-package-zip-transport-v0.1.md`
- 结论摘要：**发现 2 个 P0 真实后端缺陷**（HTTP 层 Confirm 恒 401；并发同幂等键重复创建项目），其余验收项在服务层通过；未改动任何业务源码，等待主账号确认热点锁后提交最小修复。

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
```

> 单独运行新增测试请加 `--test-force-exit`：MySQL 连接池常驻会阻止进程自行退出。

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

## 3. 发现的两个 P0 缺陷

### 缺陷 1 —— HTTP 层 Confirm 恒 401（导入链路不可用）

- 现象：Preview/获取 Preview 均 200，Confirm 恒定 `401 PACKAGE_PREVIEW_UNAUTHORIZED`。
- 定位：`backend/src/middleware/preview-auth.ts` 的 `PREVIEW_PATH_PATTERN` 只覆盖 `production-packages/preview[/token]`，而 `src/index.ts` 把该中间件应用于整个 `/production-packages/*`（含 `production-packages/import/confirm`）。服务层直连可成功导入 → 只在认证层被拒。
- 影响：HTTP 级导入链路完全不可用；同时阻塞 #107（前端导入页面）联调。
- 状态：已在 Issue #108 报告并申请热点锁；**未改源码**，修复待确认。

### 缺陷 2 —— 并发相同幂等键重复创建项目（孤儿项目）

- 现象：5 个并发请求共享同一幂等行（同一 `import_id`），却分别写入 5 个项目且全部返回 `replayed: false`；其中 4 个项目没有任何幂等记录指向（孤儿）。唯一键 `uq_production_package_import_key` 存在且生效（无重复 key 行）。
- 可疑点：`existingImport()` 在事务外先查；"是否本次插入"依赖 `INSERT ... ON DUPLICATE KEY UPDATE` 的 `affectedRows === 1`；业务写入在**另一条连接/事务**执行，缺少 `processing → writing` 的 CAS 保护。
- 影响：违反验收标准「相同 key 重复确认只创建一个项目」；产生需人工清理的孤儿项目。
- 状态：已在 Issue #108 报告并申请热点锁；**未改源码**。

### 待确认语义（非缺陷）

失败后**同一个 key** 再次提交会恒定重放 `failed`（`replayed: true`），需换 key 才能重试成功。已满足「失败幂等记录具备可诊断状态」，请确认这就是预期的重试语义，还是要求"failed 后同 key 可重新写入"。

## 4. 已知限制

1. **HTTP 层 Confirm 被缺陷 1 阻塞**：R1–R8 为服务层证据，尚未取得 HTTP 层同场景证据（修复后由 e2e 文件补齐）。
2. 失败注入方式：通过替换连接池返回的 `connection.execute`，使 `INSERT INTO dramas` 抛错，模拟"写入阶段失败"；**未**模拟进程被 kill / 断连的模糊提交场景。
3. 并发场景固定为单进程 5 并发、同 key；未覆盖多实例并发（生产 `replicas: 1`，但缺陷 2 在单实例内已可复现）。
4. 未覆盖超大包边界（25 MiB）、上传预算 429 等（现有 `production-package-preview.test.mjs` 已覆盖）。
5. 本机端口/凭据与 CI 不同，报告中不记录任何真实凭据与本地绝对路径。

## 5. 后续监测建议

1. 缺陷修复后，为 `production_package_imports` 增加孤儿巡检：`dramas` 中无幂等记录指向的项目应告警（缺陷 2 曾产生 4 个）。
2. 监控 `preview_package_snapshots` 行数与 `PREVIEW_SNAPSHOT_ROOT` 目录体积，确认 TTL/清理周期有效。
3. 对 `status = 'failed'` 的幂等记录与 `processing` 超时（> 租约时长）记录建立告警。
4. 在 CI 保留 backend + MySQL service，确保本目录测试不被静默 skip（skip 只应发生在未配置 MySQL 环境变量时）。
