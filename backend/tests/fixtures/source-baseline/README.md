# S1 baseline：代表文本样本与人工预期（Issue #80）

为 v0.4 内容整理链路（`docs/source-intelligence-episode-planning-v0.4.md` §7.3 三个代表样本）准备**固定可复核的真实基线输入 + 人工预期结果 + 复用骨架**，
供后续任务直接 import，避免各任务各自造样本、口径漂移。

> 契约对应：v0.4 §7.3 的 S1 / S2 / S3；承接任务：Issue #80。
> 目录独立、全部新增：不触碰 #71/#72 的 DB / 路由文件，不调用任何模型，不建临时表。
> 合并基线：master `9816b94`。

---

## 1. 目录结构与文件说明

```
backend/tests/fixtures/source-baseline/
├─ README.md                             本说明（来源 / 口径 / 预期 / 能力与缺口 / 复用方式）
├─ manifest.mjs                          静态真值：hash / 字数 / 段落数 / 人工预期（唯一权威）
├─ helpers.mjs                           复用骨架：读取 / 哈希口径 / 段落切分 / 汇总工具
├─ source-baseline.test.mjs              自洽测试（12 条，node:test，npm test 递归发现）
├─ .gitattributes（仓库根）               backend/tests/fixtures/source-baseline/** -text 固定字节
├─ sample-01-clean-short.txt             S1 干净短文（手写原创，约 0.96k 字）
├─ sample-02-noise-webnovel.txt          S2 噪声网文（seed 确定性合成，31,045 字）
├─ sample-03-long-form.txt               S3 长篇（seed 确定性合成，39,516 字）
├─ ground-truth-sample-02.json           S2 逐段标注 { index, kind, text }（机器可读人工预期）
├─ ground-truth-sample-03.json           S3 逐段标注 { index, kind, text }
└─ scripts/generate-samples.mjs          S2/S3 确定性生成器（固定 seed = 20260907）
```

## 2. 字节规范与哈希口径（hash 可复核的前提）

| 项 | 规范 |
| --- | --- |
| 编码 | UTF-8 **无 BOM** |
| 行尾 | LF（CRLF 不出现） |
| 行尾自动转换 | `.gitattributes -text` 关闭（`core.autocrlf=true` 也不生效），工作区与仓库字节一致 |
| `fileSha256` | 规范字节原样 sha256 |
| `contentHash` | `sha256(String(content).trim())` —— 与契约 §6.1 I1 / `sourceVersionContentHash` 同口径（helpers 自实现，不 import src） |
| 字符计数 | JS `String.length`（UTF-16 code unit，中文每字 = 1） |
| 段落定义 | 规范化文本按一个或多个空行（`\n\n+`）切分并剔除空段；段内不含换行 |

三个样本的 `fileSha256` / `contentHash` / 字数 / 段落数固化在 `manifest.mjs`，
`source-baseline.test.mjs` 用文件实时值逐项断言，任何一字节改动都会让测试红。

## 3. 样本与人工预期摘要

### S1 `s01-clean-short`（干净短文，961 字 / 11 段）

- 来源：原创散文《雾港的灯塔》（2026-09 为本任务编写）。无第三方版权、无隐私、无密钥。
- 预期：健康检查 `clean`；段落规整、无重复段、无已知噪声碎片；尾单换行、无首尾多余空白。
- 用途：`clean` 空跑、无整理提示、分集直接走现状链路（§7.3 S1 判据）。

### S2 `s02-noise-webnovel`（噪声网文，31,045 字 / 199 段）

- 来源：seed=20260907 确定性合成（`scripts/generate-samples.mjs`）。手写"种子正文"在前 3 段保证语义可读；
  正文由词库句型模板确定性合成。无第三方版权。
- 噪声结构与 ground-truth kind（逐段 `index` 定位）：
  - `heading` 章节标题 ×7；`watermark` 章节水印 ×2；`author-note` 作者话 ×3；`ad` 广告 ×2；`garbage` 垃圾行 ×2；
  - `duplicate` 非首次重复段 ×6；`body-dup` 块级重复正文 ×2；`body` 正文 ×172。
- 章节标题重复（**同章名区分，不能按文本直接去重**）：
  - `第2章 雨夜来客` ×2（段 45/59）——块级重复：标题随正文块整体复制，段 60/61 = 段 46/47；
  - `第3章 灯塔旧事` ×2（段 92/114）——孤立同题标题行：同章名二次出现、后续接不同正文。
- 完全同文重复组（**重复段位置区分**，逐字符相等，见 manifest `textReuseGroups`）：
  连续 ×2 + 隔章再现（89/90/154）、手写种子分离重复（4/125）、尾声连续 ×2（195/196）、
  块级重复两段（46/60、47/61）、作者话隔章重复（58/173）。
- 首尾空白 / 行尾空白：文件开头 2 个空行；结尾 `1 空行 + 纯空格行 + 1 空行`；`contentHash`（trim 口径）不受其影响，
  而 raw 与 normalized 计数差 9，专门用来验证"首尾空白不丢内容、段间换行保留"（契约 T2）。
- 预期：健康检查 `issues`；清理"只删噪声不改正文"；每条删除区间可定位、不重叠；`cleaned` 可复现。
- **重复段保留/删除基线假定**：同文段保留首次出现，其余删除（`duplicate`/`body-dup` 均为非首次出现）。
  此为人工预期的一部分，正式质量门语义由 #73 承接时复核确认（以真实运行记录到台账）。

### S3 `s03-long-form`（长篇，39,516 字 / 235 段 / 7 个章节标题）

- 来源：seed=20260907 确定性合成；无噪声。
- 预期：健康检查 `clean`；章节标题唯一有序（第1~6章 + 尾声，见 manifest `headingTitles`）；
  无完全重复段；kind 仅 `heading`/`body`。
- 用途：分段处理进度/成本提示、中断后可恢复、边界降级、确认稿分集一致性（§7.3 S3 判据）。
  契约目标 3–4 万字，本样本落在区间内。

## 4. 现有能力 / 未实现 / 未运行（master `9816b94` 如实记录）

- **现有能力（master 已合入）**：#71/#76 `source_versions`/`source_anchors` DDL、`ensureSourceVersion` 懒生成 + 锁内防重、
  `sourceVersionContentHash`（I1 口径）；分集现状链路 `splitSourceIntoEpisodes` / `naturalBoundaries`（确定性切片）、episode-plan 正文哈希。
- **未实现（由后续任务承接）**：#72 健康检查 / issues 分类（本仓库该路由/服务尚不存在，测试为 blocked）；
  #73 clean 任务化 / AI 整理 / 质量门删除区间校验 / `removed.snippet` 定位 / `cleaned` 可复现（契约 #78 冻结中）；
  confirm / skip / user-edited / switch 状态机与锚点服务；前端整理向导。
- **未运行（本目录承诺）**：本 fixtures 不调用任何收费模型、不连 MySQL、不 mock 模型输出；
  断言骨架只验证「文件 ↔ manifest ↔ ground-truth」互证与生成确定性，**不代表**真实运行结果。
  S2 清理后整稿、S3 分集真实输出等，须由 #72/#73/#75 各自真实运行后把结果记录到迭代台账，本目录不预写"假清理结果"。

## 5. 被 #72 / #73 / #75 直接复用

```js
// 示例（各任务 test 或 service 内）
import { SAMPLES, sampleById } from '<repo>/backend/tests/fixtures/source-baseline/manifest.mjs'
import {
  loadSampleRaw, loadGroundTruth, splitParagraphs,
  contentHashOf, fileSha256Of, summarizeGroundTruth,
} from '<repo>/backend/tests/fixtures/source-baseline/helpers.mjs'

const raw = loadSampleRaw('s02-noise-webnovel')            // 固定输入
const gt = loadGroundTruth('s02-noise-webnovel')           // 逐段 { index, kind, text } 人工预期
const { kindCounts, textReuseGroups, headingRepeats } = summarizeGroundTruth(gt)
```

- **#72 健康检查**：对 S2 逐段分类，断言分类结果 == ground-truth kind（按 index 对位）；S1/S3 断言 `clean` 且零噪声命中。
- **#73 clean 校验**：`removed.snippet` 必须能在 `textReuseGroups`/噪声 kind 段命中并可定位；输入固定 + 同一删除区间集合跑两次 → `cleaned` 逐字节相等；
  删除区间越界/重叠/找不到 snippet 即报错；S2 清洗稿再与 ground-truth 正文段（kind=`body`/`intro-hand`）按序对位，断言"不漏字、不重复、顺序不变"。
- **#75 分集一致性 / 恢复**：S3 长文按集切分后拼接 == 规范化输入（T2）；中断恢复用 S3；S2 `confirmed` 后再走分集链路。

运行自洽测试：

```bash
cd backend
npm test                                              # 全量（本文件被递归发现，纯文件无需 DB）
node --import tsx/esm --test tests/fixtures/source-baseline/source-baseline.test.mjs   # 单独跑
node tests/fixtures/source-baseline/scripts/generate-samples.mjs                       # 重生成 S2/S3（确定性）
```

## 6. 维护规则（改动即红）

1. 修改 `scripts/generate-samples.mjs` 或手工样本 → 重新生成并**同步更新 `manifest.mjs` 的 hash/字数/段落数/预期位置**；
   自洽测试会逐项校验，忘改必红。
2. ground-truth 的 `index` 与 `text` 是下游定位唯一依据，禁止对已发布样本做"顺手改字"。
3. S2 重复组位置（`textReuseGroups` / `headingRepeats`）以 ground-truth 为准；manifest 的静态清单只是二次校验，不一致即测试失败并提示需同步。
4. fixtures 目录禁止 import `../src/**`（保持纯文件，测试无需 DB/tsx 之外的依赖）。
