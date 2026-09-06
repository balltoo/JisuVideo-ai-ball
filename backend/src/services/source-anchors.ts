/**
 * 原文段落锚点服务（Issue #73）。
 *
 * 锚点从某个不可变 source_versions 行的 canonical content 推导；坐标永远只对
 * 该 version_id 有效。不同版本绝不复用旧坐标，同文重复段以 occurrence 区分。
 */
import { createHash } from 'node:crypto'
import type { Pool, PoolConnection } from 'mysql2/promise'
import { pool } from '../db/index.js'

export interface SourceAnchor {
  dramaId: number
  versionId: number
  paraId: string
  anchorText: string
  hash: string
  start: number
  end: number
  sortOrder: number
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

/**
 * 以非空行作为最小稳定段落，保留 UTF-16 [start,end) 坐标；相邻短行仍是独立
 * 可审阅单元，避免“自动合并”让用户无法回指原文。章节标题同样保留为结构锚点。
 */
export function buildSourceAnchors(dramaId: number, versionId: number, rawContent: unknown): SourceAnchor[] {
  const content = String(rawContent ?? '').trim()
  const occurrences = new Map<string, number>()
  const anchors: SourceAnchor[] = []
  const lines = /[^\r\n]+/g
  let match: RegExpExecArray | null
  while ((match = lines.exec(content)) !== null) {
    const text = match[0]
    if (!text.trim()) continue
    const hash = sha256(text)
    const occurrence = (occurrences.get(hash) || 0) + 1
    occurrences.set(hash, occurrence)
    anchors.push({
      dramaId,
      versionId,
      paraId: `PARA-${hash.slice(0, 8)}:${occurrence}`,
      anchorText: text.trim().slice(0, 12),
      hash,
      start: match.index,
      end: match.index + text.length,
      sortOrder: anchors.length,
    })
  }
  return anchors
}

function sameAnchors(rows: any[], expected: SourceAnchor[]): boolean {
  return rows.length === expected.length && rows.every((row, index) => {
    const item = expected[index]
    return Number(row.drama_id) === item.dramaId
      && Number(row.version_id) === item.versionId
      && row.para_id === item.paraId
      && row.anchor_text === item.anchorText
      && row.hash === item.hash
      && Number(row.start) === item.start
      && Number(row.end) === item.end
      && Number(row.sort_order) === item.sortOrder
  })
}

/**
 * 按 drama/version 范围验证后幂等写入。已有内容完全一致时不写；内容不一致时
 * 仅替换该版本的派生锚点，绝不触碰 source_versions 正文行。
 */
export async function ensureSourceAnchors(
  dramaId: number,
  versionId: number,
  connectionPool: Pool = pool,
): Promise<SourceAnchor[]> {
  const conn = await connectionPool.getConnection()
  try {
    await conn.beginTransaction()
    try {
      const anchors = await ensureSourceAnchorsInTransaction(conn, dramaId, versionId)
      await conn.commit()
      return anchors
    } catch (error) {
      await conn.rollback()
      throw error
    }
  } finally {
    conn.release()
  }
}

/** 供原文整理完成事务复用，保证 cleaned 版本与其锚点同时提交。 */
export async function ensureSourceAnchorsInTransaction(
  conn: PoolConnection,
  dramaId: number,
  versionId: number,
): Promise<SourceAnchor[]> {
  const [versions] = await conn.query<any[]>(
    'SELECT id, content FROM source_versions WHERE id = ? AND drama_id = ?',
    [versionId, dramaId],
  )
  const version = versions[0]
  if (!version) throw new Error('原文版本不存在或不属于当前项目')
  const expected = buildSourceAnchors(dramaId, versionId, version.content)
  const [existing] = await conn.query<any[]>(
    'SELECT drama_id, version_id, para_id, anchor_text, hash, start, end, sort_order FROM source_anchors WHERE drama_id = ? AND version_id = ? ORDER BY sort_order, id FOR UPDATE',
    [dramaId, versionId],
  )
  if (sameAnchors(existing, expected)) return expected
  await conn.execute('DELETE FROM source_anchors WHERE drama_id = ? AND version_id = ?', [dramaId, versionId])
  for (const anchor of expected) {
    await conn.execute(
      `INSERT INTO source_anchors (drama_id, version_id, para_id, anchor_text, hash, start, end, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [anchor.dramaId, anchor.versionId, anchor.paraId, anchor.anchorText, anchor.hash, anchor.start, anchor.end, anchor.sortOrder],
    )
  }
  return expected
}

/** 按需取得锚点：首次读取会构建，避免给所有旧项目做批量回填。 */
export async function getSourceAnchors(dramaId: number, versionId: number): Promise<SourceAnchor[]> {
  return ensureSourceAnchors(dramaId, versionId)
}
