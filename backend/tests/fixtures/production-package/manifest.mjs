/**
 * Issue #96 / 生产包 v0.1 验收样本清单与人工预期（静态固化）
 *
 * 本文件是 fixtures 的唯一「静态真值」：哈希 / 字节数 / 预期错误码固定在此，
 * production-package.test.mjs 用文件实时值逐项断言，防止样本被无意改动。
 *
 * 口径来源：docs/production-package-import-v0.1.md §3.2 / §7 / §8。
 * 口径实现：helpers.mjs（与 docs/examples/verify-production-package-v0.1.py 交叉验证一致）。
 * 复算命令：node tests/fixtures/production-package/scripts/verify-package.mjs --check
 *           python docs/examples/verify-production-package-v0.1.py --package-root
 *             backend/tests/fixtures/production-package/packages/fixture-rain-lantern
 *
 * 字节口径（§3.2）：
 *   file_hash          = SHA-256(normalized_file_bytes)      ← CRLF/CR→LF，末尾恰好一个 LF
 *   package_fingerprint    = 逐行 path+NUL+hash+LF 再 SHA-256，**不含** source-manifest.md
 *   validation_fingerprint = 同上，**含** source-manifest.md（Confirm 比对用，不写回）
 *   canonical_hash     = 按集号拼接 episode_content_bytes 后 SHA-256
 *
 * 样本全部原创虚构内容，无第三方版权、无隐私、无密钥，不触发付费模型。
 * 工作树必须用 core.autocrlf=false / .gitattributes 锁定 LF（见仓库根 .gitattributes）。
 */
export const MANIFEST_VERSION = 'production-package-fixture/1.0.0'
export const CONTRACT_VERSION = '0.1'
export const CONTRACT_DOC = 'docs/production-package-import-v0.1.md'
export const POSITIVE_ID = 'fixture-rain-lantern'

/** §7 错误码常量（与契约表格逐字一致，避免拼写漂移）。 */
export const CODE = {
  EMPTY: 'PACKAGE_EMPTY',
  SCHEMA_UNSUPPORTED: 'PACKAGE_SCHEMA_UNSUPPORTED',
  FILE_MISSING: 'PACKAGE_FILE_MISSING',
  FILE_UNEXPECTED: 'PACKAGE_FILE_UNEXPECTED',
  ENCODING_INVALID: 'PACKAGE_ENCODING_INVALID',
  MANIFEST_INVALID: 'PACKAGE_MANIFEST_INVALID',
  FRONTMATTER_INVALID: 'PACKAGE_FRONTMATTER_INVALID',
  DUPLICATE_ID: 'PACKAGE_DUPLICATE_ID',
  EPISODE_INVALID: 'PACKAGE_EPISODE_INVALID',
  REFERENCE_UNKNOWN: 'PACKAGE_REFERENCE_UNKNOWN',
  HASH_MISMATCH: 'PACKAGE_HASH_MISMATCH',
  TARGET_UNSUPPORTED: 'PACKAGE_TARGET_UNSUPPORTED',
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
  CONFLICT: 'PACKAGE_CONFLICT',
  WRITE_FAILED: 'PACKAGE_WRITE_FAILED',
}

export const EXPECTED = {
  positive: {
    packageFingerprint: 'sha256:4f0a6bd0380164258303d49bc5d313f32357d1826e65f31fbb0da85f8b9ddb87',
    validationFingerprint: 'sha256:27bf55175fad58cb7db9a34275b96bc79fca7d1af03c7bf7dad28cb91f255d10',
    sourceVersionCanonicalHash: 'sha256:f10a6a95abc2234ebf02ae8ca57915fdf44111524c982d533fdf8bbaf1dca88a',
    sourceVersionCanonicalBytesLength: 803,
    // package_id / title 等 front matter 值，供解析器实现后断言 DTO 使用
    packageId: 'fixture-rain-lantern',
    title: '灯下旧物',
    genre: '悬疑',
    style: '2d-cinematic',
    aspectRatio: '9:16',
    targetEpisodeCount: 2,
    characterIds: ['C001', 'C002'],
    sceneIds: ['S001', 'S002'],
    episodeIds: ['E001', 'E002'],
    files: [
      { path: 'characters.md', fileHash: '03256f2e90bcab100d805d6ca60f8bb5a2c95be0da43cb674936bd5ca660e016', byteLength: 831 },
      { path: 'drama-package.md', fileHash: '97c346ddb36482c3375a34381f8fbc38657d6f18127ce5d9452ed2d48fdad2b1', byteLength: 1195 },
      { path: 'episodes/001.md', fileHash: 'b2549e5948849f4a8b0c27ca6a4445a286185ce95c03154ae623e46fdba008ed', byteLength: 844 },
      { path: 'episodes/002.md', fileHash: '31dfc641e96bea595b0921373b40b3617ed9cde247aead6aaa044b1b443996f4', byteLength: 878 },
      { path: 'scenes.md', fileHash: '86f342c6a51cef7b3d21f55329b5b511011ab1236457d65de0f077b715a43fa3', byteLength: 705 },
      { path: 'source-manifest.md', fileHash: '8e7cd35568b2b4394dbd65e8a19ceb7324bc282c3f8d6fda65e0bb4b5857cbe8', byteLength: 848 },
    ],
    episodes: [
      {
        episodeNumber: 1,
        contentHash: 'sha256:63036c62e068424989161a71bb68ca25b4204af80a6e2daabc7e34db24e46bf3',
        contentBytes: 424,
        contentChars: 142,
      },
      {
        episodeNumber: 2,
        contentHash: 'sha256:dc0a96b3836e7fdecff68a85cb33a14b42cb56e486eddface6c8e50461a605ba',
        contentBytes: 378,
        contentChars: 134,
      },
    ],
  },
}

/**
 * 负例矩阵：11 条阻断 + 5 条警告 + 4 条 confirm 阶段（哈希比对 2 + 冲突/幂等 2）。
 *
 * 每例给出**变异操作**与**该变异后的可复算真值**。真值存在的意义是：
 * 断言不能只看「返回失败」，必须验证**哪一段指纹变了、哪一段不变**。
 * 后者才是本契约最容易被实现错的边界——见 B3/T07b 的 package 不变而 validation 变化。
 */
export const NEGATIVES = [
  // ─────────────────────────── 8 条阻断 ───────────────────────────
  {
    id: 'B1',
    severity: 'error',
    code: CODE.FILE_MISSING,
    contract: 'T03 / §5.4',
    mutate: 'delete',
    target: 'drama-package.md',
    expected: '缺项目元信息；错误需定位缺失路径并阻止确认',
    expect: { packageFingerprintChanges: true, validationFingerprintChanges: true, canonicalHashChanges: false },
    note: 'canonical_hash 只覆盖剧集正文（契约 §3.2），删 drama-package.md 不改它；这条断言可防把 canonical 误当包全局 hash。同时错误文案必须定位到缺失路径。',
  },
  {
    id: 'B2',
    severity: 'error',
    code: CODE.FRONTMATTER_INVALID,
    contract: '§3.3 / §7',
    mutate: 'replace',
    target: 'drama-package.md',
    replace: { find: 'package_id: fixture-rain-lantern', with: 'package_id: "Fixture Rain Lantern"' },
    expected: 'package_id 违反 ^[a-z0-9][a-z0-9._-]{2,63}$（含空格/大写）',
    expect: { packageFingerprintChanges: true, validationFingerprintChanges: true, canonicalHashChanges: false },
  },
  {
    id: 'B3',
    severity: 'error',
    code: CODE.FILE_MISSING,
    contract: 'T03 / §3.1',
    mutate: 'delete',
    target: 'source-manifest.md',
    expected: 'source-manifest.md 是必填文件，缺失即解析失败（T03 / §3.1）',
    expect: { packageFingerprintChanges: false, validationFingerprintChanges: true, canonicalHashChanges: false },
    note: '关键边界：package_fingerprint **不含** manifest，因此删除 manifest 后它不变；validation_fingerprint 变。断言若只检查 package_fingerprint 会漏掉这条。',
  },
  {
    id: 'B4',
    severity: 'error',
    code: CODE.FILE_MISSING,
    contract: 'T03 / §3.1',
    mutate: 'delete',
    target: 'episodes/001.md',
    expected: 'episodes/ 不再包含从 001 开始的连续集号',
    expect: { packageFingerprintChanges: true, validationFingerprintChanges: true, canonicalHashChanges: true },
  },
  {
    id: 'B5',
    severity: 'error',
    code: CODE.ENCODING_INVALID,
    contract: '§3.2 / §7',
    mutate: 'binary',
    target: 'episodes/002.md',
    prefix: [0xef, 0xbb, 0xbf],
    expected: 'UTF-8 BOM 必须被拒绝，不是归一化后静默通过',
    expect: { rejectsRead: true },
    note: 'CRLF 属于归一化范围（见 T01b 正例断言），BOM 才是阻断。两者不要混为一个用例。',
  },
  {
    id: 'B6',
    severity: 'error',
    code: CODE.DUPLICATE_ID,
    contract: 'T05 / §3.3',
    mutate: 'duplicate-id',
    target: 'characters.md',
    anchor: '## character: C002',
    replacement: '## character: C001',
    expected: '重复 external_id；错误需展示重复的 ID 与路径',
    expect: { packageFingerprintChanges: true, validationFingerprintChanges: true, canonicalHashChanges: false },
  },
  {
    // Issue #96 交付 2 点名项：「角色引用缺失」。契约 §3.3 要求引用必须用
    // characters.md / scenes.md 已声明的 external_id，错误码见 §7 PACKAGE_REFERENCE_UNKNOWN。
    id: 'B7',
    severity: 'error',
    code: CODE.REFERENCE_UNKNOWN,
    contract: 'T06 / §3.3',
    mutate: 'replace',
    target: 'episodes/001.md',
    replace: { find: '- C001', with: '- C999' },
    expected: '引用了 characters.md 未声明的 C999；错误必须包含缺失 ID 本身',
    expect: { packageFingerprintChanges: true, validationFingerprintChanges: true, canonicalHashChanges: false },
    note: '断言输出中必须出现 C999 字面量——否则「missingRefs 非空即通过」的弱断言就能绕过。',
  },
  {
    id: 'B8',
    severity: 'error',
    code: CODE.EPISODE_INVALID,
    contract: 'T04 / §3.1',
    mutate: 'replace',
    target: 'episodes/002.md',
    replace: { find: 'status: confirmed', with: 'status: draft' },
    expected: '本版 status 必须为 confirmed',
    expect: { packageFingerprintChanges: true, validationFingerprintChanges: true, canonicalHashChanges: false },
  },
  {
    // Issue #96 交付 2 明确列了「角色引用缺失」，但契约 §7 只给「角色/场景」一个
    // PACKAGE_REFERENCE_UNKNOWN。B7 测角色侧、B9 测场景侧——同一错误码，引用来源不同，
    // 解析器若只校验一侧会漏掉另一侧，这条就是防那个的。
    id: 'B9',
    severity: 'error',
    code: CODE.REFERENCE_UNKNOWN,
    contract: 'T06 / §3.3',
    mutate: 'replace',
    target: 'episodes/001.md',
    replace: { find: '- S001', with: '- S999' },
    expected: '引用了 scenes.md 未声明的 S999；错误必须包含缺失 ID 本身',
    expect: { packageFingerprintChanges: true, validationFingerprintChanges: true, canonicalHashChanges: false },
    note: '与 B7 成对：B7 改 Scene Refs 里的 S001→S999（场景侧），B9 改 Character Refs 里的 C001→C999（角色侧）。Issue #96 列了「角色引用缺失」，契约 §7 却只给一个 PACKAGE_REFERENCE_UNKNOWN；解析器若只校验一侧引用清单就会漏掉另一侧。',
  },
  {
    id: 'B10',
    severity: 'error',
    code: CODE.EPISODE_INVALID,
    contract: '§3.3 / §7',
    mutate: 'replace-section',
    target: 'episodes/001.md',
    replaceSection: { heading: '## Content', with: '## Content\n' },
    expected: 'episodes/001.md 的 ## Content 正文为空；必须阻断并返回 PACKAGE_EPISODE_INVALID',
    expect: { packageFingerprintChanges: true, validationFingerprintChanges: true, canonicalHashChanges: true },
    note: '契约要求每个 episodes/NNN.md 的 ## Content 正文非空；这不是 drama-package.md 的 Drama Bible 内容质量警告。',
  },
  {
    id: 'B11',
    severity: 'error',
    code: CODE.ENCODING_INVALID,
    contract: '§3.2 / §7',
    mutate: 'utf16le',
    target: 'episodes/002.md',
    expected: '无 BOM 的 UTF-16LE 仍必须按非 UTF-8/二进制内容拒绝',
    expect: { rejectsRead: true },
    note: 'TextDecoder 的 fatal UTF-8 解码会接受包含 NUL 的 UTF-16LE 字节；实现必须先拒绝 NUL/binary 内容。',
  },

  // ─────────────────────────── 5 条警告 ───────────────────────────
  {
    id: 'W1',
    severity: 'warning',
    // 契约 §7 没有「可选文件缺失」的错误码：这是预期内情形，不得产出任何 error。
    // 用 null 显式标记，防止解析器把它误映射到 FILE_MISSING / FILE_UNEXPECTED。
    code: null,
    contract: 'T02 / §3.1',
    mutate: 'delete-and-clear-refs',
    target: 'characters.md',
    refPattern: /## Character Refs\n\n(?:- [^\n]+\n)+/g,
    expected: 'characters.md 为可选文件；缺省时 characters 数组为空，不得产生 error',
    expect: { packageFingerprintChanges: true, validationFingerprintChanges: true, canonicalHashChanges: false },
    note: '契约 §3.1 明确「没有人物时可省略」——若解析器报错即违反契约。',
  },
  {
    id: 'W2',
    severity: 'warning',
    code: null, // 同 W1：可选文件缺失是预期内情形，不得产出 error
    contract: 'T02 / §3.1',
    mutate: 'delete-and-clear-refs',
    target: 'scenes.md',
    refPattern: /## Scene Refs\n\n(?:- [^\n]+\n)+/g,
    expected: 'scenes.md 为可选文件；缺省时 scenes 数组为空',
    expect: { packageFingerprintChanges: true, validationFingerprintChanges: true, canonicalHashChanges: false },
  },
  {
    id: 'W3',
    severity: 'warning',
    // 未识别字段不是 front matter 结构错误，不应产出 PACKAGE_FRONTMATTER_INVALID（那是 error）。
    // 期望它作为 extension 记录并附 warning。
    code: null,
    contract: '§3.3 / §7',
    mutate: 'insert-after',
    target: 'drama-package.md',
    insertAfter: 'schema: jisu-production-package\n',
    text: 'custom_director: 某位导演\n',
    expected: '未识别 front matter 字段进入 extensions 并产生 warning；不得静默丢弃，也不得静默映射到数据库字段',
    expect: { packageFingerprintChanges: true, validationFingerprintChanges: true, canonicalHashChanges: false },
    note: '#96 预研中被主账号点名的两条之一：未知字段不可静默丢弃。断言要验证 extensions 里真的有该键。',
  },
  {
    id: 'W4',
    severity: 'warning',
    code: null, // Drama Bible 为空是内容质量问题，不是 episode Content 的结构错误；不得产出 error
    contract: '§3.3',
    mutate: 'replace-section',
    target: 'drama-package.md',
    replaceSection: { heading: '## Drama Bible', with: '## Drama Bible\n' },
    expected: 'Drama Bible 正文为空；warning 且不得阻断确认',
    expect: { packageFingerprintChanges: true, validationFingerprintChanges: true, canonicalHashChanges: false },
  },
  {
    id: 'W5',
    severity: 'warning',
    code: CODE.FILE_UNEXPECTED,
    contract: '§7 PACKAGE_FILE_UNEXPECTED',
    mutate: 'add-file',
    target: 'notes/extra.md',
    content: '# 手工批注\n\n这是导入者随手放的备注，契约未定义该路径。\n',
    expected: '未知文件先 warning；不阻断。仅二进制/路径穿越才升级为 error',
    expect: { packageFingerprintChanges: true, validationFingerprintChanges: true, canonicalHashChanges: false },
    note: '与 W3 区分：W3 是「已定义文件里的未知字段」，W5 是「未定义的路径」。两者前端提示位置不同。',
  },

  // ─────────────── confirm 阶段哈希比对（契约 §5.1 / T07a/T07b/T08b）───────────────
  {
    id: 'C1',
    severity: 'error',
    code: CODE.HASH_MISMATCH,
    contract: 'T07a / §5.1',
    mutate: 'replace',
    target: 'episodes/002.md',
    replace: {
      find: '那个年份是林渡出生的年份。',
      with: '那个年份是林渡出生的年份，而这一年灯行已经拆了。',
    },
    expected: '预览后修改任一非 manifest 文件再确认，返回 PACKAGE_HASH_MISMATCH，不进入幂等查询、不重放旧结果',
    expect: { packageFingerprintChanges: true, validationFingerprintChanges: true, canonicalHashChanges: true },
  },
  {
    id: 'C2',
    severity: 'error',
    code: CODE.HASH_MISMATCH,
    contract: 'T07b / T08b / §5.1',
    mutate: 'replace',
    target: 'source-manifest.md',
    replace: { find: 'reviewer_note: "原创虚构内容', with: 'reviewer_note: "补充：原创虚构内容' },
    expected: '只改 manifest（例如 reviewer_note）也必须返回 PACKAGE_HASH_MISMATCH，不得重放旧成功结果',
    expect: { packageFingerprintChanges: false, validationFingerprintChanges: true, canonicalHashChanges: false },
    note: '关键边界：manifest 被排除在 package_fingerprint 之外，所以 package_fingerprint 不变；只有 validation_fingerprint 变。Confirm 必须校验全部文件（含 manifest），否则此例会被静默接受。这也是 #95 补充实施裁决第 2 条要单独引入 validation_fingerprint 的原因。',
  },

  // ─────────────── confirm 阶段冲突与幂等（契约 §5.2 / §5.4）───────────────
  {
    // Issue #96 交付 2 点名项「导入更新冲突」。契约 §5.4 第 1 条明确 v0.1 只支持
    // 新建项目，因此「更新已有项目」不属于哈希问题，应返回 PACKAGE_TARGET_UNSUPPORTED。
    // 这与 C1/C2 的 PACKAGE_HASH_MISMATCH 是**不同错误码、不同判定阶段**：
    // C1/C2 在快照校验阶段失败，本条在 target_mode 校验阶段失败。
    //
    // 注意：这条是**语义期望登记**，不是字节变异。它没有任何文件改动，
    // 因此 expect 三项都为 false——包指纹与正例完全相同，冲突来自 Confirm 请求体，
    // 而不是包内容。解析器落地后应把本条改为断言 target_mode=update 时的返回值。
    id: 'C3',
    severity: 'error',
    code: CODE.TARGET_UNSUPPORTED,
    contract: '§5.4 / §7',
    mutate: 'replace',
    target: 'episodes/002.md',
    replace: {
      find: '那个年份是林渡出生的年份。',
      with: '那个年份是林渡出生的年份。',
    },
    expected: 'v0.1 只支持新建项目；confirm 携带 target_mode=update 必须返回 PACKAGE_TARGET_UNSUPPORTED，不得把导入降级为覆盖式更新',
    expect: { packageFingerprintChanges: false, validationFingerprintChanges: false, canonicalHashChanges: false },
    note: '字节无变化是刻意的：本条断言的是 Confirm 请求参数（target_mode），不是包内容。断言实现时不要只看文件 diff。',
  },
  {
    // Issue #96 交付 2 点名项「导入更新冲突」的另一半：同集号不同正文。
    // 契约 §5.4 第 2 条把「同集号不同正文」列为阻断冲突。这里的表现是
    // 预览快照与当前包不一致（用户改了内容但沿用同一集号），
    // 走 PACKAGE_CONFLICT 而不是 PACKAGE_HASH_MISMATCH——后者是「包在预览后变了」，
    // 前者是「包内部/跨预览的语义冲突」。
    //
    // 同样为**语义期望登记**：本 fixture 只有两集，无法制造「同集号不同正文」的
    // 第二份预览快照，因此字节层面复用正例、expect 三项都为 false。
    // 落地时应构造两次 Parse（同 episode_id 不同正文）再断言 PACKAGE_CONFLICT。
    id: 'C4',
    severity: 'error',
    code: CODE.CONFLICT,
    contract: '§5.4 / §7',
    mutate: 'replace',
    target: 'episodes/002.md',
    replace: {
      find: '那个年份是林渡出生的年份。',
      with: '那个年份是林渡出生的年份。',
    },
    expected: '同一 episode_id 出现不同正文属于阻断冲突，返回 PACKAGE_CONFLICT 并要求用户显式选择，不得静默取其中一份',
    expect: { packageFingerprintChanges: false, validationFingerprintChanges: false, canonicalHashChanges: false },
    note: '与 C3 同为字节无变化的语义登记。区分点：C3 是 target_mode 不支持，C4 是包内/跨预览语义冲突。',
  },
]

export const SAMPLES = { [POSITIVE_ID]: EXPECTED.positive }
