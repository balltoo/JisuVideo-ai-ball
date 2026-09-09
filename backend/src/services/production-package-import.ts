import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { PoolConnection } from 'mysql2/promise'
import { pool } from '../db/index.js'
import { parseProductionPackage, type ProductionPackagePreview } from './production-package-parser.js'
import { getProductionPackageSnapshotForConfirm, type ConfirmSnapshot, ProductionPackagePreviewError } from './production-package-preview.js'

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

function validateInput(input: ConfirmImportInput) {
  if (!/^pv_[A-Za-z0-9_-]{8,128}$/.test(input.token)) throw new ProductionPackageImportError('PACKAGE_IMPORT_INVALID', 'preview_token 格式无效')
  if (!/^sha256:[0-9a-f]{64}$/.test(input.packageFingerprint) || !/^sha256:[0-9a-f]{64}$/.test(input.validationFingerprint)) throw new ProductionPackageImportError('PACKAGE_IMPORT_INVALID', '指纹格式无效')
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.idempotencyKey)) throw new ProductionPackageImportError('PACKAGE_IMPORT_INVALID', 'idempotency_key 格式无效')
}

async function existingImport(owner: string, key: string, packageFingerprint: string, validationFingerprint: string) {
  const [rows] = await pool.query<any[]>('SELECT * FROM production_package_imports WHERE idempotency_owner = ? AND idempotency_key = ? LIMIT 1', [owner, key])
  const row = rows[0]
  if (!row) return undefined
  if (String(row.package_fingerprint) !== packageFingerprint || String(row.validation_fingerprint) !== validationFingerprint) throw new ProductionPackageImportError('PACKAGE_IMPORT_IDEMPOTENCY_CONFLICT', '同一个幂等 key 不能用于另一份生产包', 409)
  if (row.status === 'completed') return { status: 'completed', drama_id: Number(row.drama_id), import_id: Number(row.id), replayed: true }
  if (row.status === 'processing') throw new ProductionPackageImportError('PACKAGE_IMPORT_IN_PROGRESS', '该导入正在处理中，请稍后重试', 409)
  return { status: 'failed', import_id: Number(row.id), error: row.error_json ? JSON.parse(String(row.error_json)) : null, replayed: true }
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
  const episodeContents = new Map<number, string>()
  const canonical = parsed.episodes.map(ep => {
    const episodeNumber = String(Number((ep as any).episode_number)).padStart(3, '0')
    const file = fs.readFileSync(path.join(snapshot.root, 'episodes', `${episodeNumber}.md`), 'utf8')
    const match = /^## Content\s*$([\s\S]*?)(?=^##\s+|$)/m.exec(file)
    const content = (match?.[1] || '').trimEnd()
    episodeContents.set(Number((ep as any).episode_number), content)
    return content
  }).filter(Boolean).join('\n\n')
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
  validateInput(input)
  const prior = await existingImport(input.owner, input.idempotencyKey, input.packageFingerprint, input.validationFingerprint)
  if (prior) return prior
  const snapshot = await getProductionPackageSnapshotForConfirm(input.token, input.owner, { packageFingerprint: input.packageFingerprint, validationFingerprint: input.validationFingerprint })
  const bytes = fs.readFileSync(snapshot.uploadPath)
  const connection = await pool.getConnection()
  let importId = 0
  try {
    await connection.beginTransaction()
    const [insertResult] = await connection.execute(
      `INSERT INTO production_package_imports (idempotency_owner, idempotency_key, preview_token, package_fingerprint, validation_fingerprint, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'processing', ?, ?) ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
      [input.owner, input.idempotencyKey, input.token, input.packageFingerprint, input.validationFingerprint, ts(), ts()],
    )
    const [rows] = await connection.query<any[]>('SELECT * FROM production_package_imports WHERE id = LAST_INSERT_ID() FOR UPDATE')
    const row = rows[0]
    importId = Number(row.id)
    const insertedHere = Number((insertResult as any)?.affectedRows) === 1
    if (!insertedHere && row.status === 'processing') throw new ProductionPackageImportError('PACKAGE_IMPORT_IN_PROGRESS', '该导入正在处理中，请稍后重试', 409)
    if (row.status === 'completed') { await connection.commit(); return { status: 'completed', drama_id: Number(row.drama_id), import_id: importId, replayed: true } }
    if (row.status === 'failed') { await connection.commit(); return { status: 'failed', import_id: importId, error: row.error_json ? JSON.parse(String(row.error_json)) : null, replayed: true } }
    const parsed = parseProductionPackage(snapshot.root)
    if (!parsed.can_confirm || parsed.package.package_fingerprint !== input.packageFingerprint || parsed.package.validation_fingerprint !== input.validationFingerprint) throw new ProductionPackageImportError('PACKAGE_SNAPSHOT_MISMATCH', '生产包重新校验未通过，请重新预览', 409, parsed.diagnostics)
    const dramaId = await writeImport(connection, snapshot, parsed, importId)
    await connection.execute('UPDATE production_package_imports SET status = \'completed\', drama_id = ?, updated_at = ? WHERE id = ?', [dramaId, ts(), importId])
    await connection.commit()
    return { status: 'completed', drama_id: dramaId, import_id: importId, replayed: false }
  } catch (error) {
    await connection.rollback().catch(() => {})
    const diagnostic = { code: error instanceof ProductionPackageImportError ? error.code : 'PACKAGE_IMPORT_FAILED', message: error instanceof Error ? error.message : '导入失败' }
    if (importId) await pool.query('UPDATE production_package_imports SET status = \'failed\', error_json = ?, updated_at = ? WHERE id = ?', [json(diagnostic), ts(), importId]).catch(() => {})
    throw error instanceof ProductionPackageImportError ? error : new ProductionPackageImportError('PACKAGE_IMPORT_FAILED', '导入失败，请稍后重试', 500, diagnostic)
  } finally { connection.release() }
}
