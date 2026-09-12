# HB-20260912-06 Issue #130：前端体验与文档小项批次

> 实施账号：`balltoo` ｜ 实施线：`production-reliability`
> 主仓库基线：`541cbef9`（PR #126 合入后的 master）；评审前已合并最新 master `0cbcdab5`（含 PR #131 / #132）
> 编号沿革：本日志最初登记为 `HB-20260912-05`；合并 master 时发现 PR #132（Issue #127）已先占用该号，故顺延为 **`HB-20260912-06`**
> 来源：Issue #130（由 HB-20260912-04 试跑问题清单 §4.3 P2-1/P2-2/P2-9/P2-12、§4.4 P3-1/P3-2/P3-3 拆分而来）
> 日期：2026-09-12

## 1. 需求与原始问题

「普通上班族如何学 AI」文本链路最小闭环试跑（HB-20260912-04）登记了 20 项问题，其中 7 项属低风险但影响日常使用/认知的小项，Owner 打包为 Issue #130 交由 `production-reliability` 线处理：

| 条目 | 原问题 |
|---|---|
| P2-2 | 「调整集数」输入框被 `v-if="episodePlan"` 包着，必须先调用一次 AI 才能拿到输入框 |
| P2-9 | 每集标题自带「第N集：」前缀，与前端已渲染的 `EP 0N` 重复 |
| P2-12 | AI 配置读取带内存缓存，怀疑改完配置不生效 |
| P3-1 | README 写「FFmpeg 单镜头合成与字幕处理」，超出实际实现 |
| P3-2 | `source_versions` 懒生成缺文档，使用者会对着 `NULL` 排查 |
| P3-3 | 从渲染视图复制原文会静默丢失 Markdown 标题标记 |
| P2-1 | 默认集数公式 `contentLength / 3500` 不适用短剧，2635 字算出 1 集 |

## 2. 本次范围与明确不做的内容

**已交付**：上述 7 项全部处理。其中 **P2-12 经核实结论为"当前代码上不成立"**——不新增改动，改为补一条回归测试锁定不变量（见 §3.3）。

**明确不做**（与 Issue 的「明确不做」一致）：

- 不实现字幕处理与配音（P3-1 只做"宣称与实现对齐"）；
- 不改变 `source_versions` 懒生成机制（P3-2 只补文档）；
- 不做 Markdown 感知导入解析（P3-3 只做提示）；
- 不改 `episode_planner` 的提示词与产出结构（只改兜底公式与标题后处理）。

**范围外单独登记**：`/api/v1/ai-configs/*` 仍无鉴权（已在 PR #131 复核中提出，属 #127 后续小项）。

## 3. 关键设计决策与原因

### 3.1 P2-1 兜底除数取 1000（有实测锚点）

原值 `3500` 来自「每集 2500–4500 字」的长视频假设。试跑实测数据更适合定标：

- 2635 字原文经人工复核后**最终选定 3 集**（886 / 875 / 874 字）；
- 其中 886 字那一集产出剧本 1108 字、分镜 10 段 / 114 秒成片，即约 **450–1000 字对应 1 分钟成片**；
- 与「竖屏短剧单集 1–3 分钟」对照，约 **800–1200 字/集** 是合理区间，取中位 **1000**。

新值在 2635 字样本上给出 **3 集**，与人工最终选择一致（旧值给 1 集）；`0 字 → 1 集`、`6 万字 → 30 集` 的上下限保持不变。

> 该函数只在「AI 未给出集数且用户未指定」时兜底，前端原本不展示该值，因此不存在界面误导面；Issue 所述"界面提示需手动指定"因兜底值已落在合理区间而不再必要。

### 3.2 P2-9 前缀剥离抽成纯函数，且刻意保守

剥离逻辑放在 `episode-planning.ts` 的 `stripEpisodeNumberPrefix()`，由 `splitSourceIntoEpisodes()` 统一调用（所有标题的唯一汇聚点），原因是：

- 该文件是纯函数模块、无任何依赖，可直接单测（`dramas.ts` 引 DB，不便直接测）；
- **只在前缀后有分隔符且仍有正文时剥离**：`第1集：沉默的周一`、`第1集 沉默的周一` 会剥离；`第1集`（整条就是前缀）、`第三集的反转`（无分隔符）、`沉默的周一`（无前缀）一律原样保留——避免把正常标题误伤成空串或断句。

前端 `detail.vue` 渲染的是「`EP 0N` 单独一行 + 独立标题输入框」，故只需去掉标题自带前缀即可消除重复。

### 3.3 P2-12 核实为不成立，改为锁不变量

试跑结论来自代码阅读而非运行时观察。逐点核实结果：

| 待确认项 | 核实结果 |
|---|---|
| 配置缓存位置 | 仅 `services/ai.ts` 一处 `configCache`（`CONFIG_CACHE_TTL_MS = 10_000`） |
| 写入口是否失效 | `routes/aiConfigs.ts` 三个写入口（`POST /`、`PUT /:id`、`DELETE /:id`）**均已调用** `invalidateAIConfigCache()` |
| 是否存在第四个写路径 | 对 `ai_service_configs` 的 `insert/update/delete` 全仓只有上述三处（`/test`、`/models` 只读） |
| 其它读配置的地方是否也缓存 | `services/generation.ts`、`services/video-prompts.ts` 均直连 DB，不经缓存 |

结论：**缓存有 10 秒 TTL 且写操作主动失效，改完配置不会继续用旧值**；该条目的担忧在当前代码上不成立。缓存与失效逻辑由 `cf70f2db`（2026-09-01）引入，早于本次试跑。

交付方式改为**回归测试锁定**：新增 `backend/tests/ai-config-cache-invalidation-structure.test.mjs`，按路由声明切块，要求"凡对 `ai_service_configs` 写库的写入口都必须调用失效"，并断言缓存带 TTL、除 `ai.ts` 外无第二处配置缓存。鉴别力已用负向用例验证（见 §6）。

### 3.4 P2-2 集数控制常驻 + 同口径起步值

- 把 `建议集数 / 调整集数 / 按指定集数拆分` 整块移出 `v-if="episodePlan"`，常驻渲染；`建议集数` 区块自身保留 `v-if="episodePlan"`，无草稿时显示一行说明；
- 按钮文案随状态切换：无草稿为「按指定集数拆分」，有草稿为「按此集数重新拆分」；
- 无草稿时输入框需有可用起步值，否则会默认按 1 集拆分。前端新增 `estimateEpisodeCount()`，口径与后端 `defaultEpisodeCount` 一致（约 1000 字/集），仅在**草稿不存在**时随全文变化刷新，草稿存在时由 `applyServerEpisodePlan` 接管。

> 后端已确认：`requestedCount` 存在时提示词按"严格按 N 集"下发，且 `normalizeEpisodePlan` 强制取该值。因此常驻输入框意味着**一次调用直达目标集数**，不再白花一次。

### 3.5 P3-3 提示落在真实粘贴面

file 上传入口在首页（`pages/index.vue`），而项目内的粘贴面是 `detail.vue` 的「全文内容」卡片（试跑实际踩坑处）。两处都补：

- `index.vue`：文件面板说明补「直接上传可完整保留 Markdown 标记」；粘贴模式新增 `.source-format-note` 提示（`## ` 与标题后空行会丢失，建议改用上传）；
- `detail.vue`：卡片说明补同一句警示。

### 3.6 样式收口

集数控制区移出 `.episode-plan-result` 后，把「上分隔线 + 上间距」的责任从 `.episode-plan-result` 移到 `.episode-count-control`，避免出现双分隔线；新增 `.episode-count-hint`、`.source-format-note` / `code` 两条样式，均使用既有 token（`--text-3` / `--surface-raised`）。

## 4. 分层改动

| 文件 | 改动 |
|---|---|
| `README.md` | 视频生成能力说明与实现对齐（拼接 + 音轨策略），字幕/配音标注为未实现 |
| `docs/short-drama-production-workflow.md` | 实操手册补原文快照懒生成说明；FAQ 新增「`source_versions` 为空 / 指针 `NULL`」条目 |
| `backend/src/services/episode-planning.ts` | 新增 `stripEpisodeNumberPrefix()`；`splitSourceIntoEpisodes()` 调用它；`defaultEpisodeCount()` 除数 3500 → 1000 |
| `backend/tests/source-import-and-episode-planning.test.mjs` | 新增 3 条：兜底集数区间、前缀剥离正反例、切片产出标题 |
| `backend/tests/ai-config-cache-invalidation-structure.test.mjs` | 新增文件，3 条：写入口必失效 / 缓存带 TTL 且导出 / 无第二处配置缓存 |
| `frontend/app/views/drama/detail.vue` | 集数控制常驻 + 按钮文案 + 起步值 watcher + 全文卡片提示；样式调整 |
| `frontend/app/pages/index.vue` | 文件面板说明 + 粘贴模式格式提示 + `.source-format-note` 样式 |
| `docs/iteration-logs/**` | 本日志 + 台账登记（HB-20260912-06） |

无数据库结构变更，无接口契约变更，无 Agent / Skill 提示词变更。

## 5. 用户实际操作路径

1. 新建项目 → 粘贴/上传原文（**不点「AI 推荐集数」**）→ 集数输入框已可见，并已按全文长度给出起步值 → 改成目标集数 → 点「按指定集数拆分」→ 直接得到该集数的草稿；
2. 草稿卡片标题不再出现「第1集：」前缀，与左侧 `EP 01` 不再重复；
3. 首页导入弹窗切到「粘贴」模式可见 Markdown 丢失提示；切到「上传文件」可见"可完整保留 Markdown 标记"说明；
4. 项目内「全文内容」卡片可见同一提示；
5. 设置页改完 AI 配置后直接调用生成，无需重启后端（行为未变，可见 TTL 10 秒 + 写操作失效）；
6. README「视频生成」章节与 `docs/short-drama-production-workflow.md` §8 可读到与实现一致的能力边界说明。

## 6. 验证证据和未通过项

命令与结果（均在本仓库 worktree、基线 `541cbef9` 上执行）：

| 验证 | 命令 | 结果 |
|---|---|---|
| 后端类型检查 | `cd backend && npm run typecheck` | **通过**（exit 0） |
| 后端全量测试 | `cd backend && npm test`（MySQL 指向隔离库 `huobao_drama_ci`） | **300 pass / 0 fail / 0 skipped** |
| 前端测试 | `cd frontend && npm test` | **161 pass / 0 fail / 0 skipped** |
| 前端构建 | `cd frontend && npm run build` | **通过**（`✨ Build complete!`，无 error） |
| 新增测试鉴别力（负向） | 逐条删除 `aiConfigs.ts` 中的失效调用后重跑判定逻辑 | 删第 1/2/3 处分别命中 `POST /`、`PUT /:id`、`DELETE /:id`，证明测试能捕获回归 |
| 前缀剥离边界 | 单测覆盖 11 组输入 | 全角/半角冒号、空格、中文数字、`回/话` 均剥离；`第1集`、`第三集的反转`、空串原样保留 |

**未通过 / 未独立验证项**（如实登记）：

- **未做浏览器级手工复核**：本机无可用浏览器会话，§5 的界面路径来自模板与样式核对，未在真实页面点击验证；
- **P2-9 未做真实模型端到端验证**：剥离逻辑为服务端确定性后处理，已单测覆盖；未再调一次 `episode_planner` 复现"模型确实产出带前缀标题"的场景；
- **P2-1 未做真实兜底触发验证**：兜底仅在 AI 未返回集数时生效，属降级路径，本次以单测覆盖取值区间；
- 前端构建日志中的 `browserslist` 数据过期告警与 `@vue/shared` 的 `DEP0155` 告警为既有告警，与本次改动无关。

## 7. 已知限制、风险与回滚

- **HB 编号竞态（已发生，已解决）**：`docs/iteration-logs/` 的编号与台账表是热点区。本日志认领时登记 `HB-20260912-05`；评审前合并 master `0cbcdab5` 时发现 PR #132（Issue #127）已先占用该号，遂顺延为 `HB-20260912-06`（本日志正文、台账 `README.md` 已同步；`-05` 行归属 #127 保留不动）；
- **热点文件协调**：`detail.vue` 与 Issue #121 同文件、`episode-planning.ts` 与 Issue #129 同文件。认领时两 Issue 均为未分配 `status:ready`，本批次按最小触碰实施（未涉及 #121 的大纲/设定板块、未涉及 #129 的 Skill 规则区）；若两条线随后开工，需按热点锁串行或 rebase 协调；
- **估值逻辑双写**：前端 `estimateEpisodeCount()` 与后端 `defaultEpisodeCount()` 是同一口径的两份实现，存在漂移风险，缓解办法见 §8；
- **本地环境差异**：本机 `F:` 盘 git 无法通过常规命令写嵌套 ref（`git checkout -b a/b` 静默失败），本次分支用手工直写 ref 文件创建；另为 worktree 建了指向主 clone 的 `node_modules` 目录联接（已被 gitignore，不入库）。以上均为本机现象，不影响提交内容；
- **本地 git 仓库两次异常与恢复**：本机 `F:` 盘 git 在变基/写嵌套 ref 时出现过两次 `refs/` 与 `worktrees/` 目录丢失（git 一度报 "not a git repository"）。恢复办法：重建 `refs/heads|tags|remotes` 空目录 → 补写 worktree 的 `HEAD`/`gitdir`/`commondir` → 从 fork `fetch` 回丢失对象。结果：5 个功能提交与工作区改动**零丢失**；本 PR 因合并 master 后历史重排执行过一次 `--force` 推送（仅本分支）。纯本地环境问题，与提交内容无关；
- **回滚**：全部改动可通过对本 PR 的单次 revert 回滚；无数据迁移、无 schema 变更，回滚后旧数据不受影响。

## 8. 后续迭代建议

1. **估值口径单一化**：把兜底集数通过接口（如 `GET /dramas/:id/episode-plan/estimate`）暴露给前端，前端删掉本地 `estimateEpisodeCount()`，从根上消除双写漂移；
2. **兜底触发时的显式提示**：若希望保留"AI 未给出集数"的可观测性，可在 `normalizeEpisodePlan` 返回 `fallback_used: true`，由前端提示"未能获得 AI 建议集数，已按全文长度给出估算"；
3. **`source_versions` 状态的界面表达**：文档已说明 `NULL` 属正常，若仍常被误判，可在版本卡片上直接标注"尚未生成快照（首次拆集策划时创建）"；
4. **P2-12 遗留**：`/api/v1/ai-configs/*` 仍无鉴权（未鉴权方可列举配置、触发探针到管理员已配置地址、增删改配置），建议另立小项；
5. **未在本次范围内的同类项**：`episode.vue` 的标题展示与 #129 的 Skill 规则批次（章节切点、场景恒定元素、引号与时间片规则、角色提取）仍在 Issue #129。
