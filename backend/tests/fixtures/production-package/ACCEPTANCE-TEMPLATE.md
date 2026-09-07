# 验收记录模板 — 生产包 v0.1（Issue #96 交付 3）

供人工复查与后续实现者填空使用。**不是代码，不会被测试执行。**
字段名与契约 `docs/production-package-import-v0.1.md` §4 DTO、§5 写入边界逐字对齐。

## 填写方式

每验一个样本（正例或负例）填一份。三档判定必须给出依据，不能只写结论。

| 区块 | 内容 |
|---|---|
| 1 输入 | 样本 ID、包路径、文件清单、manifest 声明的 `package_fingerprint` |
| 2 解析结果 | 逐文件：`path` → 状态（OK / E / W）→ 定位（文件名 + 字段或段名）→ `message` |
| 3 三档判定 | 解析失败 / 可预览但禁止确认 / 可确认但有警告，**三选一并写依据** |
| 4 缺失项 vs 冲突项 | 分开列。`diagnostics.missing` 与 `diagnostics.conflicts` 不得混在同一数组 |
| 5 确认写入前核对 | 见下节 |
| 6 写入后核对 | 见下节 |
| 7 复现方式 | 命令 + 期望输出片段。**不含密钥、不触发付费模型** |

---

## 三档判定规则（来自契约 §4 / §7 / §8）

| 档 | 判定依据 | `status` | `can_confirm` |
|---|---|---|---|
| **解析失败** | 存在任意 `error` 级诊断；包无法产出完整 DTO | `blocked` | `false` |
| **可预览但禁止确认** | 包可解析，但 Confirm 会失败：哈希比对不过（C1/C2）或 `target_mode` 不支持（C3） | `ready` | `false` |
| **可确认但有警告** | 仅有 `warning` 级诊断，无 error | `ready` | `true` |

契约 §4 明确规定：存在任意 error 级诊断时 `status` 必须为 `blocked` 且 `can_confirm=false`；
解析失败不得返回 200/ready，也不得以 warning 伪装阻断错误（§7 末句）。

### 「可预览但禁止确认」的三种来源

这三条容易混。区分点是**失败发生在哪个阶段**：

| 场景 | 阶段 | 错误码 | 是否进入幂等查询 |
|---|---|---|---|
| C1 预览后改了非 manifest 文件 | Confirm 快照校验 | `PACKAGE_HASH_MISMATCH` | 否 |
| C2 只改了 `source-manifest.md` | Confirm 快照校验 | `PACKAGE_HASH_MISMATCH` | 否 |
| C3 用 `target_mode=update` 导入 | Confirm 请求参数校验 | `PACKAGE_TARGET_UNSUPPORTED` | 否 |

C3 特别容易误标成 C1：包内容完全没变，指纹与预览一致，
冲突来自请求体而不是包。填表时必须确认「变异是字节改动还是参数改动」。

---

## 5 确认写入前需核对

- [ ] **只建不改**：`target_mode` 为 `new_project`。v0.1 不支持已有项目导入，
      不得把导入降级为覆盖式更新（§5.4 第 1 条）
- [ ] **解析阶段零写入**：`write_plan.writes_on_parse` 必须为**空数组**。
      非空即违反 §5.1，属于本 Issue 的红线
- [ ] **将要创建的清单**：项目元信息、人物数、场景数、剧集数，与 `project` / `characters` /
      `scenes` / `episodes` 数组长度一致
- [ ] **幂等键**：`confirm_idempotency_key` 的值，以及逻辑身份四元组
      （`confirm_idempotency_key + package_fingerprint + validation_fingerprint + target_mode`）
      是否已存在（§5.2）
- [ ] **冲突项为空**：`diagnostics.conflicts` 非空必须阻断（§5.4 第 2 条）
- [ ] **警告已展示**：所有 W 档已呈现给用户，未被静默吞掉。
      尤其 `extensions` 里的未识别 front matter 字段必须真的出现在输出中（§3.3）
- [ ] **引用完整**：`episodes[].character_refs` / `scene_refs` 里的每个 ID
      都能在 `characters` / `scenes` 中找到（§3.3）。
      **两侧都要查**——只查一侧引用清单会漏掉另一侧

## 6 写入后需核对

- [ ] **项目表**：`dramas.title/genre/style/aspect_ratio/total_episodes` 与包一致（§5.3 第 1 条）
- [ ] **`dramas.description` 不是大纲摘要**：v0.1 对已分集包必须写成与
      `source_versions.content` 相同的按集拼接正文（§5.3 末段）。
      写成 Drama Bible 摘要即违约——这是最常见的实现错误
- [ ] **来源版本**：`content` 是按集号排序、非末集后再加一个 LF 的 canonical bytes；
      `content_hash` / `base_hash` 是**64 位 lowercase hex、无 `sha256:` 前缀**（§3.2 末段、§5.3 第 2 条）
- [ ] **不得复用旧 hash helper**：`backend/src/services/source-versions.ts` 的
      `sourceVersionContentHash` 会先 `trim()`，会丢失尾部 LF 与边界空白（§5.3 倒数第 2 段）。
      生产包导入必须用独立的 byte-oriented canonical hash
- [ ] **原文保留**：剧集 `content` 按字节保留，**不得去噪、去空白、自动分段或重新编号**
      （§3.3 `## Content` 段末句）。写入后与预览的 `content_hash` 逐项比对
- [ ] **剧集 status**：写入后为 `draft`（§5.3 第 3 条），不是包里的 `confirmed`。
      包里的 `confirmed` 是**导入资格**，不是平台状态
- [ ] **引用无悬挂**：`episode_characters` / `episode_scenes` 指向本次新建的行，
      不指向任何既有项目的行（§5.3 第 4 条）
- [ ] **不调用生成**：不写 `script_content`、视频 URL、`sys_task`（§5.3 第 3 条）。
      本 fixture 全程无 `sys_task`、无 adapter 调用、无付费模型
- [ ] **当前版本指针**：`dramas.current_source_version_id` 指向本次新建的 source 版本（§5.3 第 5 条）
- [ ] **幂等记录**：`production_package_imports` 与业务写入在**同一个事务**中 commit（§5.2）。
      不得先单独 claim 再开业务事务，不得持久化 `in_progress`
- [ ] **幂等复验**：同一包 + 同一幂等键重复导入一次，**不重复创建任何行**（§5.2）
- [ ] **换指纹必拒**：同一幂等键 + 不同 fingerprint 返回 `IDEMPOTENCY_KEY_REUSED`（§5.2）

---

## 7 复现方式

```bash
# 后端目录内。纯静态 fixture，无数据库、无网络、无模型调用。
node tests/fixtures/production-package/scripts/verify-package.mjs --check

# 契约自带的参考实现（独立口径，交叉验证）
python docs/examples/verify-production-package-v0.1.py \
  --package-root backend/tests/fixtures/production-package/packages/fixture-rain-lantern

# 跑 fixture 自身测试（36 条）
node --import tsx/esm --test --test-force-exit \
  tests/fixtures/production-package/production-package.test.mjs
```

期望输出片段（正例，见 `manifest.mjs` 的 `EXPECTED.positive`）：

```text
package_fingerprint:        sha256:4f0a6bd0380164258303d49bc5d313f32357d1826e65f31fbb0da85f8b9ddb87
validation_fingerprint:     sha256:27bf55175fad58cb7db9a34275b96bc79fca7d1af03c7bf7dad28cb91f255d10
source_version_canonical:   sha256:f10a6a95abc2234ebf02ae8ca57915fdf44111524c982d533fdf8bbaf1dca88a
```

## 边界声明

- 本模板与 fixture 均为**只读解析**口径。解析器、路由、schema、幂等记录表尚未实现
  （§5.2 明确需独立契约 PR 授权迁移，本 Issue 不执行）
- 因此第 5、6 节的条目目前只能作为**人工核对清单**，不能由测试自动判定
- 样本全部为原创虚构内容，无第三方版权、无隐私、无密钥，不触发付费模型
