import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { Pool, PoolConnection } from 'mysql2/promise'
import { canonicalSourceFromPackage, type ProductionPackagePreview } from './production-package-parser.js'
import { extractProductionPackageUploadForConfirm, getProductionPackageSnapshotForConfirm, type ConfirmSnapshot } from './production-package-preview.js'

export type ConfirmImportInput = {
  token: string
  owner: string
  packageFingerprint: string
  validationFingerprint: string
  idempotencyKey: string
}

export class ProductionPackageImportError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400, readonly details?: unknown) { super(message) }
}

const insertId = (result: any) => Number((Array.isArray(result) ? result[0] : result)?.insertId)
const ts = () => new Date().toISOString()
const json = (value: unknown) => JSON.stringify(value ?? null)

export function validateProductionPackageImportInput(input: ConfirmImportInput) {
  // Preview tokens issued before the Confirm endpoint use a bare 192-bit
  // Base64URL value; parser-internal tokens use the newer pv_ prefix. Both
  // are opaque server-side references and must remain valid during upgrade.
  if (!/^(?:pv_)?[A-Za-z0-9_-]{24,128}$/.test(input.token)) throw new ProductionPackageImportError('PACKAGE_IMPORT_INVALID', 'preview_token 格式无效')
  if (!/^sha256:[0-9a-f]{64}$/.test(input.packageFingerprint) || !/^sha256:[0-9a-f]{64}$/.test(input.validationFingerprint)) throw new ProductionPackageImportError('PACKAGE_IMPORT_INVALID', '指纹格式无效')
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.idempotencyKey)) throw new ProductionPackageImportError('PACKAGE_IMPORT_INVALID', 'idempotency_key 格式无效')
}

async function existingImport(pool: Pool, owner: string, key: string, packageFingerprint: string, validationFingerprint: string) {
  const [rows] = await pool.query<any[]>('SELECT * FROM production_package_imports WHERE idempotency_owner = ? AND idempotency_key = ? LIMIT 1', [owner, key])
  const row = rows[0]
  if (!row) return undefined
  if (String(row.package_fingerprint) !== packageFingerprint || String(row.validation_fingerprint) !== validationFingerprint) throw new ProductionPackageImportError('PACKAGE_IMPORT_IDEMPOTENCY_CONFLICT', '同一个幂等 key 不能用于另一份生产包', 409)
  if (row.status === 'completed') return { status: 'completed', drama_id: Number(row.drama_id), import_id: Number(row.id), replayed: true }
  if (row.status === 'processing') throw new ProductionPackageImportError('PACKAGE_IMPORT_IN_PROGRESS', '该导入正在处理中，请稍后重试', 409)
  return { status: 'failed', import_id: Number(row.id), error: row.error_json ? JSON.parse(String(row.error_json)) : null, replayed: true }
}

/** MySQL 唯一键冲突：表示已有请求持有该幂等键的 claim。 */
function isDuplicateKeyError(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'ER_DUP_ENTRY'
}

function text(value: unknown) { return typeof value === 'string' ? value.trim() : '' }

async function writeImport(connection: PoolConnection, snapshot: ConfirmSnapshot, parsed: ProductionPackagePreview, importId: number) {
  const createdAt = ts()
  const project = parsed.project
  const dramaResult = await connection.execute(
    `INSERT INTO dramas (title, description, genre, style, aspect_ratio, total_episodes, status, metadata, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`,
    [text(project.title) || '未命名项目', text(project.bible_summary), text(project.genre), text(project.style) || '3d', text(project.aspect_ratio) || '16:9', parsed.episodes.length, json({ production_package: { package_id: parsed.package.package_id, package_version: parsed.package.package_version, import_id: importId, source: parsed.source } }), createdAt, createdAt],
  )
  const dramaId = insertId(dramaResult)
  const canonical = canonicalSourceFromPackage(snapshot.root)
  const episodeContents = new Map<number, string>()
  for (const ep of parsed.episodes) {
    const episodeNumber = String(Number((ep as any).episode_number)).padStart(3, '0')
    const file = fs.readFileSync(path.join(snapshot.root, 'episodes', `${episodeNumber}.md`), 'utf8')
    const match = /^## Content\s*$([\s\S]*?)(?=^##\s+|$)/m.exec(file)
    episodeContents.set(Number((ep as any).episode_number), (match?.[1] || '').trimEnd())
  }
  const sourceHash = crypto.createHash('sha256').update(canonical).digest('hex')
  const sourceResult = await connection.execute(
    `INSERT INTO source_versions (drama_id, base_kind, content, content_hash, base_hash, parent_version_id, diff, stats, created_at, updated_at)
     VALUES (?, 'source', ?, ?, ?, NULL, ?, ?, ?, ?)`,
    [dramaId, canonical, sourceHash, sourceHash, json({}), json({ character_count: parsed.characters.length, scene_count: parsed.scenes.length, episode_count: parsed.episodes.length }), createdAt, createdAt],
  )
  const sourceVersionId = insertId(sourceResult)
  await connection.execute('UPDATE dramas SET current_source_version_id = ? WHERE id = ?', [sourceVersionId, dramaId])
  const chars = new Map<string, number>()
  for (const item of parsed.characters) {
    const result = await connection.execute(
      `INSERT INTO characters (drama_id, name, role, description, appearance, personality, styling, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [dramaId, text(item.name) || '未命名人物', text(item.role), text(item.description), text(item.appearance), text(item.personality), text(item.styling), chars.size, createdAt, createdAt],
    )
    chars.set(String(item.external_id), insertId(result))
  }
  const scenes = new Map<string, number>()
  for (const item of parsed.scenes) {
    const result = await connection.execute(
      `INSERT INTO scenes (drama_id, location, time, prompt, lighting, storyboard_count, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 'pending', ?, ?)`,
      [dramaId, text(item.location) || '未命名场景', text(item.time), text(item.prompt) || text(item.description) || text(item.location), text(item.lighting), createdAt, createdAt],
    )
    scenes.set(String(item.external_id), insertId(result))
  }
  for (const ep of parsed.episodes) {
    const e = ep as any
    const result = await connection.execute(
      `INSERT INTO episodes (drama_id, episode_number, title, content, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'draft', ?, ?)`,
      [dramaId, Number(e.episode_number), text(e.title) || `第${e.episode_number}集`, episodeContents.get(Number(e.episode_number)) || '', '', createdAt, createdAt],
    )
    const episodeId = insertId(result)
    for (const ref of Array.isArray(e.character_refs) ? e.character_refs : []) {
      const characterId = chars.get(String(ref)); if (characterId) await connection.execute('INSERT INTO episode_characters (episode_id, character_id, created_at) VALUES (?, ?, ?)', [episodeId, characterId, createdAt])
    }
    for (const ref of Array.isArray(e.scene_refs) ? e.scene_refs : []) {
      const sceneId = scenes.get(String(ref)); if (sceneId) { await connection.execute('UPDATE scenes SET episode_id = ? WHERE id = ?', [episodeId, sceneId]); await connection.execute('INSERT INTO episode_scenes (episode_id, scene_id, created_at) VALUES (?, ?, ?)', [episodeId, sceneId, createdAt]) }
    }
  }
  return dramaId
}

export async function confirmProductionPackageImport(input: ConfirmImportInput) {
  validateProductionPackageImportInput(input)
  // Do not connect to MySQL merely because the preview router module was
  // imported. Confirm is the only operation in this module that needs it.
  const { pool } = await import('../db/index.js')
  const prior = await existingImport(pool, input.owner, input.idempotencyKey, input.packageFingerprint, input.validationFingerprint)
  if (prior) return prior
  const snapshot = await getProductionPackageSnapshotForConfirm(input.token, input.owner, { packageFingerprint: input.packageFingerprint, validationFingerprint: input.validationFingerprint })
  const bytes = snapshot.uploadBytes
  let importId = 0
  let ownsReservation = false
  let reservationCommitted = false
  const reservation = await pool.getConnection()
  try {
    await reservation.beginTransaction()
    let row: any
    try {
      const [insertResult] = await reservation.execute(
        `INSERT INTO production_package_imports (idempotency_owner, idempotency_key, preview_token, package_fingerprint, validation_fingerprint, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'processing', ?, ?)`,
        [input.owner, input.idempotencyKey, input.token, input.packageFingerprint, input.validationFingerprint, ts(), ts()],
      )
      // 原子 claim：INSERT 成功即本请求是唯一 owner。
      // 不再依赖 ON DUPLICATE KEY UPDATE 的 affectedRows === 1 —— Issue #108 实证该判定
      // 在并发下不可靠（多个请求拿到同一 import_id 却各自写入业务数据）。
      ownsReservation = true
      importId = Number((insertResult as any)?.insertId)
      const [rows] = await reservation.query<any[]>('SELECT * FROM production_package_imports WHERE id = ?', [importId])
      row = rows[0]
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error
      // 未取得 claim：只回放既有记录，**绝不进入 writeImport**。
      // 只读且不加行锁：claim 的原子性由上面的 INSERT 保证，这里加锁只会造成锁竞争/死锁。
      const [rows] = await reservation.query<any[]>('SELECT * FROM production_package_imports WHERE idempotency_owner = ? AND idempotency_key = ? LIMIT 1', [input.owner, input.idempotencyKey])
      row = rows[0]
      if (!row) throw new ProductionPackageImportError('PACKAGE_IMPORT_FAILED', '无法读取导入幂等记录', 500)
      importId = Number(row.id)
      if (String(row.package_fingerprint) !== input.packageFingerprint || String(row.validation_fingerprint) !== input.validationFingerprint) {
        await reservation.commit()
        throw new ProductionPackageImportError('PACKAGE_IMPORT_IDEMPOTENCY_CONFLICT', '同一个幂等 key 不能用于另一份生产包', 409)
      }
      if (row.status === 'processing') { await reservation.commit(); throw new ProductionPackageImportError('PACKAGE_IMPORT_IN_PROGRESS', '该导入正在处理中，请稍后重试', 409) }
      if (row.status === 'completed') { await reservation.commit(); return { status: 'completed', drama_id: Number(row.drama_id), import_id: importId, replayed: true } }
      await reservation.commit()
      return { status: 'failed', import_id: importId, error: row.error_json ? JSON.parse(String(row.error_json)) : null, replayed: true }
    }
    if (!row) throw new ProductionPackageImportError('PACKAGE_IMPORT_FAILED', '无法创建导入幂等记录', 500)
    importId = Number(row.id)
    // A connection loss while COMMIT is in flight is ambiguous: MySQL may
    // already have persisted the processing row. Mark the reservation as
    // eligible for the best-effort failed transition before sending COMMIT so
    // that this case cannot strand the idempotency key in processing forever.
    reservationCommitted = true
    await reservation.commit()
    const reparsed = await extractProductionPackageUploadForConfirm(bytes)
    try {
      const parsed = reparsed.preview
      if (!parsed.can_confirm || parsed.package.package_fingerprint !== input.packageFingerprint || parsed.package.validation_fingerprint !== input.validationFingerprint) throw new ProductionPackageImportError('PACKAGE_SNAPSHOT_MISMATCH', '生产包重新校验未通过，请重新预览', 409, parsed.diagnostics)
      const connection = await pool.getConnection()
      try {
        await connection.beginTransaction()
        const dramaId = await writeImport(connection, { ...snapshot, root: reparsed.packageRoot }, parsed, importId)
        await connection.execute('UPDATE production_package_imports SET status = \'completed\', drama_id = ?, updated_at = ? WHERE id = ?', [dramaId, ts(), importId])
        await connection.commit()
        return { status: 'completed', drama_id: dramaId, import_id: importId, replayed: false }
      } catch (error) {
        await connection.rollback().catch(() => {})
        throw error
      } finally { connection.release() }
    } finally { reparsed.cleanup() }
  } catch (error) {
    await reservation.rollback().catch(() => {})
    const diagnostic = { code: error instanceof ProductionPackageImportError ? error.code : 'PACKAGE_IMPORT_FAILED', message: error instanceof Error ? error.message : '导入失败' }
    if (importId && ownsReservation && reservationCommitted) await pool.query('UPDATE production_package_imports SET status = \'failed\', error_json = ?, updated_at = ? WHERE id = ?', [json(diagnostic), ts(), importId]).catch(() => {})
    throw error instanceof ProductionPackageImportError ? error : new ProductionPackageImportError('PACKAGE_IMPORT_FAILED', '导入失败，请稍后重试', 500, diagnostic)
  } finally { reservation.release() }
}
