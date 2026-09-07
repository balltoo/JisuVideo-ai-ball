/** Issue #79 第一批：正文版本读取、确认 cleaned、跳过整理。 */
import type { Pool } from 'mysql2/promise'
import { pool, getInsertId } from '../db/index.js'
import { ensureSourceAnchorsInTransaction } from './source-anchors.js'

const now = () => new Date().toISOString()
const parseJson = (raw: unknown) => { try { return raw ? JSON.parse(String(raw)) : null } catch { return null } }

export class SourceVersionOperationError extends Error {
  constructor(public readonly status: 400 | 404 | 409, message: string) { super(message) }
}

function versionPayload(row: any) {
  return {
    id: Number(row.id), kind: row.base_kind, parent_version_id: row.parent_version_id == null ? null : Number(row.parent_version_id),
    content: row.content, content_hash: row.content_hash, base_hash: row.base_hash,
    diff: parseJson(row.diff), stats: parseJson(row.stats), created_at: row.created_at, updated_at: row.updated_at,
  }
}

export async function listSourceVersions(dramaId: number, connectionPool: Pool = pool) {
  const [dramas] = await connectionPool.query<any[]>('SELECT id, current_source_version_id, source_skip_at, deleted_at FROM dramas WHERE id = ?', [dramaId])
  const drama = dramas[0]
  if (!drama || drama.deleted_at) throw new SourceVersionOperationError(404, '项目不存在')
  const [versions] = await connectionPool.query<any[]>('SELECT * FROM source_versions WHERE drama_id = ? ORDER BY id', [dramaId])
  const current = versions.find(row => Number(row.id) === Number(drama.current_source_version_id))
  return {
    current: current ? { id: Number(current.id), kind: current.base_kind, updated_at: current.updated_at } : null,
    skipped_at: drama.source_skip_at || null,
    versions: versions.map(versionPayload),
  }
}

function readExpected(raw: unknown): number | null {
  if (raw === null) return null
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) throw new SourceVersionOperationError(400, 'expected_current_version_id 必须是正整数或 null')
  return value
}

/** confirm 永远派生 confirmed 行，绝不修改 cleaned 行。 */
export async function confirmCleanedVersion(
  dramaId: number,
  targetVersionIdRaw: unknown,
  expectedCurrentVersionIdRaw: unknown,
  connectionPool: Pool = pool,
) {
  const targetVersionId = Number(targetVersionIdRaw)
  if (!Number.isInteger(targetVersionId) || targetVersionId <= 0) throw new SourceVersionOperationError(400, 'target_version_id 必须是合法正整数')
  const expected = readExpected(expectedCurrentVersionIdRaw)
  const conn = await connectionPool.getConnection()
  try {
    await conn.beginTransaction()
    try {
      const [dramas] = await conn.query<any[]>('SELECT id, current_source_version_id, deleted_at FROM dramas WHERE id = ? FOR UPDATE', [dramaId])
      const drama = dramas[0]
      if (!drama || drama.deleted_at) throw new SourceVersionOperationError(404, '项目不存在')
      if (expected !== null) {
        const [expectedRows] = await conn.query<any[]>('SELECT id FROM source_versions WHERE id = ? AND drama_id = ?', [expected, dramaId])
        if (!expectedRows[0]) throw new SourceVersionOperationError(400, 'expected_current_version_id 不属于当前项目')
      }
      const currentId = drama.current_source_version_id == null ? null : Number(drama.current_source_version_id)
      if (expected !== currentId) throw new SourceVersionOperationError(409, 'VERSION_CONFLICT：当前正文已变化，请刷新后重试')
      const [targets] = await conn.query<any[]>('SELECT * FROM source_versions WHERE id = ? AND drama_id = ?', [targetVersionId, dramaId])
      const target = targets[0]
      if (!target || target.base_kind !== 'cleaned') throw new SourceVersionOperationError(400, 'target_version_id 必须是当前项目的 cleaned 候选')
      if (Number(target.parent_version_id) !== currentId) throw new SourceVersionOperationError(409, 'VERSION_CONFLICT：该整理候选不基于当前正文')
      const [latest] = await conn.query<any[]>('SELECT id FROM source_versions WHERE drama_id = ? AND parent_version_id = ? AND base_kind = \'cleaned\' ORDER BY id DESC LIMIT 1', [dramaId, currentId])
      if (Number(latest[0]?.id) !== targetVersionId) throw new SourceVersionOperationError(409, 'VERSION_CONFLICT：只能确认同一基线下最新的整理候选')
      const ts = now()
      const insert = await conn.execute(
        `INSERT INTO source_versions (drama_id, base_kind, content, content_hash, base_hash, parent_version_id, diff, stats, created_at, updated_at)
         VALUES (?, 'confirmed', ?, ?, ?, ?, ?, ?, ?, ?)`,
        [dramaId, target.content, target.content_hash, target.content_hash, targetVersionId, JSON.stringify({ removals: [], removed_chars: 0 }), JSON.stringify({}), ts, ts],
      )
      const confirmedId = getInsertId(insert)
      await ensureSourceAnchorsInTransaction(conn, dramaId, confirmedId)
      await conn.execute('UPDATE dramas SET current_source_version_id = ?, source_skip_at = NULL, updated_at = ? WHERE id = ?', [confirmedId, ts, dramaId])
      const [rows] = await conn.query<any[]>('SELECT * FROM source_versions WHERE id = ?', [confirmedId])
      await conn.commit()
      return versionPayload(rows[0])
    } catch (error) { await conn.rollback(); throw error }
  } finally { conn.release() }
}

export async function skipSourceCleanup(dramaId: number, noteRaw?: unknown, connectionPool: Pool = pool) {
  const note = String(noteRaw ?? '').trim()
  if (note.length > 200) throw new SourceVersionOperationError(400, 'note 最多 200 字')
  const conn = await connectionPool.getConnection()
  try {
    await conn.beginTransaction()
    try {
      const [dramas] = await conn.query<any[]>('SELECT id, current_source_version_id, deleted_at FROM dramas WHERE id = ? FOR UPDATE', [dramaId])
      const drama = dramas[0]
      if (!drama || drama.deleted_at) throw new SourceVersionOperationError(404, '项目不存在')
      if (drama.current_source_version_id != null) {
        const [versions] = await conn.query<any[]>('SELECT base_kind FROM source_versions WHERE id = ? AND drama_id = ?', [drama.current_source_version_id, dramaId])
        if (!versions[0] || versions[0].base_kind !== 'source') throw new SourceVersionOperationError(400, '当前不是原文；如需跳过整理，请先切回 source 版本')
      }
      const ts = now()
      await conn.execute('UPDATE dramas SET source_skip_at = ?, updated_at = ? WHERE id = ?', [ts, ts, dramaId])
      await conn.commit()
      return { skipped: true, current: 'source', note: note || null }
    } catch (error) { await conn.rollback(); throw error }
  } finally { conn.release() }
}
