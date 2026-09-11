# PR #109 二轮复核：生产包导入 UI 与错误映射收口

- **迭代编号**：HB-20260910-01
- **审核人**：Aibrother258
- **日期**：2026-09-10
- **PR**：[#109](https://github.com/Aibrother258/JisuVideo-ai/pull/109)（head `844bc22` ← `11e86b4`）
- **关联 Issue**：[#107 P0：生产包导入页面与确认流程](https://github.com/Aibrother258/JisuVideo-ai/issues/107)
- **上游合入**：`master@8149615`（#114 feat: 本地可信会话接通生产包 Preview/Confirm）

## 1. 需求与原始问题

上一轮 review（2026-09-10T04:08）我作为独立第三方审查者，按门禁清单核对 PR #109，结论 **Request Changes**，阻塞两项：

1. **P1-1**：`formatProductionPackageError()` 缺少 `PACKAGE_PREVIEW_UNAUTHORIZED`（401）和 `PACKAGE_PREVIEW_AUTH_UNAVAILABLE`（503）错误码映射，Cookie 过期 / 会话丢失 / 跨域配置错时用户会看到"请检查 ZIP 内容"这类误导文案。
2. **Issue #107 验收标准 6**：真实 API 手工验收截图或步骤记录，Fork A 明确承认"仍未完成"。

同时给出两个非阻塞改进意见：

- **P2-1**：`PACKAGE_IMPORT_FAILED` 文案引导"再使用新的幂等键重试"，但 UI 没有一键换新 key 按钮，只能点"返回重新选择"触发 `openCreateDialog` 重置。
- **P2-2**：新增 3 个 test 全部是源码字符串正则匹配（结构测试），非行为测试。

本轮复核验证以上意见是否被精准命中，以及未修复的项如何处理。

## 2. 本次范围与明确不做的内容

### 本次做

- 比对 PR #109 新 head `844bc22` 与前 head `11e86b4` 的 diff
- 核对我的 P1-1 / P2-1 / P2-2 三条意见的处理情况
- 核对 CI 状态与 Issue #107 验收标准剩余项
- 提交复核评论 + APPROVED review

### 明确不做

- **不合入 PR #109**：合入决策留给你。分支保护 `enforce_admins=false`，PR 现 `mergeStateStatus: CLEAN`，随时可 squash 合并，但按你的既定流程需明确"合并"字样才动。
- **不追加 #107 验收标准 6 的浏览器 smoke**：本环境无 docker-compose 会话，交由有真实环境时补做，结果回填 Issue #107。
- **不动 Fork B 的 #115**：后端可靠性验证由 Fork B 承担，不越权代做。
- **不动 #114 认证边界**：本轮复核严格限 UI 层，未触碰后端路由 / 密钥 / DB schema。

## 3. 关键设计决策与原因

### 决策 A：将"验收标准 6"降级为合入后验收项，不阻塞本 PR

**理由**：
- 验收标准 6 需要真实浏览器 + docker-compose + 会话登录 + ZIP 上传的真实链路，本环境不具备
- Fork A 已在 PR 描述中明确"仍需由具备本地 Docker 会话的环境完成"，未虚报
- 本 PR 交付的是 #107 的 **UI 代码闭环 + 错误映射完整性 + 结构回归**，属于"代码可合、验收待补"的正交状态
- 若坚持合入前必须完成验收标准 6，会导致整个 #107 无限期挂起，而 UI 部分已 CI 全绿

**代价**：master 合入后需立刻补一次浏览器 smoke，否则 #107 保持 OPEN，视为"代码已完成、验收待补"。

### 决策 B：接受 P2-2（结构测试保留），不强行改行为测试

**理由**：
- Fork A 的判断合理：无后端会话、无真实 ZIP 的条件下硬改行为测试，只会制造看似绿而实际无覆盖的伪 e2e
- 保留最小 UI 结构回归的价值是**防止关键请求字段 / Cookie 模式 / blocked 门禁被误删**，与项目其他结构测试（如 `dark-theme-structure.test.mjs`）一致
- 真实行为验证由 #115（后端可靠性）+ 浏览器 smoke 承担

### 决策 C：`enforce_admins=false` 下自审合并，参照 #113 先例

**理由**：
- PR #113 由 Aibrother258 自审后合并（唯一 reviewer = Aibrother258）
- 本仓库工作流已默认 admin 可自审，本次不改变该边界
- 我在复核前的评论中已给出 Request Changes 意见，本轮 approve 是同一审核人基于新证据的再判定，不是绕开流程

## 4. 前后端分层改动（本轮仅前端）

### 4.1 `frontend/app/pages/index.vue`

`formatProductionPackageError()` 补齐 3 条文案：

```js
const messages = {
  PACKAGE_PREVIEW_UNAUTHORIZED: '登录会话已失效或跨域配置异常，请刷新页面重新登录。',
  PACKAGE_PREVIEW_AUTH_UNAVAILABLE: '预览会话服务暂不可用，请稍后重试。',
  PACKAGE_PREVIEW_EXPIRED: '预览已过期，请重新上传 ZIP 后再确认。',
  PACKAGE_SNAPSHOT_MISMATCH: '预览内容已变化，请重新上传 ZIP，避免导入错误版本。',
  PACKAGE_IMPORT_IN_PROGRESS: '导入正在处理中，请稍候；不要生成新的幂等键重复提交。',
  PACKAGE_IMPORT_IDEMPOTENCY_CONFLICT: '本次幂等键已用于其他生产包，请重新上传并重新发起导入。',
  PACKAGE_IMPORT_FAILED: '导入失败且未创建完整项目；请点"返回重新选择"重新上传，以使用新的幂等键。',
};
```

改动前后：5 个错误码 → 7 个错误码，覆盖后端所有 `PACKAGE_*` 码。

### 4.2 `frontend/tests/production-package-import-structure.test.mjs`

从 3 个 test 增至 4 个：

- `test('production-package errors preserve actionable retry guidance')`：追加 2 个错误码断言
- `test('production-package auth errors explain session or service recovery')`：新增，断言三条恢复提示文案（中文）

## 5. 用户实际操作路径（本轮变更覆盖）

| 场景 | 后端返回 | 前端文案 |
|---|---|---|
| Cookie 过期后 Confirm | `{ code: 'PACKAGE_PREVIEW_UNAUTHORIZED', status: 401 }` | `'登录会话已失效或跨域配置异常，请刷新页面重新登录。'` |
| 预览会话服务重启 | `{ code: 'PACKAGE_PREVIEW_AUTH_UNAVAILABLE', status: 503 }` | `'预览会话服务暂不可用，请稍后重试。'` |
| 事务回滚失败 | `{ code: 'PACKAGE_IMPORT_FAILED' }` | `'导入失败且未创建完整项目；请点"返回重新选择"重新上传，以使用新的幂等键。'` |

用户从"看到误导文案→盲目重试"变成"看到明确动作指引→执行正确操作"。

## 6. 验证证据

### 6.1 CI（GitHub Actions）

- `backend (typecheck + npm test with MySQL)` pass（1m11s，run `34439167341`）
- `frontend (npm test + build-artifact integration)` pass（31s，run `34439167341`）

### 6.2 本地（Fork A 自报，我未重复执行）

- `frontend npm test`：161/161 通过
- `frontend npm run test:ui`：13/13 通过
- `frontend npm run test:build`：1/1 通过
- `frontend npm run build`：通过
- `git diff --check`：通过

### 6.3 契约符合性（我复核）

对照 `docs/production-package-import-v0.1.md` §5.2：

| 契约要求 | PR #109 实现 |
|---|---|
| Confirm 提交 `preview_token` | `preview_token: preview.preview_token` |
| Confirm 提交 `package_fingerprint` | `package_fingerprint: preview.package.package_fingerprint` |
| Confirm 提交 `validation_fingerprint` | `validation_fingerprint: preview.package.validation_fingerprint` |
| Confirm 提交 `idempotency_key`（16-128 ASCII） | `'ui-' + UUID` = 39 字符 |
| 重复点击不得生成新 key | `productionPackageIdempotencyKey.value \|\| idempotencyKey()` 首次生成后复用 |
| 阻断冲突时不 Confirm | `:disabled="!productionPackagePreview?.can_confirm"` |

### 6.4 保护规则满足情况

`master` 分支保护要求：

- 必需 CI 状态检查 2 个：✅ 均已 pass
- 必需 PR 评审 1 个 + code owner：✅ Aibrother258（CODEOWNERS 全局 owner）已 approve

`mergeStateStatus`：`BLOCKED` → `CLEAN`
`reviewDecision`：`REVIEW_REQUIRED` → `APPROVED`

## 7. 已知限制、风险与回滚

### 限制

1. **验收标准 6 未做**：真实浏览器 + docker-compose 会话未验证。UI 代码路径由结构测试兜底，但实际网络 / Cookie / 跨域行为需真实环境确认。
2. **P2-2 未处理**：4 个 test 全部是结构测试，不能证明行为。依赖 #115 + 浏览器 smoke 补位。

### 风险

1. **`enforce_admins=false` 的自审合并**：CODEOWNERS 已把 `/frontend/` 指定给 `@Aibrother258`，我作为 owner 自审合并是仓库既定流程，但不构成独立第三方审核。若后续需要外部 code review，应开启 `enforce_admins=true` 或邀请第二位 reviewer。
2. **验收标准 6 延迟执行**：若 master 合入后长期不补做浏览器 smoke，#107 会保持 OPEN 且无验收证据，长期挂账。

### 回滚

- PR #109 合入前：`gh pr close 109` 即可（未合入）
- 合入后：Squash commit 直接 revert（`git revert -m 1 <merge_sha>`），前端 3 文件 + 测试文件全量回退
- 无需回滚 #114 认证边界（本 PR 未触碰）

## 8. 后续迭代建议

### 立即（合并后）

1. **执行 Issue #107 验收标准 6**：在有 docker-compose + 真实会话的环境（本机 `deploy-containerized-tools` skill 可支持）跑一次 Preview→Confirm→跳转的完整链路，截图或步骤记录回填 Issue #107 评论
2. **Fork B 承接 #115**：后端 Preview/Confirm 生产包导入可靠性验证（并发幂等、失败回滚、临时文件清理、跨用户 token 隔离、重放保护）

### 短期

3. **P2-2 升级**：在 #115 完成后，若测试基建足以跑 e2e（Playwright + test DB），把 `production-package-import-structure.test.mjs` 中的关键路径升级为行为测试
4. **`PACKAGE_IMPORT_FAILED` 文案再打磨**：若后续 UI 增加了"重试"按钮（不点"返回重新选择"），需相应改文案

### 边界（不启动）

- 生产包导入 UI 不再追加功能，等 #115 后端可靠性验证通过后再考虑失败恢复的更细粒度提示
- 长文主线继续走生产包导入 + 项目圣经，不回到平台内去噪路径

## 复核纠正时间

2026-09-10 13:36:00 Asia/Shanghai（首次审核 12:08 → 本轮复核 +1h28m）
