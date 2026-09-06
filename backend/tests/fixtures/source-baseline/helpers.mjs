/**
 * Issue #80 / S1 baseline 复用骨架：样本读取 / 哈希口径 / 段落切分 / 汇总工具
 *
 * 供 #72（健康检查）/#73（clean 校验）/#75（分集一致性）直接 import 复用。
 * 约定：
 * - 本目录为纯文件 fixtures：不 import 任何 ../src/**（避免连带 DB / tsx），hash 口径自实现，
 *   与契约 I1 等价（sha256(String(content||'').trim())），见 source-versions.ts sourceVersionContentHash。
 * - 字符数按 JS String.length（UTF-16 code unit）计，中文每字 = 1。
 * - 样本文件字节规范：UTF-8 无 BOM、LF（已由 .gitattributes -text 固定），fileSha256 以该规范字节为准。
 */
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

export const BASE_DIR = dirname(fileURLToPath(import.meta.url))

export const SAMPLE_FILES = {
  's01-clean-short': 'sample-01-clean-short.txt',
  's02-noise-webnovel': 'sample-02-noise-webnovel.txt',
  's03-long-form': 'sample-03-long-form.txt',
}

export const GROUND_TRUTH_FILES = {
  's02-noise-webnovel': 'ground-truth-sample-02.json',
  's03-long-form': 'ground-truth-sample-03.json',
}

/** 段落 kind 允许集（与生成器 scripts/generate-samples.mjs 头部注释一致） */
export const PARAGRAPH_KINDS = new Set([
  'heading',
  'body',
  'body-dup',
  'intro-hand',
  'watermark',
  'author-note',
  'ad',
  'garbage',
  'duplicate',
])

export const pathOf = (rel) => join(BASE_DIR, rel)
export const readUtf8 = (rel) => readFileSync(pathOf(rel), 'utf8')

/** 原始文件 sha256（UTF-8 字节，规范化 LF；等价 fileSha256 口径） */
export function fileSha256Of(text) {
  return createHash('sha256').update(Buffer.from(String(text ?? ''), 'utf8')).digest('hex')
}

/** content_hash（契约 §6.1 I1 口径）：sha256(String(content||'').trim()) */
export function contentHashOf(text) {
  return createHash('sha256').update(String(text ?? '').trim(), 'utf8').digest('hex')
}

/** 契约规范化输入（I9）：String(content).trim()。只去首尾整体空白，不改段间空白 */
export function normalizeContent(raw) {
  return String(raw ?? '').trim()
}

/**
 * 段落切分：规范化文本按一个或多个空行（\n\n+）切段并剔除空段。
 * 适用于本 fixtures（段内不含换行、段落间恰以空行分隔），与 ground-truth 的 para 一一对应。
 * 正式锚点服务（#73）实现后，以契约为准。
 */
export function splitParagraphs(raw) {
  return normalizeContent(raw)
    .split(/\n\n+/)
    .filter((s) => s.length > 0)
}

/** 加载样本原始文件（readFileSync，一次调用） */
export function loadSampleRaw(sampleId) {
  const rel = SAMPLE_FILES[sampleId]
  if (!rel) throw new Error(`unknown sample id: ${sampleId}`)
  return readUtf8(rel)
}

/** 加载 ground-truth（s01 无 ground-truth，返回 null） */
export function loadGroundTruth(sampleId) {
  const rel = GROUND_TRUTH_FILES[sampleId]
  if (!rel) return null
  return JSON.parse(readUtf8(rel))
}

/** 从样本文件实时解析段落（返回 [{ index, text }]），不依赖 ground-truth */
export function paragraphize(sampleId) {
  return splitParagraphs(loadSampleRaw(sampleId)).map((text, index) => ({ index, text }))
}

/** 章节标题规则（fixtures 基线自检用，全行匹配；正式实现以 #73 契约为准） */
export const CHAPTER_HEADING_RE =
  /^\s*(?:第[0-9一二三四五六七八九十百千零两]+[章回节卷部篇]|序章|楔子|引子|尾声|终章|番外|后记)(?:\s+[^\n]{0,40})?\s*$/

export function isChapterHeadingLine(line) {
  return CHAPTER_HEADING_RE.test(String(line ?? ''))
}

/**
 * 汇总 ground-truth：噪声分类计数 / 重复段分组 / 章节标题出现。
 * paras 每项 { index, kind, text }。
 */
export function summarizeGroundTruth(paras) {
  const kindCounts = {}
  for (const p of paras) kindCounts[p.kind] = (kindCounts[p.kind] ?? 0) + 1

  // 完全同文段聚合（逐字符相等 → 重复内容组，含位置列表）。
  // heading 重复单独走 headingRepeats，不混入正文同文组。
  const byText = new Map()
  for (const p of paras) {
    if (p.kind === 'heading') continue
    if (!byText.has(p.text)) byText.set(p.text, [])
    byText.get(p.text).push(p)
  }
  const textReuseGroups = [...byText.entries()]
    .filter(([, occ]) => occ.length > 1)
    .map(([text, occ]) => ({
      text,
      count: occ.length,
      indices: occ.map((p) => p.index),
      kinds: [...new Set(occ.map((p) => p.kind))],
    }))
    .sort((a, b) => a.indices[0] - b.indices[0])

  const headings = paras.filter((p) => p.kind === 'heading').map((p) => ({ index: p.index, text: p.text }))

  // 同名标题分组（相同标题文本出现 >= 2 次的清单，供"同章名去重按上下文"基线）
  const titleByText = new Map()
  for (const h of headings) {
    if (!titleByText.has(h.text)) titleByText.set(h.text, [])
    titleByText.get(h.text).push(h.index)
  }
  const headingRepeats = [...titleByText.entries()]
    .filter(([, idx]) => idx.length > 1)
    .map(([text, indices]) => ({ text, indices }))

  return { kindCounts, textReuseGroups, headingRepeats, headings }
}

/** s01 无 ground-truth：按 kind 全量视为 body 的段落视图 */
export function summarizePlain(sampleId) {
  return paragraphize(sampleId).map((p) => ({ index: p.index, kind: 'body', text: p.text }))
}
