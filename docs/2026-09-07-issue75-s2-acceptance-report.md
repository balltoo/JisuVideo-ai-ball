# Issue #75 S2 文本全链路验收报告（含 UI 支持范围提醒）

> - 分支：`feat/issue-75-s2-e2e-acceptance`（fork：origin = Aibrother258/JisuVideo-ai）
> - 基线：`d9eddb2`（Merge PR #91）
> - 日期：2026-09-07
> - 关联契约：`docs/source-intelligence-episode-planning-v0.4.md`（v0.4-rev9，Issue #78 收口）
> - 范围：clean → confirm → health → analyze 文本全链路逐字质量门验收；新增 gpt 系模型（fhl.mom 网关）能力边界对照
> - 运行时证据：`.local/e2e75/evidence.jsonl`（本目录不入库，按需归档）

---

## 一、验收目标与质量门

对给定源文本依次执行 **clean（去噪）→ confirm（确认）→ health（体检）→ analyze（分集）**。质量门关键约束：

1. **逐字删除质量门**：clean 的 Agent 输出 `removals[]`，每条含 `start/end` + `snippet`（该区间原文**逐字回显**）。后端把返回的 snippet 与原文切片精确比对，任一不匹配即 `INVALID_PROPOSAL` 失败。
2. **拼接一致性断言**：按 removals 删除后拼接 = 预期干净文本。
3. **S3 附加契约**：clean 进行中注入一次 backend 重启，任务不得虚报完成，须安全失败并要求人工重发（`UNSAFE_RECOVERY`）。

即：链路对文本模型是「逐字回显」硬需求，不是语义近似需求。

## 二、执行总览

| 阶段 | drama | 样本 | 模型（当时首位） | 结果 |
|---|---|---|---|---|
| S1 | 8 | `s01-clean-short`（961 字无噪） | flash-lite | ✅ 通过（3 集，split/episodes 一致性成立） |
| S2 小样本 | 13 | `s02b-noise-short`（1665 字含广告） | gpt-5.6-luna | ✅ 全链通过（task 78） |
| S2 大样本 | 9 | `s02-noise-webnovel`（31045 字，噪声 ad×1/watermark×3/duplicate×7） | flash-lite → glm-5.2 → gpt-5.6-luna → sol → astra | ⛔ 均未通过 12k/6.8k 分块质量门 |
| S3 | 10 | `s03-interrupt`（39516 字） | flash | 契约部分：中断恢复安全失败 ✅（task 72）；正式 clean ⛔（`Server busy` 429） |

## 三、阶段结论

### S1（drama 8，961 字干净短文本）
estimate → analyze（复用既有 plan v1）→ plan reviewed v2 → 生成 3 集。split 一致性 `equal=true`、episodes 一致性 `equal=true`。证明 pipeline（estimate→clean→confirm→analyze→分集）逻辑正确。

### S2 小样本（drama 13，1665 字含噪短文本）——gpt-5.6-luna 通过
- task 77 首跑失败（网关侧抖动/偶发转录失配，非系统性），task 78 复跑通过。
- 产物链：source → **cleaned v7**（1621 字，删除 44 字符站内声明，snippet 逐字精确）→ **confirmed v8** → episode-plan v1（4 集）。
- 全链一致性断言（去空白口径，与 S1 同款 `charEqualConsistency`）：confirmed 1596 == 四集拼接 1596，`equal=true`。

### S2 大样本（drama 9，31045 字网文）——三模型均不满足质量门
| 尝试 | 模型 | 任务 | 失败形态 |
|---|---|---|---|
| S2 初轮（29 个 task 全 failed 的其中一部） | sensenova-6.8-flash-lite | — | `INVALID_PROPOSAL`（snippet 失配/段拼接错位），且高频 `Server is busy` 429 |
| 探针 | deepseek-v4-flash | — | `insufficient_quota`（workspace 配额耗尽，不可用） |
| 探针 | glm-5.2 | — | 一次精确通过（1665 切片，27s）后即 `insufficient_quota` |
| 授权切换 glm | glm-5.2 | task 68/69/70 | `INVALID_PROPOSAL`（1665 与 12k 首块均失配；temp=1→0 无改善） |
| 切换 gpt-5.6-luna | gpt-5.6-luna | task 81 / 82 | chunk0/1（12k×2）通过但 chunk2（6.8k）失配（81）；chunk0 失配（82）→ 非确定性 |
| 切换 gpt-5.6-sol | gpt-5.6-sol | task 83 | 首块（12k）`INVALID_PROPOSAL`，与 luna 无差异 |
| 切换 gpt-6-astra | gpt-6-astra | task 84 | **请求 hang**：submitting 首块即超时，Mastra 错误被归一为 `<none>`；纯 https 直连 240s 超时无响应 |

**结论**：fhl.mom 网关 gpt-5.6-luna/sol 的逐字 snippet 转录能力随块尺寸增大呈概率性失配；<2k 文本稳定（drama 13），≥6.8k 不稳定。gpt-6-astra 请求层当前不可用（hang）。12k/6.8k 失败无法靠重试稳定翻越质量门。

### S3 中断契约（drama 10）
- task 72：clean 进行中注入 backend 重启 → 任务被标 `UNSAFE_RECOVERY`、安全失败、不留脏 cleaned、返回「整理任务在服务中断时处于未知送达状态，请手动重新发起」✅ **不虚报完成**。
- task 73/74 正式 clean：`Server is busy` 失败（无 cleaned 产出）。

## 四、附带发现与修复：clean worker 租约 bug（保留）

**问题**：`runSourceCleanupTask` claim 时写入一次性 60s 活跃租约，且清理过程从不续期。慢文本模型（gpt-5.6-luna 等）单块调用可达分钟级，60s 后恢复服务每轮扫描都会把**仍在工作的 worker** 误判为中断并按 `UNSAFE_RECOVERY` 安全失败，任务不可自动完成。

**修复**（`backend/src/services/source-cleanup.ts`，工作区改动，未提交）：
- 新增常量 `SOURCE_CLEANUP_LEASE_MS = 300_000`；
- claim 时写入 `claimAt + SOURCE_CLEANUP_LEASE_MS`；
- `updateCleanupCheckpoint` 每次 checkpoint 同时把 `recovery_at` 续期到 `Date.now() + SOURCE_CLEANUP_LEASE_MS`。

**验证**：修复后 task 81 完整跑完 3 个 chunk（约 2 分钟+）不再被误杀；每 60s 的恢复扫描均 `claim-skipped | reason=active worker lease`。

## 五、决策 C：验收口径收窄

- **drama 13（1665 字含噪短文本）作为 S2 通过样本**（全链 + 一致性断言通过）。
- **drama 9（31045 字）等大文本 clean 标记「模型能力边界外」**：当前可用文本模型（flash-lite/deepseek/glm 配额耗尽，fhl.mom gpt 系大块失配/astra hang）均无法稳定满足 12k 分块的逐字质量门。属**外部模型能力约束**，非后端逻辑缺陷（后端在同一消息构造下的失配形态可在 diag 复现，且失败均为预期代码路径）。
- **支持范围现状**（后端可对外承诺）：
  - 全自动 clean：可靠上限约 **2k 字级文本**（已验证）；分块上限当前为 `SOURCE_CLEANUP_CHUNK_SIZE=12_000`，但 >6.8k 块逐字转录通过率不稳定，需配合小分块或更强模型。
  - 中断恢复契约（S3）：已验证可用。
  - 任务取消/未知送达：UI 需引导人工核对重发，不得自动重发。

## 六、配置恢复清单（已执行，2026-09-07）

| 行 | 字段 | 恢复值 | 依据 |
|---|---|---|---|
| id=2 | settings.temperature | `1`（恢复期间曾临时改 0） | `config-backup-settings-text-id2.json` |
| id=13 | model | `["gpt-5.6-luna","gpt-5.6-sol","gpt-6-astra"]`（恢复 luna 首位） | 用户新增时原样 |
| id=13 | priority | `0`（测试期曾临时 10） | 同上 |
| id=13 | settings | `NULL` | 同上 |

> 注意：恢复后**生产默认文本配置回到 id=2（sensenova flash-lite，temp=1）**，该模型本身不满足逐字质量门。要让 gpt 系成为默认需 `id=13` priority > 1 并考虑下调 `SOURCE_CLEANUP_CHUNK_SIZE`——属生产配置决策，本次未代做。

---

## 七、UI 开发支持范围提醒（重要）

以下约束在 **UI 开发/联调阶段必须清晰呈现**，避免界面让用户发起必然失败或语义误导的操作。

### 7.1 能力边界（UI 呈现口径）
1. **AI 整理原文**是「去噪不改写」：只删除广告/水印/重复等噪声区间，结果可预览、可复现、可回退。UI 不得宣称「改写/润色」。
2. **文本长度分级**：
   - ≤ ~2k 字：全自动整理，质量门已验证（当前模型）。
   - ~2k–12k 字：可能触发分块，当前模型的逐字转录**概率性失败**，UI 应提示「文本较长，AI 整理可能因模型精度失败，可重试」并允许用户分次/直接跳过。
   - >12k 字（如 31045 字的完整网文）：按当前 chunk（12k）与可用模型，**大概率无法自动整理通过**。UI 应把「检查原文」的提示作为主路径，把「AI 整理」标为实验性，或在发起前弹确认说明失败可能；**不要让用户误以为一键必成**。
3. **清理耗时**：单块调用可达分钟级（1–3 分钟/块），12k 级长文整体 >3 分钟。UI 的 loading/进度需容忍长轮询，不得短超时判死。

### 7.2 失败语义 → UI 文案映射（后端错误码）
| 后端语义（`error.code` / 形态） | 含义 | UI 建议行为与文案方向 |
|---|---|---|
| `INVALID_PROPOSAL`（含「第 N 个分块坐标/snippet 不匹配」） | 模型逐字回显失配（非请求失败） | 展示「AI 整理未能精确识别删除区间，请重试或改用更短文本」+ 重发按钮 |
| `UNSAFE_RECOVERY` | 服务中断时任务处于未知送达状态 | 展示「服务中断，任务可能已完成或未完成，请核对后重新发起」，**禁止自动重发** |
| `STALE_INPUT` | 发起后原文基线已变 | 提示「原文已变更，请重新发起整理」 |
| `STALE_PROPOSAL` | Agent 返回基线不匹配 | 同上，重试 |
| `INVALID_CHECKPOINT` | 检查点损坏 | 提示「任务状态异常，请重新发起」 |
| `Server is busy` / 429 | 网关繁忙 | 展示「模型服务繁忙，请稍后重试」，建议退避重试而非秒级连点 |
| `insufficient_quota` | 模型配额耗尽 | 展示「模型配额已用完，请到设置页更换/补充模型配置」（配置项已在 `ai_service_configs` UI 存在） |
| 无 message（`<none>`）/ 长时无响应 | 网关 hang（如 gpt-6-astra 现状） | 展示「模型服务无响应」，允许切换模型重试 |

### 7.3 状态机与入口约束
1. **版本谱系**：source → cleaned（未采用候选）→ confirmed（确认稿，切指针）→ user-edited（编辑稿）。UI 的「查看整理结果」应能区分原文/AI 稿/确认稿/差异，并支持回退与「回到原文」。
2. **同基线互斥**：同一原文同时只允许一个 clean；发起新 clean 前需处理旧任务。
3. **重发幂等**：失败后重发走「新任务」路径，UI 不应复用旧 task_id 轮询到底。
4. **模型选择**：文本配置已支持多模型 fallback 链；当首位模型失败是**请求级**错误时链路自动 fallback，但**质量门失败不会触发 fallback**——UI 文案不要把质量门失败表述成「换个模型就好」。
5. 长任务（>60s）期间若 UI 刷新，恢复服务会把 processing 任务续跑或按 7.2 语义失败，UI 应拉取任务真实终态而非凭本地状态猜。

### 7.4 给 UI 的正面体验基线（契约冻结项）
- 能力名称沿用：**检查原文**（只提示不自动改）、**AI 整理原文**（可选可跳过）、**查看整理结果**、**智能分集**。
- 「净化」不作为产品主定位/强制步骤。
- 智能分集输入 = 用户确认稿；分集结果顺序不变、不漏字、不重复（确定性切片，UI 无需承诺「智能」文案之外的内容）。

---

## 八、遗留事项
1. `SOURCE_CLEANUP_CHUNK_SIZE=12000` 与逐字质量门的匹配度：大文本全自动整理的可行性取决于**更强逐字模型或缩小分块**，二者需产品拍板后由实施改（已与用户确认本次不动，见决策 C）。
2. gpt-6-astra 在 fhl.mom 网关 hang 待服务方排查；恢复前不应置于首位。
3. 生产默认文本配置仍是 flash-lite（id=2），与质量门能力不匹配，长期建议在设置页引导切换。
