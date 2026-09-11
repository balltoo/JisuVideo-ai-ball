# 短剧生产包导入契约 v0.1

> 状态：阶段 1 最小契约（Issue #95）
> 适用主线：外部处理 → Markdown 生产包导入 → 项目圣经 → 全局资产 → 短剧生产
> 本版目标：冻结“已分集 Markdown 生产包”的解析预览与确认写入边界，不包含运行时实现。

## 1. 范围与非目标

本契约定义外部工具已经完成去噪、校对、初步分集并经过人工确认后的 Markdown 生产包。平台负责读取、校验、预览、让用户确认，再把确认结果写入一个新项目。

本版明确不做：

- 平台内再次去噪、改写、润色、自动分集或调用任何 AI/付费模型；
- 解析阶段创建项目、剧集、人物、场景、版本或任何其他正式数据；
- 通过名称相似度静默合并已有项目/资产；
- ZIP/JSON 导入、增量导入、已有项目合并和导出；这些属于后续版本；
- 复用 #74/#75 的“AI 整理原文”入口、任务状态机或质量门。

解析必须是只读、确定性的。同一组规范化文件必须得到相同的 `package_fingerprint`、诊断结果和 DTO（时间戳、数据库 ID 等运行时字段除外）。

## 2. 输入来源关系与本版实现范围

产品保留四类内容来源，但只有最后一类进入本版解析器：

| `source_kind` | 用户意图 | v0.1 行为 |
|---|---|---|
| `short_text` | 短文本创作 | 只定义入口关系，不走本契约解析器 |
| `prepared_long_form` | 外部已整理长文 | 只定义入口关系；后续可增加单文件导入 |
| `episodic_content` | 外部已分集正文 | 只定义入口关系；本版通过生产包表达 |
| `markdown_episode_package` | 已分集 Markdown 短剧生产包 | **本版唯一实现目标** |

本版确认目标固定为新建项目。解析可以返回 `target_mode=existing_project` 的阻断诊断，但不得对已有项目执行写入或自动匹配。

## 3. 包布局与规范化

### 3.1 最小布局

目录名不参与语义，包根目录下的相对路径大小写敏感，必须使用 `/`：

```text
<package-root>/
├── drama-package.md       # 必填：项目元信息与全剧项目圣经摘要
├── characters.md          # 可选：人物圣经；没有人物时可省略
├── scenes.md              # 可选：场景圣经；没有场景时可省略
├── episodes/              # 必填：至少一个已确认分集正文
│   ├── 001.md
│   └── 002.md
└── source-manifest.md     # 必填：来源、处理、人工确认和内容指纹
```

`episodes/` 下的文件名必须匹配 `^[0-9]{3}\.md$`，从 `001.md` 连续编号，不允许跳号或重复集号。示例见 [`examples/production-package-v0.1/`](examples/production-package-v0.1/)。

### 3.2 文件编码、字节层和指纹

本契约明确区分四种字节，避免把“上传内容”“包指纹”和“写入正文”混为一谈：

- `raw_bytes`：上传时收到的原始字节，不做改写。若 `source-manifest.md` 提供 `original_content_hash`，它只表示外部原始材料的 `SHA-256(raw_bytes)`，不参与本包校验。
- `normalized_file_bytes`：解析器先拒绝 UTF-16、二进制和 UTF-8 BOM，再把 UTF-8 文本中的 CRLF/CR 统一为 LF；移除文件末尾所有 LF 后追加恰好一个 LF。不得 trim 空格或制表符，行尾空白和空白行仍属于内容。`file_hash = SHA-256(normalized_file_bytes)`，`byte_length` 也是该字节长度。
- `episode_content_bytes`：从规范化后的 `episodes/NNN.md` 中取 `## Content` 区块正文，不包含 front matter、标题和分隔换行；正文内的换行按上述规则为 LF，行尾空格/制表符保留，末尾规范为恰好一个 LF。DTO 的 `content_hash` 是该字节串的 SHA-256。
- `source_version_canonical_bytes`：按集号排序。每个 `episode_content_bytes` 自带恰好一个末尾 LF；对每个**非最后一集**再追加一个 LF，最后一集后不追加，因此相邻两集之间总共恰好两个 LF，整体末尾仍恰好一个 LF。`source_versions.content_hash/base_hash` 只 hash 这段 canonical bytes，不等同于任一文件 hash 或 package fingerprint。

相对路径采用 POSIX 形式并按字典序排序。逐行记录格式固定为 `path + NUL + lowercase(file_hash_hex) + LF`，其 UTF-8 字节串再计算 SHA-256：

- `package_fingerprint`：只拼接除 `source-manifest.md` 外的文件；这样 manifest 内声明的 fingerprint 不会与自身形成循环依赖。
- `validation_fingerprint`：拼接**全部**文件（包括 manifest），是 Parse 到 Confirm 的完整校验快照，不写回 manifest。

DTO、日志和示例脚本使用 `sha256:<64 位 lowercase hex>` 展示值；现有 `source_versions.content_hash` 与 `base_hash` 数据库列只能写 **64 位 lowercase hex（不含 `sha256:` 前缀）**。两者是同一个摘要，写入时只去掉展示前缀，不改变被 hash 的 canonical bytes。

仓库内可复算命令为 `python docs/examples/verify-production-package-v0.1.py --check`；脚本同时输出 package/validation/canonical 三个摘要、逐文件 hash 和规范化字节长度。当前示例包的期望输出为：

```text
package_fingerprint: sha256:8030bce57ee4c8c90bfe3f806dbabe953de937ed46ee61583adddd933d668d3a
validation_fingerprint: sha256:d30484ae63ed4f05a05d8f43edd5e725cfab57c41e6e977948bffbb036c19b1b
source_version_canonical_hash: sha256:1d2f0bc17032163649f4aa3d78ed890dc34dbe3f25ea9cdfd49d76db53ef767c
source_version_canonical_hash_hex: 1d2f0bc17032163649f4aa3d78ed890dc34dbe3f25ea9cdfd49d76db53ef767c
```

解析结果必须返回短期 `preview_token`、每个文件的 `path`、`file_hash`、`byte_length` 以及 `validation_fingerprint`；不得把本地绝对路径或密钥放入 DTO。

### 3.3 Markdown 元数据规则

机器字段使用文件首部 YAML front matter；正文使用 Markdown 标题和段落。所有日期使用 ISO-8601，所有 ID 使用 ASCII 字符。未识别的 front matter 字段保留在 `extensions` 并产生 warning，不得静默映射到数据库字段。

#### `drama-package.md`

必填字段：

| 字段 | 类型 | 约束 |
|---|---|---|
| `schema` | string | 固定为 `jisu-production-package` |
| `schema_version` | string | 固定为 `0.1` |
| `package_id` | string | `^[a-z0-9][a-z0-9._-]{2,63}$`，包的稳定外部 ID |
| `package_version` | integer | 从 1 开始递增 |
| `title` | string | 非空，1–200 字符 |
| `target_episode_count` | integer | 大于 0，必须等于实际 `episodes/*.md` 数量 |

可选字段：`genre`、`style`、`aspect_ratio`、`logline`、`audience`、`language`。正文至少包含 `## Drama Bible`，用于保存全剧大纲、世界观、主线冲突、结局承诺和跨集关系；正文是项目圣经候选内容，不是可执行提示词。

#### `characters.md`

每个角色使用一个 `## character: <external_id>` 区块。`external_id` 在包内唯一；`name` 必填，`role`、`description`、`appearance`、`personality`、`styling` 可选。不得包含 `image_url`、本地绝对路径或待执行的生成指令。

#### `scenes.md`

每个场景使用一个 `## scene: <external_id>` 区块。`external_id` 在包内唯一；`location` 和 `time` 必填，`prompt`、`lighting`、`description` 可选。场景是全剧基准设定，不携带单集数据库 ID。

#### `episodes/NNN.md`

首部字段：

| 字段 | 类型 | 约束 |
|---|---|---|
| `schema_version` | string | 固定为 `0.1` |
| `episode_id` | string | 包内稳定 ID，推荐 `E001` 格式，唯一 |
| `episode_number` | integer | 必须与文件名数字一致 |
| `title` | string | 非空 |
| `status` | enum | 本版必须为 `confirmed` |

正文必须包含 `## Content` 且非空。`## Objective`、`## Hook`、`## Previous Bridge`、`## Next Bridge`、`## Character Refs`、`## Scene Refs` 为可选区块；引用必须使用 `characters.md`/`scenes.md` 中已声明的 `external_id`。`Content` 原文按字节保留，不得在导入时改写、去空白、自动分段或重新编号。

#### `source-manifest.md`

必填字段：`schema_version=0.1`、`source_id`、`source_kind`、`processed_at`、`processor`、`human_reviewed=true`、`package_fingerprint`。`source_kind` 必须是 `external_prepared` 或 `external_episodic`；`processor` 只记录工具名称和版本，不记录密钥。

可选字段：`original_name`、`original_uri`、`original_content_hash`、`processing_steps`、`reviewer_note`。`original_uri` 可以是脱敏后的普通 URL，不得要求平台访问它，也不得把它作为导入成功的前置条件。

## 4. 解析预览 DTO（只读）

解析接口的具体 HTTP 路径留给后续公共契约 PR；本节冻结返回语义和字段名。所有数组按文件/集号/外部 ID 的确定性顺序排序。

```json
{
  "contract_version": "0.1",
  "source_kind": "markdown_episode_package",
  "target_mode": "new_project",
  "status": "ready",
  "can_confirm": true,
  "preview_token": "pv_opaque_short_lived_token",
  "package": {
    "package_id": "demo-night-market",
    "package_version": 1,
    "package_fingerprint": "sha256:...",
    "validation_fingerprint": "sha256:...",
    "files": [
      { "path": "drama-package.md", "file_hash": "sha256:...", "byte_length": 1234 }
    ]
  },
  "project": {
    "title": "夜市回声",
    "genre": "悬疑",
    "style": "2d-cinematic",
    "aspect_ratio": "9:16",
    "target_episode_count": 2,
    "bible_summary": "..."
  },
  "characters": [
    { "external_id": "C001", "name": "林夏", "role": "protagonist", "episode_refs": ["E001"] }
  ],
  "scenes": [
    { "external_id": "S001", "location": "旧城夜市", "time": "night", "episode_refs": ["E001"] }
  ],
  "episodes": [
    {
      "external_id": "E001",
      "episode_number": 1,
      "title": "灯灭之前",
      "status": "confirmed",
      "content_char_count": 318,
      "content_hash": "sha256:...",
      "character_refs": ["C001"],
      "scene_refs": ["S001"]
    }
  ],
  "source": {
    "source_id": "night-market-source-20260907",
    "human_reviewed": true,
    "processor": "CodeBuddy 1.x"
  },
  "diagnostics": {
    "missing": [],
    "conflicts": [],
    "warnings": []
  },
  "write_plan": {
    "writes_on_parse": [],
    "writes_after_confirm": ["drama", "source_version", "episodes", "characters", "scenes", "episode_links"]
  }
}
```

解析阶段禁止返回数据库自增 ID 作为外部引用的替代品；预览中的实体只能用 `package_id`、`episode_id`、`external_id` 和内容指纹互相引用。`status` 取 `ready` 或 `blocked`；存在任意 error 级诊断时必须为 `blocked` 且 `can_confirm=false`。

## 5. 确认写入边界、幂等和冲突

### 5.1 两个阶段

1. **Parse / Preview**：读取上传内容、规范化、校验和生成 DTO。不得写项目、版本、剧集、人物、场景，不得调用模型。
2. **Confirm / Commit**：用户明确确认预览结果后才写入。所有业务写入必须在一个可回滚的事务中完成；失败时不得留下半个项目、孤儿剧集或孤儿资产。

确认请求必须携带 `preview_token`、`package_fingerprint`、`validation_fingerprint`、`target_mode=new_project` 和 `confirm_idempotency_key`。Parse 服务必须在短期、不可变的预览存储中保留 token 对应的逐文件 hash/字节快照；Confirm 还必须提交完整的当前包，或引用同一不可变上传句柄。

Confirm 固定按以下顺序处理：

1. 先验证 `preview_token`、当前包的全部 `file_hash`、`package_fingerprint` 和 `validation_fingerprint`；任一快照内容不一致立即返回 `PACKAGE_SNAPSHOT_MISMATCH`，不进入幂等查询或结果重放。
2. 快照验证通过后，再按 5.2 比较 `confirm_idempotency_key + package_fingerprint + validation_fingerprint + target_mode`；同 key 绑定了不同身份时返回 `IDEMPOTENCY_KEY_REUSED`，不得静默返回旧成功结果。
3. 只有身份匹配且需要首次写入时，才进入同一数据库事务。

manifest 也在全部文件比对范围内，因此预览后任一文件（包括 `source-manifest.md`）变化都必须先返回 `PACKAGE_SNAPSHOT_MISMATCH`。`PACKAGE_HASH_MISMATCH` 仅用于 Parse 阶段发现 `source-manifest.md` 声明的 `package_fingerprint` 与当前包计算值不一致。

> **实现注记：v0.1 的实际处理顺序与目标顺序的差异（2026-09-12 登记）**
>
> 上面 1 → 2 → 3 是本契约要求的**目标顺序**。v0.1 当前实现
> （`backend/src/services/production-package-import.ts`）的实际顺序是：
> 先按 §5.2 查既有幂等记录并比对四项身份（即上面的第 2 步），然后再加载预览快照、
> 校验指纹与上传字节（第 1 步），最后进入业务事务（第 3 步）。
>
> 两者只在**同时发生"身份冲突"与"快照变化"**的夹缝场景下产生可观察差异：此时当前实现返回
> `IDEMPOTENCY_KEY_REUSED`，而按目标顺序会先返回 `PACKAGE_SNAPSHOT_MISMATCH`。
> v0.1 的正常路径（首次确认、同 key 幂等重放、换包换 key）两种顺序结果一致。
>
> 该差异**不影响 v0.1 的功能正确性与数据安全**（首次写入仍在事务内、身份四项比对与快照校验都不缺），
> 已在 PR #118（Issue #117）的复核结论中登记为独立后续评估项。后续调整 Confirm 链路时按目标顺序收敛，
> 并补充"同 key + 预览后包被修改"的组合用例。

### 5.2 幂等键

- `confirm_idempotency_key` 是调用方生成的稳定不透明字符串，长度 16–128 个 ASCII 字符。
- 一次确认的逻辑身份固定为 `confirm_idempotency_key + package_fingerprint + validation_fingerprint + target_mode`；四项完全相同的重复确认必须返回第一次确认的同一结果，不得创建第二个项目。
- 同一 key 绑定不同 `package_fingerprint`、不同 `validation_fingerprint` 或不同 `target_mode` 必须阻断并返回 `IDEMPOTENCY_KEY_REUSED`。`confirm_idempotency_key` 仍使用唯一约束实现并发串行化，绑定字段用于判断是否为同一次确认。
- 不同 key 可以有意创建另一个新项目；平台不得仅凭 `package_id` 静默复用旧项目。
- 该强语义需要一个独立的持久化导入记录，不能用 `dramas.metadata` 或内存缓存替代。后续 schema/API 契约 PR 必须授权最小记录 `production_package_imports`：`confirm_idempotency_key`（唯一约束）、`package_fingerprint`、`validation_fingerprint`、`target_mode`、`status`（本版只落 `succeeded`）、`drama_id`、`result_json` 和创建/完成时间。
- 幂等记录的 INSERT、`dramas`/`source_versions`/`episodes`/资产写入，以及记录 `succeeded + drama_id + result_json` 必须在**同一个数据库事务**中完成并一起 commit；不允许先单独 claim 再开业务事务，也不允许持久化无法恢复的 `in_progress` 或独立失败记录。
- 相同 key 的并发请求必须等待唯一约束对应的事务完成：首个事务 commit 后，后续请求读取 `succeeded` 原结果；首个事务 rollback（包括幂等记录和全部业务数据）后，后续请求可以安全重新执行。commit 已完成但响应丢失时，重试只读取已保存结果；业务写入任一步失败则整笔 rollback 并返回 `PACKAGE_WRITE_FAILED`。
- 同一 key 换 fingerprint 永远返回 `IDEMPOTENCY_KEY_REUSED`；不同 key 才能创建另一个新项目。本 PR 只冻结该事务/持久化边界，不执行迁移；在该独立契约获批准并落地前，不得实现声称满足 v0.1 强幂等的 Confirm 端点。

### 5.3 v0.1 新项目写入顺序

确认通过后，建议按以下顺序在同一业务事务中写入现有表；导入记录也必须按 5.2 参加同一事务。其表结构由后续 schema/API 契约授权，本 PR 不执行迁移：

1. `dramas`：写入 `title`、`genre`、`style`、`aspect_ratio`、`total_episodes`、`description`。`metadata` 可保存脱敏的 package/source 摘要、版本和指纹。
2. `source_versions`：写入一条 `base_kind=source` 的不可变版本，`content` 使用**按集号拼接的已确认正文**：每集正文末尾一个 LF，仅在非最后一集后额外追加一个 LF；`content_hash/base_hash` 必须对该 UTF-8 canonical bytes 计算，并以 64 位 lowercase hex（无 `sha256:` 前缀）写入数据库，`stats` 标记 `origin=production_package` 和 package fingerprint。若未来包提供独立 `source.md`，才可用其内容替代拼接正文。
3. `episodes`：按 `episode_number` 写入 `title`、`content`、`status=draft`；不写 `script_content`、视频 URL 或生成任务。
4. `characters`、`scenes`：只写 Markdown 中的文本字段，生成新的数据库 ID；不导入图片、不调用提取 Agent。再用 `episode_characters`、`episode_scenes` 建立关系。
5. 将 `dramas.current_source_version_id` 指向本次新建 source 版本，并保存确认结果/版本来源摘要。

`dramas.description` 是旧链路兼容落点：v0.1 对已分集包使用与 `source_versions.content` 相同的按集拼接正文，不能写成大纲摘要，也不能覆盖包中任何单集正文。后续 UI 若展示来源，必须标注该正文是 `package-derived`，原始外部来源以 `source-manifest.md` 和指纹为准。

现有 `backend/src/services/source-versions.ts` 的 `sourceVersionContentHash` 遵循旧版 I1：对字符串执行 `trim()` 后再 hash；该 helper 只保留给旧项目兼容路径。生产包导入必须使用独立的 byte-oriented canonical hash，不得调用或修改这个会丢失尾部 LF/边界空白的旧 helper；本契约 PR 不改运行时代码。

### 5.4 冲突和人工选择

- v0.1 只支持新建项目，因此不会自动合并已有角色/场景。
- 包内重复 `external_id`、同集号不同正文、未知角色/场景引用、目标集数与文件数不一致，均为阻断冲突。
- 后续已有项目导入必须先展示 name/ID/内容差异，由用户逐项选择“复用、创建副本或跳过”；禁止按名称相似度静默更新。
- 解析预览显示的缺失项和冲突项必须保留 `path`、`field`、`code`、`message`，以便前端定位到具体文件和区块。

## 6. 兼容映射

| 生产包字段 | 现有数据落点 | v0.1 规则 |
|---|---|---|
| `drama-package.md` 元信息 | `dramas.title/genre/style/aspect_ratio/total_episodes` | 仅确认后写入；未知扩展保存在来源摘要，不擅自新增列 |
| `drama-package.md` Drama Bible | `dramas.metadata` 的 package 摘要；后续项目圣经字段 | 不写入 `description`；不得当作原文正文 |
| `episodes/*.md` Content | `episodes.content` | 原文保留；按集号唯一；不自动重写 |
| `source-manifest.md` 与指纹 | `source_versions.stats` + `dramas.metadata` 来源摘要 | 记录工具、版本、人工确认和 hash；不访问原始 URL |
| 按集拼接正文与 canonical hash | `dramas.description`、`source_versions.content/content_hash/base_hash` | 正文按 3.2 规则写入；数据库 hash 只存 64 位 lowercase hex，不含 `sha256:`；仅作为旧项目/旧接口兼容正文，标记 `package-derived` |
| `characters.md` | `characters` + `episode_characters` | 只创建文本实体和显式引用关系 |
| `scenes.md` | `scenes` + `episode_scenes` | 只创建文本实体和显式引用关系 |
| 外部 `episode_id/character_id/scene_id` | DTO 内部引用映射 | 不直接写入数据库 ID；确认时生成 mapping 并可追溯 |

以下现有字段不由 v0.1 包填充：`script_content`、`video_url`、`thumbnail`、`image_url`、`final_prompt`、生成任务及供应商配置。

## 7. 错误码与前端语义

| code | 阶段 | 等级 | 前端行为 |
|---|---|---|---|
| `PACKAGE_EMPTY` | parse | error | 提示上传包，不显示确认按钮 |
| `PACKAGE_SCHEMA_UNSUPPORTED` | parse | error | 显示支持的 `0.1` 版本，要求外部工具重新导出 |
| `PACKAGE_FILE_MISSING` | parse | error | 定位缺失路径；阻止确认 |
| `PACKAGE_FILE_UNEXPECTED` | parse | warning/error | 未知文件先 warning；二进制、越界或路径穿越为 error |
| `PACKAGE_ENCODING_INVALID` | parse | error | 提示转换为 UTF-8/Markdown |
| `PACKAGE_MANIFEST_INVALID` | parse | error | 定位 manifest 字段并阻止确认 |
| `PACKAGE_FRONTMATTER_INVALID` | parse | error | 定位文件和字段；阻止确认 |
| `PACKAGE_DUPLICATE_ID` | parse | error | 展示重复的 external ID 和路径 |
| `PACKAGE_EPISODE_INVALID` | parse | error | 展示文件名、集号或状态错误 |
| `PACKAGE_REFERENCE_UNKNOWN` | parse | error | 展示缺失的角色/场景 external ID |
| `PACKAGE_HASH_MISMATCH` | parse | error | `source-manifest.md` 声明的 `package_fingerprint` 与当前包计算值不一致；要求修正 manifest 或重新导出 |
| `PACKAGE_SNAPSHOT_MISMATCH` | confirm | error | 提示预览快照与当前包发生变化，要求重新解析 |
| `PACKAGE_TARGET_UNSUPPORTED` | parse/confirm | error | v0.1 只允许新建项目 |
| `IDEMPOTENCY_KEY_REUSED` | confirm | error | 提示确认 key 已绑定另一组 package/validation fingerprint 或 target mode |
| `PACKAGE_CONFLICT` | confirm | error | 展示冲突详情，要求用户重新确认 |
| `PACKAGE_WRITE_FAILED` | confirm | error | 展示可重试错误；事务必须回滚且不得自动重试写入 |

所有错误都应包含 `code`、`severity`、`path`（若适用）、`field`（若适用）和面向用户的 `message`。解析失败不得返回 200/ready，也不得以 warning 伪装阻断错误。

## 8. 测试矩阵

| 场景 | 输入/操作 | 预期 |
|---|---|---|
| T01 合法最小包 | 执行 `python docs/examples/verify-production-package-v0.1.py --check`，再解析 `examples/production-package-v0.1` | package/validation/canonical fingerprint 可复算且与期望向量一致；canonical 展示值去掉前缀后等于 DB 两列值；`ready=true`，两集、人物/场景引用完整，无写库 |
| T02 可选文件缺失 | 删除 `characters.md` 或 `scenes.md` | 仍可解析；对应数组为空，不产生 error |
| T03 缺必填文件 | 删除 `drama-package.md`/`source-manifest.md`/`episodes/001.md` | `PACKAGE_FILE_MISSING`，`can_confirm=false` |
| T04 集号错误 | 将 `episodes/001.md` 改名为 `002.md` 或跳号 | `PACKAGE_EPISODE_INVALID` |
| T05 重复实体 | 添加重复的 `C001` 或 `S001` 区块 | `PACKAGE_DUPLICATE_ID` |
| T06 未知引用 | episode 引用不存在的角色/场景 ID | `PACKAGE_REFERENCE_UNKNOWN` |
| T07a 内容变化 | 预览后修改任一非 manifest 文件再确认 | `PACKAGE_SNAPSHOT_MISMATCH`，不写库 |
| T07b manifest 变化 | 预览后只修改 `source-manifest.md`（例如 reviewer note）再确认 | `validation_fingerprint`/逐文件 hash 不一致，返回 `PACKAGE_SNAPSHOT_MISMATCH`，不写库 |
| T08 重复确认 | 相同 key、package fingerprint、validation fingerprint、target mode 确认两次 | 返回同一结果，不新增项目 |
| T08b manifest 变化后重放 | 同 key、同 package fingerprint，预览后只修改 manifest 再确认 | 第 1 步先返回 `PACKAGE_SNAPSHOT_MISMATCH`，不得重放旧成功结果 |
| T08c 新快照复用 key | 同 key 使用另一份合法 preview（package fingerprint 相同但 validation fingerprint 不同） | `IDEMPOTENCY_KEY_REUSED`，不得重放旧结果 |
| T09 key 复用 | 相同 key 换另一 package fingerprint 或 target mode 确认 | `IDEMPOTENCY_KEY_REUSED` |
| T10 解析只读 | 在 parse 期间检查 drama/source/episode/asset 表 | 行数和内容均不改变 |
| T11 事务回滚 | 确认写入中途注入失败 | 无半成品项目/剧集/资产；返回 `PACKAGE_WRITE_FAILED` |
| T12 禁止副作用 | 解析合法包并观察模型/任务调用 | 不调用 AI、供应商、生成任务或旧 clean 入口 |

实现 PR 必须把 T01–T12、T08b、T08c 映射到自动测试或可复现的验收脚本；本契约 PR 只冻结矩阵，不添加运行时代码。

## 9. 版本与后续扩展

- `0.x` 版本允许增加可选字段，但不得改变已有字段含义；未知可选字段只能进入 `extensions` + warning。
- 需要改变必填字段、指纹算法、写入边界或外部 ID 语义时，必须升级契约版本并提供迁移说明。
- ZIP/JSON、已有项目合并、全局资产版本、项目圣经独立表和导出能力另开契约/Issue；不得在实现 PR 中隐式扩大 v0.1 范围。
