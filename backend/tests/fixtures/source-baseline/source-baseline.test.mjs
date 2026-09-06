/**
 * Issue #80 / S1 baseline：样本 ↔ manifest ↔ ground-truth 三方互证 + 确定性复现
 *
 * 覆盖：
 *  - 三个样本文件存在且与 manifest 的 hash / 字数 / 段落数逐项一致（内容被改动即失败）
 *  - ground-truth（s02/s03）段落与文件逐字符对应（按规范段 join 后 == normalized raw）
 *  - s01 干净样本：无重复段、无已知噪声碎片、段数与预期一致
 *  - s02 噪声样本：首尾空白形态、kind 计数、同名标题位置、完全同文重复组位置（人工预期全断言）
 *  - s03 长文：章节标题唯一有序、无重复段、kind 仅 heading/body
 *  - 确定性：重新运行 scripts/generate-samples.mjs 后 s02/s03 字节不变（hash 同 manifest）
 *
 * 运行：cd backend && npm test（本文件会被递归发现；也可单独跑：
 *   cd backend && node --import tsx/esm --test tests/fixtures/source-baseline/source-baseline.test.mjs）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  BASE_DIR,
  pathOf,
  readUtf8,
  fileSha256Of,
  contentHashOf,
  normalizeContent,
  splitParagraphs,
  loadGroundTruth,
  summarizeGroundTruth,
  isChapterHeadingLine,
} from './helpers.mjs'
import { SAMPLES, sampleById } from './manifest.mjs'

const run = (name, fn) => test(`[source-baseline] ${name}`, fn)

const knownNoiseFragments = [
  '本站声明：本文由雾港文学网',
  '雾港文学网 · 海量网文免费阅读',
  '【小广告】',
  '【推荐位】',
  '作者的话：',
  '??????',
]

// ─── 通用：manifest 与文件一致性 ───────────────────────────────────────
for (const sample of SAMPLES) {
  run(`${sample.id}：manifest 与文件一致（hash/字数/段落数）`, () => {
    const raw = readUtf8(sample.file)
    assert.ok(raw.length > 0, '文件不应为空')
    assert.equal(fileSha256Of(raw), sample.fileSha256, 'fileSha256 不符')
    assert.equal(contentHashOf(raw), sample.contentHash, 'contentHash 不符')
    assert.equal(raw.length, sample.rawCharCount, 'rawCharCount 不符')
    assert.equal(normalizeContent(raw).length, sample.normalizedCharCount, 'normalizedCharCount 不符')
    assert.equal(splitParagraphs(raw).length, sample.paraCount, 'paraCount 不符')
  })
}

// ─── ground-truth 与文件互证 ─────────────────────────────────────────────
for (const sample of SAMPLES.filter((s) => s.gtFile)) {
  run(`${sample.id}：ground-truth 与文件逐字符对应`, () => {
    const raw = readUtf8(sample.file)
    const gt = loadGroundTruth(sample.id)
    assert.ok(Array.isArray(gt), 'ground-truth 应为数组')
    assert.equal(gt.length, sample.paraCount, 'gt 段数与 manifest 不符')
    for (const p of gt) {
      assert.ok(p && typeof p.index === 'number' && typeof p.text === 'string', 'gt 元素结构不符')
      assert.equal(p.index, gt.indexOf(p), 'gt 顺序编号与数组位置不符')
    }
    // 按规范段拼接 == 规范化输入（契约 T2 基准）
    assert.equal(normalizeContent(raw), gt.map((p) => p.text).join('\n\n'), 'gt 拼接与文件不一致')
    // gt 文件字节与生成一致
    const gtBytes = readUtf8(sample.gtFile)
    if (sample.gtSha256) assert.equal(fileSha256Of(gtBytes), sample.gtSha256, 'gtSha256 不符')
  })
}

// ─── s01：干净短文人工预期 ──────────────────────────────────────────────
run('s01：干净短文（clean / 无噪声 / 无重复段）', () => {
  const sample = sampleById('s01-clean-short')
  const paras = splitParagraphs(readUtf8(sample.file))
  assert.equal(paras.length, sample.paraCount)
  assert.ok(paras[0].includes('雾港的灯塔'), '首段应为标题')
  assert.ok(new Set(paras).size === paras.length, 's01 不应存在完全相同的两段')
  for (const frag of knownNoiseFragments) {
    assert.ok(!paras.some((t) => t.includes(frag)), `s01 不应含噪声碎片: ${frag}`)
  }
  assert.ok(sample.expected.healthCheck === 'clean')
})

// ─── s02：噪声网文人工预期（位置全部来自 ground-truth，0-based）─────────
run('s02：首尾空白 / 行尾空白形态符合设计', () => {
  const raw = readUtf8('sample-02-noise-webnovel.txt')
  assert.ok(raw.startsWith('\n\n'), '开头应为 2 个空行')
  assert.ok(raw.endsWith('\n\n   \n\n'), '结尾应为 1 空行 + 纯空格行 + 1 空行')
  assert.notEqual(raw, normalizeContent(raw), '规范化后首尾空白应被去除')
})

run('s02：噪声 kind 计数与 ground-truth 一致', () => {
  const sample = sampleById('s02-noise-webnovel')
  const gt = loadGroundTruth('s02-noise-webnovel')
  const sum = summarizeGroundTruth(gt)
  assert.deepEqual(sum.kindCounts, sample.expected.kindCounts)
  assert.equal(sum.kindCounts.heading, 7)
  assert.equal(sum.kindCounts.body, 172)
  assert.equal(sum.kindCounts.duplicate, 6)
  assert.ok(sum.headingRepeats.length >= 2, '应有同名标题重复组')
})

run('s02：同名标题位置与人工预期一致', () => {
  const sample = sampleById('s02-noise-webnovel')
  const gt = loadGroundTruth('s02-noise-webnovel')
  const sum = summarizeGroundTruth(gt)
  for (const { text, indices, note } of sample.expected.headingRepeats) {
    const found = sum.headingRepeats.find((h) => h.text === text)
    assert.ok(found, `应有同名标题: ${text} (${note})`)
    assert.deepEqual(found.indices, indices, `标题 ${text} 位置与预期不符`)
  }
  // 第 2 章重复标题与正文块：59=45 标题同文、60=46 / 61=47 正文同文
  assert.equal(gt[59].text, gt[45].text)
  assert.equal(gt[60].text, gt[46].text)
  assert.equal(gt[61].text, gt[47].text)
  // 孤立同题标题：114 = 92 标题同文，但紧随内容不同（115 是正文而非标题）
  assert.equal(gt[114].text, gt[92].text)
  assert.equal(gt[115].kind, 'body')
})

run('s02：完全同文重复组（连续/分离/块级）位置与人工预期一致', () => {
  const sample = sampleById('s02-noise-webnovel')
  const gt = loadGroundTruth('s02-noise-webnovel')
  const sum = summarizeGroundTruth(gt)
  for (const { label, indices } of sample.expected.textReuseGroups) {
    const texts = indices.map((i) => gt[i].text)
    assert.ok(new Set(texts).size === 1, `组内应同文: ${label}`)
    // 该文本在整个样本中出现的总次数 == indices.length（不与其他段落意外撞文）
    const occAll = gt.filter((p) => p.text === texts[0]).map((p) => p.index)
    assert.deepEqual(occAll, indices, `同文文本出现位置应恰为 ${JSON.stringify(indices)}（${label}）`)
  }
  // 组数 == manifest 声明数（多余重复会被此断言拦下）
  assert.equal(sum.textReuseGroups.length, sample.expected.textReuseGroups.length)
})

// ─── s03：长文人工预期 ──────────────────────────────────────────────────
run('s03：长文（章节唯一有序 / 无重复段 / kind 仅 heading+body）', () => {
  const sample = sampleById('s03-long-form')
  const gt = loadGroundTruth('s03-long-form')
  const sum = summarizeGroundTruth(gt)
  assert.equal(gt.length, sample.paraCount)
  assert.deepEqual(sum.headingRepeats, [], '长文不应有同名标题重复')
  assert.equal(sum.textReuseGroups.length, 0, '长文不应有完全重复段')
  assert.ok(Object.keys(sum.kindCounts).every((k) => k === 'heading' || k === 'body'), '长文 kind 仅允许 heading/body')
  assert.equal(sum.kindCounts.heading, 7)
  assert.equal(sum.kindCounts.body, sample.expected.bodyCount)
  assert.deepEqual(
    gt.filter((p) => p.kind === 'heading').map((p) => p.text),
    sample.expected.headingTitles,
    '章节标题顺序不符',
  )
  // 章节标题行应符合 fixtures 标题规则（骨架自检）
  for (const h of gt.filter((p) => p.kind === 'heading')) {
    assert.ok(isChapterHeadingLine(h.text), `标题规则应匹配: ${h.text}`)
  }
})

// ─── 确定性：重跑生成器，字节不变 ───────────────────────────────────────
run('确定性：重跑生成器后 s02/s03 字节不变（同 manifest hash）', () => {
  const script = pathOf('scripts/generate-samples.mjs')
  const res = spawnSync(process.execPath, [script], { cwd: BASE_DIR, encoding: 'utf8' })
  assert.equal(res.status, 0, `生成器退出码非 0：\n${res.stderr}`)
  for (const id of ['s02-noise-webnovel', 's03-long-form']) {
    const sample = sampleById(id)
    const raw = readUtf8(sample.file)
    assert.equal(fileSha256Of(raw), sample.fileSha256, `${id} 重生成后 fileSha256 变化`)
    assert.equal(contentHashOf(raw), sample.contentHash, `${id} 重生成后 contentHash 变化`)
    assert.equal(splitParagraphs(raw).length, sample.paraCount, `${id} 重生成后 paraCount 变化`)
  }
  const gt = readUtf8('ground-truth-sample-02.json')
  assert.equal(fileSha256Of(gt), sampleById('s02-noise-webnovel').gtSha256, 's02 ground-truth 重生成后变化')
})
