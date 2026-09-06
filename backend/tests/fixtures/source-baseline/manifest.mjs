/**
 * Issue #80 / S1 baseline 样本清单与人工预期（静态固化）
 *
 * 本文件是 fixtures 的唯一"静态真值"：hash / 字数 / 段落数 / 人工预期固定在此，
 * source-baseline.test.mjs 用文件实时值逐项断言，防止样本或生成器被无意改动。
 * 预期语义详见 README.md「人工预期」与对应 ground-truth JSON（机器可读）。
 *
 * 说明：
 * - fileSha256：UTF-8 无 BOM + LF 规范字节的 sha256（.gitattributes -text 固定，git 不做行尾转换）
 * - contentHash：契约 §6.1 I1 口径 sha256(String(raw).trim())，见 helpers.contentHashOf
 * - rawCharCount / normalizedCharCount：按 JS String.length 计（中文每字 = 1）
 * - paraCount：空行分隔段落数（normalized.split(/\n\n+/).filter(Boolean)）
 * - 所有样本原创 / 确定性合成，无第三方版权、无隐私、无密钥（详见 README「来源与权限」）
 */
export const MANIFEST_VERSION = '1.0.0'

export const SAMPLES = [
  {
    id: 's01-clean-short',
    contractSample: 'S1 干净短文（v0.4 §7.3）',
    contractCharTarget: '≤1 万字，段落规整',
    file: 'sample-01-clean-short.txt',
    fileSha256: '6c61b011e240ac535bb1d130364e58bcef33acffc1e18698cf7b673064a140cc',
    contentHash: '1febbc1680523c2d265e06a4404ef24c7c2af930a658d05bb6f7847de2b1f4f1',
    rawCharCount: 962,
    normalizedCharCount: 961,
    paraCount: 11,
    expected: {
      healthCheck: 'clean',
      noiseKinds: [],
      note: '原创短文，无章节标题之外的结构；无重复段、无水印/广告/作者话/垃圾行；首尾无多余空白（尾单换行）。',
    },
  },
  {
    id: 's02-noise-webnovel',
    contractSample: 'S2 噪声网文（v0.4 §7.3）',
    contractCharTarget: '2–5 万字',
    file: 'sample-02-noise-webnovel.txt',
    gtFile: 'ground-truth-sample-02.json',
    gtSha256: '39f7af17205998241603a04fd2129bc0462943b0c4010db18537a15a71a517ec',
    fileSha256: 'e09b53c5bc4138ef79f656f26a4f43107cfbfc268b3435e59b93abfb8ac5b840',
    contentHash: 'dbd044f64ee8a393c2c1b6304c678e035974a04ac62bb131fc20241b5028770f',
    rawCharCount: 31054,
    normalizedCharCount: 31045,
    paraCount: 199,
    expected: {
      healthCheck: 'issues',
      // 噪声种类计数（ground-truth kind，见 scripts/generate-samples.mjs 注释）
      kindCounts: {
        heading: 7,
        watermark: 2,
        'intro-hand': 3,
        body: 172,
        'body-dup': 2,
        'author-note': 3,
        duplicate: 6,
        ad: 2,
        garbage: 2,
      },
      // 相同章节标题（"标题去重须按上下文"样本）：块级重复标题 + 孤立同题标题行
      headingRepeats: [
        { text: '第2章 雨夜来客', indices: [45, 59], note: '块级重复：标题随正文块整体复制（第 60/61 段 = 第 46/47 段正文）' },
        { text: '第3章 灯塔旧事', indices: [92, 114], note: '孤立同题标题行：同章名二次出现、后续接不同正文' },
      ],
      // 完全同文段的出现位置（0-based 段落序，与 ground-truth 一致）；同一 label 内 text 逐字符相同
      textReuseGroups: [
        { label: 'DUP_C 连续×2 + 隔章再现', indices: [89, 90, 154] },
        { label: 'INTRO[2] 手写种子分离重复', indices: [4, 125] },
        { label: 'DUP_S 连续×2（尾声）', indices: [195, 196] },
        { label: '第2章首段 块级重复', indices: [46, 60] },
        { label: '第2章第二段 块级重复', indices: [47, 61] },
        { label: 'AU1 作者话隔章重复', indices: [58, 173] },
      ],
      // 首尾空白 / 行尾空白样本：开头 2 个空行、结尾「1 空行 + 纯空格行 + 1 空行」
      leadingBlanks: '\n\n',
      trailingBlanks: '\n\n   \n\n',
      note: '健康检查应为 issues；每类噪声段落在 ground-truth 有唯一定位；重复段语义规则（保留首次出现）由 #73 落地后按真实运行记录到台账。',
    },
  },
  {
    id: 's03-long-form',
    contractSample: 'S3 长篇（v0.4 §7.3）',
    contractCharTarget: '3–4 万字',
    file: 'sample-03-long-form.txt',
    gtFile: 'ground-truth-sample-03.json',
    gtSha256: '9724d0a9e20c83071830bec24664d63dfff5458666374abb32af421bae22c62b',
    fileSha256: '6b6a3c09338d421c3a19473a793996305158e0a43be6330bcd961f57ac5a1205',
    contentHash: '4afaad11b51009f96ff43157d234f507587abb552b295c822c77748c7474c25a',
    rawCharCount: 39517,
    normalizedCharCount: 39516,
    paraCount: 235,
    expected: {
      healthCheck: 'clean',
      noiseKinds: [],
      headingTitles: [
        '第1章 晨雾码头',
        '第2章 铁锚与藤壶',
        '第3章 涨潮之前',
        '第4章 半张海图',
        '第5章 雾中汽笛',
        '第6章 旧灯塔的灯',
        '尾声',
      ],
      bodyCount: 228,
      note: '长文基线：分段/进度/成本/中断恢复/边界降级用；无噪声；章节标题唯一且有序。',
    },
  },
]

/** 便捷查询 */
export const sampleById = (id) => {
  const s = SAMPLES.find((x) => x.id === id)
  if (!s) throw new Error(`unknown sample id: ${id}`)
  return s
}
