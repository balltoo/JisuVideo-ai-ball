export interface EpisodeOutlineItem {
  title?: string
  summary?: string
}

/**
 * 剥掉模型自带在标题前的「第N集：」前缀。
 *
 * 前端分集卡片左侧已单独渲染 `EP 0N`，标题再带前缀会显示成「EP 01 · 第1集：沉默的周一」。
 * 仅在「序号 + 集次量词 + 分隔符 + 正文」四部分齐全时剥离（如 `第1集：沉默的周一`、`第1集 沉默的周一`）；
 * 整条标题就是前缀（如 `第1集`）、或前缀后直接接正文（如 `第三集的反转`）时保持原样，
 * 避免把正常标题误伤成空串或断句。
 */
export function stripEpisodeNumberPrefix(title: string): string {
  const trimmed = String(title ?? '').trim()
  const matched = trimmed.match(
    /^第\s*[0-9０-９一二三四五六七八九十百千两]+\s*[集话回](?:\s*[：:、.．·\-—]\s*|\s+)([\s\S]+)$/,
  )
  if (!matched) return trimmed
  return matched[1].trim() || trimmed
}

function naturalBoundaries(text: string) {
  const result = new Set<number>()
  const pattern = /[。！？!?](?:[”’」』])?|\r?\n\s*\r?\n/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) result.add(match.index + match[0].length)
  return [...result].filter(value => value > 0 && value < text.length).sort((a, b) => a - b)
}

/**
 * 顺序、无遗漏地按自然段/句子将全文切成指定数量的初稿。
 * AI 只负责集数、标题和摘要，正文始终来自用户原文，避免模型改写或漏字。
 */
export function splitSourceIntoEpisodes(content: string, requestedCount: number, outlines: EpisodeOutlineItem[] = []) {
  const normalized = content.trim()
  if (!normalized) return []
  const safeRequested = Math.max(1, Math.min(50, Math.round(requestedCount || 1)))
  const count = Math.min(safeRequested, normalized.length)
  const candidates = naturalBoundaries(normalized)
  const boundaries = [0]
  for (let index = 1; index < count; index += 1) {
    const target = Math.round((normalized.length * index) / count)
    const minimum = boundaries[index - 1] + 1
    const maximum = normalized.length - (count - index)
    const valid = candidates.filter(value => value >= minimum && value <= maximum)
    let boundary = Math.max(minimum, Math.min(maximum, target))
    if (valid.length) {
      boundary = valid.reduce((best, value) => Math.abs(value - target) < Math.abs(best - target) ? value : best, valid[0])
    }
    boundaries.push(boundary)
  }
  boundaries.push(normalized.length)
  const chunks = boundaries.slice(0, -1).map((start, index) => normalized.slice(start, boundaries[index + 1]))

  return chunks.filter(Boolean).map((chunk, index) => ({
    episode_number: index + 1,
    title: stripEpisodeNumberPrefix(String(outlines[index]?.title || `第${index + 1}集`)),
    summary: String(outlines[index]?.summary || '').trim(),
    content: chunk,
    character_count: chunk.length,
  }))
}

/**
 * 兜底集数估算：仅在 AI 未能给出集数、且用户未指定集数时使用。
 *
 * 取竖屏短剧的常见节奏——单集 1-3 分钟，对应约 800-1200 中文字符，中位取 1000。
 * （原值按每集 2500-4500 字的长视频假设取 3500，2635 字原文只能算出 1 集，与短剧实际相差约 10 倍。）
 * 参照实测：2635 字原文最终选定 3 集，其中一集 886 字对应约 114 秒成片。
 */
export function defaultEpisodeCount(contentLength: number) {
  return Math.max(1, Math.min(30, Math.round(contentLength / 1000) || 1))
}
