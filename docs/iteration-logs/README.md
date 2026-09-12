# Huobao Drama 迭代日志

这里记录本地开发版的重要功能迭代。日志以实际代码、数据库、接口和运行验证为准，不把尚未验证的能力写成已完成。

## 2026-08-31

| 编号 | 迭代 | 状态 | 详细日志 |
|---|---|---|---|
| HB-20260831-01 | 视频生成参考素材：本地上传与资产库复用 | 已完成并在本地开发栈验证 | [查看日志](./2026-08-31-reference-media-library.md) |
| HB-20260831-02 | MiniMax H3 提示词 Skill、Agent 与生成按钮 | 已完成并用分镜 01 真实验证 | [查看日志](./2026-08-31-minimax-h3-prompt-workflow.md) |
| HB-20260831-03 | 工作台面板可拖动布局与尺寸记忆 | 已完成代码实现、构建与新增测试验证；历史测试仍有路径债务 | [查看日志](./2026-08-31-resizable-workbench.md) |
| HB-20260831-04 | 参考素材持久化、视频区职责分层与 H3 新鲜度 | 已完成代码实现与开发栈验证 | [查看日志](./2026-08-31-reference-state-and-h3-freshness.md) |
| HB-20260831-05 | H3 新鲜度修复、参考素材事务化与测试基线收紧 | 代码实现与静态审查完成；本机无 Node，typecheck/测试/构建待补跑 | [查看日志](./2026-08-31-h3-freshness-and-reference-state-sync.md) |

## 2026-09-01

| 编号 | 迭代 | 状态 | 详细日志 |
|---|---|---|---|
| HB-20260901-01 | 多来源全文导入、项目风格与 AI 分集复核 | 代码、构建、定向测试和浏览器复核完成；真实 AI 业务验收待用户执行 | [查看日志](./2026-09-01-content-import-and-episode-planning.md) |
| HB-20260901-02 | 全文导入与分集审阅二次全面复盘 | 完成功能与安全双审查；确认 5 项 P1、8 项 P2，当前为有条件不建议正式上线 | [查看复盘](./2026-09-01-content-import-second-review.md) |
| HB-20260901-03 | 全文导入与分集工作流生产加固 | 5 项 P1、8 项 P2 全部关闭；数据库迁移、全量测试、构建与本地接口联调通过 | [查看日志](./2026-09-01-content-import-hardening.md) |

## 2026-09-02

| 编号 | 迭代 | 状态 | 详细日志 |
|---|---|---|---|
| HB-20260902-01 | AI 服务配置「拉取模型」：按 provider 探测模型列表、SSRF 防护与快捷预填 | 代码、类型检查、新增回归测试与容器内接口验证完成；真实厂商 Key 成功拉取待用户实测 | [查看日志](./2026-09-02-ai-config-fetch-models.md) |
| HB-20260902-02 | UI 工作线状态排查（线 A 方案稿 vs 线 B UI 治理混淆） | 已归档排查记录与术语索引；P1 token 收敛在 `feat/ui-p1-token-spec` 推进中 | [查看记录](./2026-09-02-ui-communication-audit.md) |
| HB-20260902-03 | UI P1 Token 收敛 A1 首批 + episode 资产子资源三态补漏（R1） | 完成（PR #15，merge `12121d9`）；结构测试 72/72 通过 | [查看归档](../pr-records/2026-09-02-ui-p1-token-spec-r1-assets.md) |
| HB-20260902-04 | 首页双栏工作台 + 设置页「目录—详情」三层布局改造 | 完成（PR #16，merge `e9ca6ce`）；经两轮评审，测试 74/74 通过 | [查看归档](../pr-records/2026-09-02-ui-home-workspace-settings-three-tier.md) |
| HB-20260902-05 | UI P1 Token 收敛 A1 第二批——通用填充/警示色收敛为语义 token | 完成（PR #18，merge `b14e950`）；结构测试全量通过 | [查看归档](../pr-records/2026-09-02-ui-token-a1-batch2.md) |

## 2026-09-03

| 编号 | 迭代 | 状态 | 详细日志 |
|---|---|---|---|
| HB-20260903-01 | UI P1 Token 收敛 A1 第三批——封面占位/反色白字/毛玻璃浮层语义 token | 完成（PR #19，merge `d58e570`）；结构测试 76/76 通过 | [查看归档](../pr-records/2026-09-03-ui-token-a1-batch3.md) |
| HB-20260903-02 | UI P1 Token 收敛 A1 第四批——白字白底语义化与徽标投影 token | 完成（PR #20，merge `e2f6f42`）；结构测试 77/77 通过 | [查看归档](../pr-records/2026-09-03-ui-token-a1-batch4.md) |
| HB-20260903-03 | UI P1 Token 收敛 A1 第五批——episode 播放器深色与状态色 token | 完成（PR #22，merge `cf3a301`）；结构测试 78/78 通过 | [查看归档](../pr-records/2026-09-03-ui-token-a1-batch5.md) |
| HB-20260903-04 | 设置页「音频服务」配置板块与 AutoDL IndexTTS2 预设（配音/旁白前置配置层） | 完成（PR #21，merge `e3c0724`）；经两轮评审边界收敛，前端结构测试 80/80、后端相关 18/18 通过 | [查看归档](../pr-records/2026-09-03-audio-service-config-settings-board.md) |
| HB-20260903-05 | UI A2 语义色板规范批次一——资产类别/状态语义色与 amber 提示横幅 token 化 | 完成（PR #25，merge `1c090e1`）；结构测试 81/81 通过 | [查看归档](../pr-records/2026-09-03-ui-semantic-a2-batch1.md) |
| HB-20260903-06 | UI A2 语义色板规范批次二——episode 媒体遮罩/白字、R5/R6 全仓清理、new-style 家族 | 完成（PR #26，merge `5b9ae75`）；经两轮 R5 补漏评审，结构测试 82/82 通过 | [查看归档](../pr-records/2026-09-03-ui-semantic-a2-batch2.md) |
| HB-20260903-07 | UI A3 动效体系化——时长档 token、缓动统一、keyframes 收敛与进入动画规范 | 完成（PR #28，merge `72edeac`）；经一轮 dur-slow 偏差评审修正，结构测试 83/83 通过 | [查看归档](../pr-records/2026-09-03-ui-motion-a3.md) |
| HB-20260903-08 | UI P2-B1 批次一——AppDialog 通用弹窗组件 + settings 四个配置弹窗迁移 | 完成（PR #30，merge `c9be4df`）；结构测试 84/84 通过 | [查看归档](../pr-records/2026-09-03-ui-b1-dialog-batch1.md) |
| HB-20260903-09 | UI P2-B1 批次二——detail/episode 标准弹窗迁移至 AppDialog + dialogStyle | 完成（PR #31，merge `04b128a`）；结构测试 85/85 通过 | [查看归档](../pr-records/2026-09-03-ui-b1-dialog-batch2.md) |
| HB-20260903-10 | UI P2-B1 批次三——AppDrawer 右侧抽屉组件 + episode 任务抽屉迁移（Esc 交还页面优先级） | 完成（PR #32，merge `e23ec12`）；结构测试 86/86 通过 | [查看归档](../pr-records/2026-09-03-ui-b1-dialog-batch3.md) |
| HB-20260903-11 | UI P2-B1 批次四——StatusBadge 状态徽标组件 + detail/episode 封面角标/胶囊迁移 | 完成（PR #34，merge `d61683f`）；结构测试 87/87 通过 | [查看归档](../pr-records/2026-09-03-ui-b1-badge-batch4.md) |
| HB-20260903-12 | UI P2-B1 批次五——EmptyState 通用空态组件 + index/detail 卡片空态迁移 | 完成（PR #36，merge `c4cf9eb`）；结构测试 88/88 通过 | [查看归档](../pr-records/2026-09-03-ui-b1-empty-batch5.md) |
| HB-20260903-13 | UI P2-B1 批次六——LoadingButton 通用加载按钮组件 + settings Loader2 图标族按钮迁移 | 完成（PR #38，merge `bec885a`）；经一轮复核修正（Loader2 组件内自包含 import），结构测试 89/89 通过 | [查看归档](../pr-records/2026-09-03-ui-b1-loading-batch6.md) |
| HB-20260903-14 | UI P2-B1 批次七——episode Loader2 图标族 23 处按钮迁移至 LoadingButton（loading/disabled 语义拆分） | 完成（PR #40，merge `2b8b6c4`）；一轮复核通过，结构测试 90/90 通过 | [查看归档](../pr-records/2026-09-03-ui-b1-loading-batch7.md) |
| HB-20260903-15 | UI P2-B1 批次八——Field 表单字段组件抽取 + settings/index `.field` 骨架迁移 | 完成（PR #42，merge `43ee3e2`）；一轮复核通过，结构测试 91/91 通过 | [查看归档](../pr-records/2026-09-03-ui-b1-field-batch8.md) |
| HB-20260903-16 | UI P2-B3 分页 hook——`usePagedList` + `dramaAPI.list` 分页参数扩展 | 完成（PR #43，merge `f93b287`）；经三轮评审（参数覆盖顺序/过期响应代次/Node 20 测试基线 tsx 化），测试 100/100 通过 | [查看归档](../pr-records/2026-09-03-ui-b3-paged-hook.md) |

## 2026-09-04

| 编号 | 迭代 | 状态 | 详细日志 |
|---|---|---|---|
| HB-20260904-01 | UI P2-B2 试点——episode 拼接导出面板下沉 `EpisodeExportPanel` + `useExportMergesList` 并发令牌 | 完成（PR #45，merge `b11be06`）；共 7 文件 5 提交，经 4 次正式 review（3 Request changes + 1 Approved）；episode.vue 非空行 7069→6802（物理 7422→7150），EpisodeExportPanel 354 非空行/365 物理行；测试 116/116 通过 | [查看归档](../pr-records/2026-09-03-ui-b2-episode-export-panel.md) |
| HB-20260904-02 | UI P2-B2 script 面板下沉——episode 剧本面板拆 `EpisodeScriptPanel` + 状态矩阵纯函数化 | 完成（PR #47，merge `58c1e96`）；共 3 提交，经 2 次正式 review（1 Request changes + 1 Approved）；episode.vue 非空行 6802→6763（物理 7150→7108，净 −39/−42）；测试 124/124、build/generate 通过 | [查看归档](../pr-records/2026-09-04-ui-b2-episode-script-panel.md) |
| HB-20260904-03 | UI C3/P4 首轮落地——素材库/任务列表分页化（后端 `GET /assets` 与 `GET /tasks` SQL 下推分页 + episode 参考素材选择器接入 `usePagedList`） | 完成（PR #48，merge `0ca0e0e0`）；共 3 轮评审（结构断言宽松化 / 契约兼容 / 视频历史截断修复），最终分镜历史回归无参全量契约；frontend 130/130、backend 结构子集 42/42、build 通过 | [查看归档](../pr-records/2026-09-04-ui-c3-pagination-assets-tasks.md) |
| HB-20260904-04 | UI C4 暗色主题首批（B1）——dark token 覆盖块 + `data-theme` 切换 + 首帧 FOUC + B1 字面量 token 化 | 完成（PR #53，merge `7c99e15`）；经三轮评审收口（静态 head bootstrap / 真构建产物集成测试 + CI 强制 / 子进程兜底清理）；frontend 142/142、test:build 通过 | [查看归档](../pr-records/2026-09-04-ui-c4-dark-theme-b1.md) |
| HB-20260904-05 | UI C4 暗色主题第二批（B2）——局部语义色/投影残留收口 + `solid-ink` 反色实心块 | 完成（PR #54，merge `f959214`）；经三轮 Request Changes 守卫逐级收紧（逐选择器断言 / bg shorthand 只许 solid-ink / 全部同名规则 + 空白规范化），145/145、test:build 通过 | [查看归档](../pr-records/2026-09-04-ui-c4-b2-solid-ink-token.md) |
| HB-20260904-06 | UI C4 暗色主题第三批——设置页「外观」三态切换面板 + 持久化（C4 完结批） | 完成（PR #56，merge `c58323e`）；评审 P2 跟进：说明文字改 `--text-2`（dark AA）+ 双主题守卫锚定；面板抽 `ThemeAppearanceCard` + vitest 挂载级交互套件（真实 useTheme/controller，`npm run test:ui` 4/4，CI/verify 强制）；frontend 148/148、test:build 通过 | [查看归档](../pr-records/2026-09-04-ui-c4-batch3-appearance-switcher.md) |
| HB-20260904-07 | 产品定位收敛与 PR #58 改造为「战略定位与范围裁决 PR」（2026-09-04 定位裁决）——产品定位收敛为「AI 短剧生产工作台」、登记阶段路线图/暂停清单/北极星指标、UI 治理转维护、「原文整理与智能分集」定为下一专项（v0.4 另开 PR）、净化稿 v0.3 移出 PR、shuohao 报告降级参考资料 | 完成（PR #58，merge `0bf7ed5`）；README 与唯一定位主文档已同步 | [定位文档](../product-positioning-roadmap.md) |
| HB-20260904-08 | 双实施 Fork 协作升级为任务认领制——主账号通过 Codex 发布 GitHub Issues，`csx12588` 与 `balltoo` 从任务池认领；增加热点文件锁、两台电脑同步规则、Issue/PR 模板和审核门禁 | 已合入（PR #60，merge 21b1dd3）；首批试运行：Fork A 负责原文整理与智能分集 v0.4 契约，Fork B 完成 PR #59 测试与 backend CI | [实施计划](../collaboration-task-claim-plan.md) |
| HB-20260904-09 | 台账补齐——`plan-log.jsonl` 与 `run-flow.log.jsonl` 9 月 2-3 日缺口回填（26 + 29 条）与 HB-20260904-09 登记（自身闭环） | 已合入（PR #68，merge `b8adf0f`，2026-09-04T17:35:13Z）；plan-log 由 6→32 条（+26），run-flow 由 3→32 条（+29），全部时间戳按 GitHub `merged_at` 转为北京时间 +08:00；合入后由主账号追加自身闭环记录（plan-log +1、run-flow +1，共 plan-log 33 条 / run-flow 38 条），字段来源对齐 `docs/iteration-logs/README.md` 描述、`docs/pr-records/` 归档与 `gh pr list` 真实数据 | [查看归档](../pr-records/2026-09-04-hb-20260904-09-ledger-backfill.md) |

## 2026-09-05

| 编号 | 迭代 | 状态 | 详细日志 |
|---|---|---|---|
| HB-20260905-01 | Issue #67：事实源、看板映射与协调边界 | 已合入（PR #70，merge `59bf68a`，2026-09-05T14:46:33Z）；协作计划新增 §10.1/§10.2/§10.3/附录 A；Projects #1（PVT_kwHODc-qWM4BgT-r）建立 4 字段 + 2 视图 + 3 Issue；Auto-close issue 反向关闭已停用并回读 enabled=false；其余 5 个工作流保持启用；owner 裁决标签同步=人工同步（#67 issuecomment-5551869432）；Fork 访问验证通过；#67 已关闭，看板 Status 最终为 Done（不推断触发工作流） | [查看日志](./2026-09-05-coordination-hardening.md) |

## 2026-09-07

| 编号 | 迭代 | 状态 | 详细日志 |
|---|---|---|---|
| HB-20260907-01 | Issue #75 S2 原文整理兼容链路验收——clean/confirm/health/analyze 逐字质量门 + gpt 系模型能力边界对照（含 lease bug 修复） | 兼容链路验收已执行（2026-09-07）：drama13（1665 字含噪）S2 全链通过、drama9（31045 字）三 gpt 模型 12k 块逐字失配 / astra hang、S3 中断契约通过；修复 clean worker 租约误杀 bug。该证据不再等同长文主流程验收，长文主线改走生产包导入与项目圣经 | [查看验收报告](../2026-09-07-issue75-s2-acceptance-report.md) |
| HB-20260907-02 | 长文主流程收口——外部处理、短剧生产包导入与项目圣经统筹 | 已完成方向与实施规格；不再将平台内去噪作为长文必经路径，下一步单列生产包导入最小契约 | [查看实施方案](../long-form-production-package-plan.md) |
| HB-20260907-03 | 近期迭代与长文主路线复盘订正 | #86–#92 保留为版本管理/兼容整理能力；#75 不再作为平台内长文主流程验收；路线图改为先做生产包导入与项目圣经，随后才做上下文和全局资产接线 | [查看生产包方案](../long-form-production-package-plan.md) |
| HB-20260907-04 | Issue #95 阶段 1：生产包导入 Markdown v0.1 最小契约与解析预览边界 | 已完成契约、最小两集模板/示例和 T01–T12 测试矩阵；本批只冻结字段、指纹、只读解析、确认写入、幂等/冲突和错误语义，不改 schema/API/项目大页 | [查看导入契约](../production-package-import-v0.1.md) |
| HB-20260907-05 | Issue #95 PR #97 评审反馈收口 | 已补齐可复算 fingerprint 脚本、manifest-inclusive validation snapshot、强幂等持久化边界和原始/规范化/写入正文的字节语义；待 PR #97 复审 | [查看导入契约](../production-package-import-v0.1.md) |
| HB-20260907-06 | Issue #95 PR #97 第二轮评审反馈收口 | 已将幂等记录、业务数据和 succeeded 结果冻结为同一事务；补充 source canonical 拼接精确规则、可复算 hash 向量及旧 trim helper 兼容边界；待 PR #97 再次复审 | [查看导入契约](../production-package-import-v0.1.md) |
| HB-20260907-07 | Issue #95 PR #97 第三轮评审反馈收口 | 已固定 validation fingerprint 参与确认身份及校验顺序；补充 T08b/T08c；明确 `sha256:` 展示值与数据库 64 位 hex 存储值的转换，并让金样例脚本校验三组摘要；待 PR #97 最后一轮复审 | [查看导入契约](../production-package-import-v0.1.md) |

## 2026-09-10

| 编号 | 迭代 | 状态 | 详细日志 |
|---|---|---|---|
| HB-20260910-01 | PR #109 二轮复核：生产包导入 UI 与错误映射收口 | 复核已通过（Aibrother258 APPROVED，mergeStateStatus=CLEAN，待 owner 拍板合并）；`formatProductionPackageError()` 补齐 `PACKAGE_PREVIEW_UNAUTHORIZED` / `PACKAGE_PREVIEW_AUTH_UNAVAILABLE` 两个 401/503 错误码映射，`PACKAGE_IMPORT_FAILED` 文案改为引导点"返回重新选择"生成新幂等键；结构测试 3→4（新增 auth error recovery 断言）；Issue #107 验收标准 6（真实浏览器 smoke）降级为合入后验收项，由有 docker-compose 会话的环境补做 | [查看复核日志](./2026-09-10-pr109-ui-review-round2.md) |
| HB-20260910-02 | PR #109 squash 合入 master | 已合入（merge commit `d391ddf`，2026-09-10T14:44:26+08:00）；#107 UI 范围已交付，验收标准 6（浏览器 smoke）降级为合入后验收项；#115 由 Fork B 承接后端可靠性验证 | [查看复核日志](./2026-09-10-pr109-ui-review-round2.md) |

## 2026-09-12

| 编号 | 迭代 | 状态 | 详细日志 |
|---|---|---|---|
| HB-20260912-01 | Issue #117：Confirm 链路补齐 `target_mode` 四项逻辑身份与契约错误码 | 已合入（PR #118，merge `b0cf0c4`，2026-09-11T17:46:10Z；csx12588 APPROVED 后 admin squash）。`ConfirmImportInput` 增加 `targetMode`；幂等身份四项化（`package_fingerprint` + `validation_fingerprint` + `target_mode`），同 key 换任一身份 → `409 IDEMPOTENCY_KEY_REUSED`；支持性校验置于原子 claim 之后、`COMMIT` 之前，非 `new_project` → `400 PACKAGE_TARGET_UNSUPPORTED` 且回滚 claim（同时满足契约 §5.3 T09 与 C3）；`production_package_imports` 增加 `target_mode VARCHAR(32) NOT NULL DEFAULT 'new_project'` 并启动幂等补列回填；前端提交 `target_mode` 并补错误码文案。本地 `npm test` 293 pass / 0 fail / 0 skipped、前端 161 pass 与 build 通过，CI 两轮 backend + frontend 全 pass；#117、#108 已关闭 | [查看 PR #118](https://github.com/Aibrother258/JisuVideo-ai/pull/118) |

| HB-20260912-02 | #107 链路 smoke 补做、Windows ZIP 兼容缺陷登记与契约顺序注记 | 已完成：① #107 验收标准 6 以真实 HTTP 栈（3013 前端代理 → 5679 backend → 3307 MySQL）补做通过——Preview `200`（`can_confirm=true`、2 集/2 人物/2 场景、`Set-Cookie` HttpOnly+SameSite=Strict）→ Confirm `200 completed`（`drama_id=14`）→ 项目查询 `200` → 同 key 重放 `replayed=true` 同一项目 → DB 核对 `1/2/2/2` 且 `import.target_mode=new_project`；过程中修复 dev 栈容器配置漂移（09-01 创建的 backend 容器缺 `PREVIEW_AUTH_MODE`，浏览器侧恒 `503`，`up -d` 重建后生效）。② 附带发现 Windows 自带压缩（`Compress-Archive`）生成的 ZIP 条目名为反斜杠，`yauzl strictFileNames` 在 `normalizeEntryName` 之前抛错 → `400 PACKAGE_ARCHIVE_INVALID`，已开 Issue #120（`bug` / P1 / production-reliability）。③ 契约 §5.1 补「实现顺序注记」（v0.1 实际先幂等比对后快照校验，与目标顺序的差异与边界），PR #122 合入 `970f45b`。④ 发布 Issue #121「项目圣经 MVP」（P0 / content-intelligence / ready，建议拆 A/B 两批） | [#107 验收评论](https://github.com/Aibrother258/JisuVideo-ai/issues/107#issuecomment-5638920149) · [PR #122](https://github.com/Aibrother258/JisuVideo-ai/pull/122) · [Issue #120](https://github.com/Aibrother258/JisuVideo-ai/issues/120) · [Issue #121](https://github.com/Aibrother258/JisuVideo-ai/issues/121) |

| HB-20260912-03 | Issue #120：接受 Windows 自带压缩 ZIP 的反斜杠条目名（不放宽路径安全） | 已合入（PR #124，merge `2a096c5`，2026-09-11T19:10:28Z；csx12588 APPROVED 后 admin squash）。`openZip()` 的 yauzl 选项 `strictFileNames: true → false`：非严格模式下 yauzl 会先把反斜杠规范化为 `/` 并继续拒绝绝对路径与 `..` 穿越，`normalizeEntryName()` / `extractZip()` 的 NUL、绝对路径、`..`、深度、重复/大小写冲突、链接/特殊文件、`path.resolve` 越界校验全部保留为第二道防线；契约 `docs/production-package-zip-transport-v0.1.md` §3/§7.2 明确条目名分隔符口径（允许反斜杠作为相对路径分隔符并规范化，但不得放宽任何拒绝条件）。验证：typecheck 通过、定向 26 pass、全量 `npm test` **294 pass / 0 fail / 0 skipped**、dev 栈真实链路用 `Compress-Archive` 包 Preview **200** → Confirm **200 completed**（`drama_id=15`；修复前同一包为 `400`） | [查看 PR #124](https://github.com/Aibrother258/JisuVideo-ai/pull/124) |

| HB-20260912-04 | 「普通上班族如何学 AI」文本链路最小闭环试跑（探针式，无生产代码改动）——走通 ① 导入原文 → ⑧ 视频提示词 全链路，并对每个环节做数据库级验收；产出 20 项问题清单（P0 × 1 / P1 × 3 / P2 × 12 / P3 × 4），含 `GET /ai-configs` 明文返回 API Key、`script_rewriter` 改写相对时间并丢失事实、Step1 剧本面板无保存按钮、`@` 引用在资产图缺失时静默跳过、`naturalBoundaries` 不识别章节标题等 | 试跑完成（`dramas.id=86`）：拆集零改写（三集拼接去空白与快照严格相等 2454 == 2454）、`source_versions` 懒生成、草稿乐观锁、5 个 Agent 自治写入、台词时长硬规则、ID 白名单约束、道具三问过滤均经实测确认有效；20 项问题**全部登记未修**（试跑中仅就地人工处理 3 处：剧本 2 处事实错误、场景 1 处时变元素）；未进入付费环节（生图 / 生视频 / 拼接），EP02 / EP03 未验证，跨集一致性无证据 | [查看日志](./2026-09-12-office-ai-learning-trial-findings.md) |

| HB-20260912-05 | Issue #127：AI 配置接口出参脱敏与「密钥转发外泄」修复 | 已合入（PR #131，merge `eb06734`；balltoo 首轮 Request changes 后复核 APPROVED）。`withParsedFields` 统一脱敏，覆盖列表 / 详情 / 创建三条出口；掩码阈值 20 位、超长只保留前 6 位；`PUT` 空串 = 不修改、`null` = 清空、掩码回显 = 不修改。**复核 P0 修复**：新增 `resolveProbeTarget()`——带 `id` 时 `base_url` / `provider` / `service_type` 一律取库中值、忽略请求体，堵住首版"不知道密钥也能取用密钥"的外泄原语（`/test` 与 `/models` 共用）。前端不回填密钥、新增「清除已保存密钥」入口、编辑态「测试连接」与「拉取模型」改传 `id`；`redactPreview()` 防上游响应回显密钥。验证：typecheck 通过、全量 **301 pass / 0 fail / 0 skipped**、前端 161 pass + build、dev 栈实测出参全掩码（`sk-g2F********`）且请求体声明的 `attacker.example.com` 被忽略（实际调用库中 `https://token.sensenova.cn/v1/models`） | [查看 PR #131](https://github.com/Aibrother258/JisuVideo-ai/pull/131) |

| HB-20260912-06 | Issue #121：项目圣经 MVP 批次 A（数据模型 + 读写接口 + 项目页板块） | 已合入（PR #133，merge `fc3c9bf`，2026-09-12T04:08:12Z；独立复核首轮 Request changes 4 条 → 逐条修复后复查 Approved → squash）。`project_bible_versions` 不可变版本行 + `dramas.current_bible_version_id` 指针（对齐 `source_versions` I7 范式）；`GET/PUT /dramas/:id/bible`、`GET /:id/bible/versions`（事务 + `SELECT … FOR UPDATE` + `expected_version_id` 乐观锁 → 409）；**拒绝整版全空**（`isProjectBibleEmpty` → 服务端 400 + 前端拦截 + 反向测试守卫）；`has_data` 改为**按内容判定**（空版本不再伪装「已确认」）；项目页新增「大纲与全局设定」tab（`ProjectBibleCard.vue`，空态可编辑、409 加载服务器最新版本）；分集页展示本集目标 / 承接 / 钩子 / 下集预告（加载失败保留旧值 + 内联重试，对齐 R1 规范）。验证：合入后 `master` typecheck 通过、全量 **314 / 314 pass / 0 fail / 0 skipped**、前端 169 / 169 + build、CI 两轮 pass。批次 B 剩余 = 第 6 项（受影响范围）+ 第 5 项历史 UI + 第 7 项（导入展示一致，含 `package-import` 写入）；#121 已回 `status:ready` 待认领 | [查看 PR #133](https://github.com/Aibrother258/JisuVideo-ai/pull/133) |

| HB-20260912-07 | Issue #130：前端体验与文档小项批次（短剧集数口径 / 标题前缀 / AI 配置缓存核实 / README 宣称对齐 / 懒生成文档 / 导入提示） | 已合入（PR #134，merge `3bf645a`，2026-09-12T06:01:29Z；独立复核 Approved；base 已 rebase 至 `779409b`，唯一冲突为台账 README 追加行）。`defaultEpisodeCount` 除数 3500→**1000**（2635 字由「1 集」修正为 3 集）；新增 `stripEpisodeNumberPrefix()` 并在 `splitSourceIntoEpisodes` 应用 —— AI 主路径 `normalizeEpisodePlan`（`dramas.ts:147`）正由此产出，剧集列表不再出现 `EP 01 · 第1集：…`；集数输入框常驻（未跑 AI 时按 1000 字/集给起步值 + 说明文案）；**P2-12 经核实原结论不成立**（`services/ai.ts` 单一 10s TTL 缓存、三个写入口均已失效、其它读取端直连读表），并以 3 个回归测试锁定不变量；README 删除不实的「字幕处理」宣称、标注字幕与配音为规划中，新增的「音轨策略自动判定」经核实属实（`ffmpeg-merge.ts:136 decideConcatStrategy`）；补 `source_versions` 懒生成文档与导入区「渲染视图复制丢 Markdown 标记」提示。验证：CI backend + frontend 全 pass；合入后 `master` 前端 169/169 + build 通过；后端 320 tests 中 2 个 fail 均为 **#135** 记录的 nonce 并发 flaky（单文件 26/26 全绿），#135 另追加两次命中与「两用例同时失败」的新证据 | [查看 PR #134](https://github.com/Aibrother258/JisuVideo-ai/pull/134) |

| HB-20260912-08 | Issue #121 批次 B-1：项目圣经版本历史查看与回退 | 已合入（PR #139，merge `d252075`，2026-09-12T06:54:30Z；独立复核 Approved，并补跑作者环境未执行的真实 MySQL 段）。新增 `GET /dramas/:id/bible/versions/:versionId`（归属校验 → 跨项目 404）与 `POST /dramas/:id/bible/switch`（事务 + `SELECT … FOR UPDATE` + CAS = `target_version_id` + `expected_version_id`）；**回退只切 `dramas.current_bible_version_id`，不新建 / 不修改 / 不删除任何版本行**（测试以 `doesNotMatch` 双向守卫），已在目标版本时 `changed=false` 不写库；前端 `ProjectBibleCard` 新增版本历史区（列表 / 来源标签 / 当前生效标记 / 内容预览 / 回退），409 只提示 + 刷新不自动重提，当前生效版本禁用回退。验证：typecheck 通过、定向 `project-bible` **15 / 15**（含真库段）、前端 170 / 170 + build、CI 两轮 pass；合入后 `master` 322 tests / 321 pass（1 fail 为 **#135** 的 nonce 并发 flaky，与本次 7 个改动文件无关，其修复见 PR #140）。批次 B 剩余 = 第 6 项（受影响范围）+ 第 7 项（导入展示一致） | [查看 PR #139](https://github.com/Aibrother258/JisuVideo-ai/pull/139) |

## 记录规范

每篇日志至少包含：

1. 需求与原始问题。
2. 本次范围和明确不做的内容。
3. 关键设计决策与原因。
4. 前端、后端、数据库、Agent/Skill 等分层改动。
5. 用户实际操作路径。
6. 验证证据和未通过项。
7. 已知限制、风险与回滚方式。
8. 后续迭代建议。

除非日志明确写明“真实生成已验证”，否则模型调用和付费生成能力只视为结构接通。

复核纠正时间：2026-09-05 15:34:31 UTC。Auto-close issue 已停用；可在 Project 设置重新启用，但重新启用前需 owner 明确确认其反向关闭影响。
