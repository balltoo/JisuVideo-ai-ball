# 短剧生产包 ZIP 传输与预览快照契约 v0.1

> 状态：阶段 1 ZIP 传输子契约 / 已冻结实施基线
> 关联语义契约：[`production-package-import-v0.1.md`](production-package-import-v0.1.md)
> 适用阶段：ZIP 上传 → 安全解压 → 只读解析 → 预览
>
> 本文只定义“怎么把生产包安全送到解析器”。Markdown 文件布局、字段、指纹和 DTO
> 语义仍以关联的生产包导入契约为准；本文不改变现有 parser 的语义，也不实现确认写入。

## 1. 目标与非目标

### 1.1 目标

首版为用户提供一个稳定、可复现的生产包输入方式：上传一个 ZIP，服务端把它解压到隔离的临时快照，再调用现有只读 `parseProductionPackage()`。

固定链路如下：

```text
ZIP 原始字节
  → 归档安全检查
  → 隔离临时目录解压
  → 唯一包根识别
  → 只读 parser
  → 不可变预览快照 + preview_token
  → 预览 DTO
```

### 1.2 非目标

- 不在 ZIP 层实现 Markdown 语义解析；
- 不在 Parse/Preview 阶段创建项目、剧集、人物、场景、source version 或任务；
- 不调用 AI、供应商或旧的原文整理入口；
- 不支持 JSON、URL、服务器本地路径、文件夹上传或增量包；
- 不支持导入已有项目、覆盖更新、合并项目或导出；
- 不在本契约中冻结具体 HTTP 路径和 UI 组件，这些由后续 API/UI 任务定义。

## 2. 输入格式

### 2.1 上传载体

- 请求只能包含一个 ZIP 文件；
- 文件名仅用于展示，不能参与包身份、fingerprint 或授权判断；
- ZIP 采用标准 central directory；损坏、截断、无法列目录或无法解压的归档直接拒绝；
- 不接受 ZIP 内再嵌套的 ZIP、TAR、GZ、7Z、RAR 等归档文件，避免把递归解包风险带入 parser；
- 解压后的未知 Markdown 文件仍由 parser 按既有规则产生 warning/error，不在传输层静默删除。

### 2.2 固定安全上限

以下限制是首版硬上限，API 和实现不得自行放宽；后续调整必须更新本契约和测试向量。

| 项目 | 上限 | 说明 |
|---|---:|---|
| ZIP 原始字节 | 25 MiB | 上传请求在读取阶段即限制，超限不落盘 |
| 解压后全部文件字节 | 100 MiB | 按实际写入字节累计，超限立即终止并清理 |
| 文件总数 | 1,000 | 目录项和文件项均计数，拒绝超限归档 |
| 单文件解压后字节 | 10 MiB | 包含 Markdown 和未知文件 |
| 相对路径深度 | 8 | 按 `/` 分段计数，包根本身不计 |
| 单项压缩比 | 100:1 | 压缩大小为 0 且解压大小大于 0 时直接拒绝 |
| 归档嵌套层数 | 0 | 不允许 ZIP 内再包含归档文件 |

压缩比检查不能替代解压后总大小检查；两项都必须执行。服务端不得先完整解压再检查上限。

## 3. 路径与归档条目安全

解压前必须读取每个条目的元数据并以 POSIX `/` 形式规范化，任何一项不合格都拒绝整个上传：

- 拒绝以 `/`、`\\` 或盘符（如 `C:`）开头的绝对路径；
- 拒绝包含空字节的名称；
- 拒绝任意 `..` 路径段；
- 允许 `.` 段但规范化后不得为空或越出目标目录；
- 拒绝规范化后重复的路径；
- 为兼容 Windows 临时目录，大小写折叠后发生冲突也拒绝；
- 拒绝符号链接、硬链接、设备文件和其他非普通文件条目；
- 拒绝目录穿越、目标目录外写入和解压器自动跟随链接；
- 解压目标必须由服务端随机创建，不能使用用户提供的路径或文件名。

归档中的目录项可以省略；服务端根据文件条目的规范化路径创建目录。包根识别只允许以下两种形态：

1. 生产包文件直接位于 ZIP 根目录；或
2. 所有生产包文件共享唯一的一层顶级目录。

多个顶级目录、同时存在根文件和多个候选目录、或无法唯一定位 `drama-package.md` 与 `source-manifest.md` 的归档，返回 `PACKAGE_ARCHIVE_ROOT_AMBIGUOUS`，不进入 parser。

## 4. 快照与解析生命周期

### 4.1 上传阶段

Preview API 只能运行在已接入服务端认证中间件的受控边界内：路由从请求上下文读取
经过验证的用户/租户身份，客户端提交的 `x-user-id`、`x-tenant-id` 等 Header 不参与
隔离判断。认证上下文缺失时返回 `PACKAGE_PREVIEW_UNAUTHORIZED`（HTTP 401），不得
回退到匿名身份；测试或内部调用必须通过服务端身份解析器注入已验证身份。

1. 校验请求身份、内容类型和原始字节上限；
2. 将原始 ZIP 写入服务端专用临时目录，文件名使用随机值；
3. 计算 `upload_sha256`，扫描 central directory 和条目安全属性；
4. 按第 2、3 节限制流式解压；
5. 识别唯一包根；
6. 调用 `parseProductionPackage(packageRoot)`；
7. 保存不可变快照元数据和 parser 返回的逐文件 hash；
8. 返回预览 DTO 与不透明 `preview_token`。

任何一步失败都必须删除原始 ZIP、解压目录和未完成快照，并返回结构化错误。

### 4.2 不可变预览快照

快照至少包含：

- 随机 `snapshot_id`；
- 当前用户/租户身份；
- 原始上传 `upload_sha256`；
- 解析后的 `package_fingerprint`；
- 解析后的 `validation_fingerprint`；
- 全部文件的规范化 `path`、`file_hash`、`byte_length`；
- 解压后的服务端内部句柄；
- 创建时间、过期时间和清理状态。

快照一旦生成，内容和文件列表不可原地修改。客户端不能提交 DTO 替代快照，也不能提交任意本地路径让服务端重新读取。

### 4.3 `preview_token`

- `parseProductionPackage()` 返回的 DTO 可能带有解析器内部生成的 `preview_token`；该值不是传输层 token，Preview API 必须丢弃它；
- token 为至少 192 bit 熵的不透明随机值，使用 URL 安全编码；
- token 只引用服务端快照，不编码或暴露服务器路径；
- token 绑定用户/租户、snapshot、package/validation fingerprint 和 `target_mode`；
- 首版 TTL 为 30 分钟；过期后预览和确认均拒绝；
- token 不可跨用户使用；
- token 不能单独作为 Confirm 身份，Confirm 仍需提交契约规定的 fingerprint 和幂等 key；
- token、快照和临时目录清理是同一生命周期，清理失败必须可重试并可观测。

Preview API 对外只返回上述快照 token，并覆盖 parser DTO 中原有的 `preview_token` 字段；客户端和后续 Confirm 不得看到或依赖 parser 生成的内部 token。若未来改为由调用方把 token 注入 parser，必须另行更新本契约和接口测试，不能让两种 token 同时对外存在。

## 5. 错误语义

传输层错误使用独立错误码；解析器返回的 `PACKAGE_*` 错误原样保留其 `severity/path/field/message`。

| code | 场景 | 是否进入 parser |
|---|---|---|
| `PACKAGE_ARCHIVE_INVALID` | 非 ZIP、损坏、截断或无法读取 central directory | 否 |
| `PACKAGE_ARCHIVE_LIMIT` | 原始大小、解压大小、文件数、单文件大小、深度或压缩比超限 | 否 |
| `PACKAGE_ARCHIVE_PATH_INVALID` | 绝对路径、穿越、重复路径、链接或非普通文件 | 否 |
| `PACKAGE_ARCHIVE_NESTED` | ZIP 内包含嵌套归档 | 否 |
| `PACKAGE_ARCHIVE_ROOT_AMBIGUOUS` | 无法唯一定位生产包根 | 否 |
| `PACKAGE_PREVIEW_NOT_FOUND` | token 对应快照不存在或已清理 | 否 |
| `PACKAGE_PREVIEW_EXPIRED` | token 超过 TTL | 否 |
| `PACKAGE_PREVIEW_UNAUTHORIZED` | 缺少或无法验证服务端会话身份 | 否 |
| `PACKAGE_SNAPSHOT_MISMATCH` | Confirm 时当前快照/文件 hash 与预览不一致 | 否，先于幂等查询 |

所有传输层错误必须返回稳定的 `code`、`severity=error` 和面向用户的 `message`。不得返回临时目录、服务器本地绝对路径、归档内部堆栈、密钥或用户隐私。

注意：`PACKAGE_HASH_MISMATCH` 只表示 parser 发现 `source-manifest.md` 声明的 `package_fingerprint` 与当前包计算值不一致；Confirm 在预览快照与当前内容不一致时必须使用 `PACKAGE_SNAPSHOT_MISMATCH`，不得把快照变化伪装成 manifest 字段错误。

## 6. 清理、隔离与观测

- 每次上传使用独立随机目录，目录权限仅服务进程可读写；
- 解析和预览期间只读快照，不允许业务代码修改包文件；
- 过期快照由定时清理任务处理，进程启动时执行一次过期扫描；
- 清理采用幂等删除，部分删除失败不能阻塞其他快照；
- 清理失败记录 snapshot_id、错误类别和重试次数，但不记录原始内容；
- 记录上传大小、解压大小、文件数、解析耗时、结果状态和错误码；不记录 ZIP 原文、密钥或完整用户路径；
- 监控临时目录总大小、过期快照数量、解压拒绝数量和 parser 失败数量。

## 7. 验收矩阵

### 7.1 正常路径

- [ ] 直接根目录 ZIP 可识别并调用现有 parser；
- [ ] 单一顶级目录 ZIP 可识别并调用现有 parser；
- [ ] parser 的正例 DTO、fingerprint 和 warning/error 语义保持不变；
- [ ] 解析期间正式业务表行数和内容均不变；
- [ ] 预览结果包含 token、两个 fingerprint 和逐文件 hash。

### 7.2 安全拒绝

- [ ] `../x`、绝对路径、盘符路径、反斜杠路径和 NUL 文件名；
- [ ] 符号链接、硬链接、设备文件和重复规范化路径；
- [ ] 多顶级目录、根文件与顶级目录混用、无法定位包根；
- [ ] 损坏 ZIP、嵌套归档、压缩比超限、单项/总量/文件数/深度超限；
- [ ] 每种拒绝均返回稳定错误码并清理临时文件。

### 7.3 快照与重复操作

- [ ] token 不能跨用户使用；
- [ ] token 过期、快照清理后访问均返回对应错误；
- [ ] 重复解析同一 ZIP 得到相同 parser 指纹和 DTO（运行时 token 除外）；
- [ ] 预览阶段重复上传不会创建正式项目；
- [ ] 快照内容发生变化时，Confirm 在幂等查询前返回 `PACKAGE_SNAPSHOT_MISMATCH`；parser 自身的 manifest 指纹错误仍保持 `PACKAGE_HASH_MISMATCH`。

## 8. 后续任务边界

本契约批准后，按以下顺序开实现任务：

1. Preview API：上传、解压、快照、token 和 DTO 返回；
2. `production_package_imports` schema 与 Confirm API：验证快照后在单事务中写入；
3. 导入页面：上传、预览、错误展示和确认按钮；
4. 真实代表生产包端到端验收。

在 Preview API 和 Confirm 契约批准前，不启动项目圣经页面、全局资产拆分或生成上下文接线。
