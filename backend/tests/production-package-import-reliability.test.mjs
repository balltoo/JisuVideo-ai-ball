/**
 * Issue #108 / P0：生产包导入可靠性矩阵（服务层 + 真实 MySQL）
 *
 * 说明：本文件在**服务层**直连验证业务语义（便于对 DB 状态与注入点做精确控制）；
 * HTTP 层 Confirm 主链路与幂等重放见 production-package-import-e2e.test.mjs（健康目标版），
 * 修复回归见 production-package-import-fix.test.mjs。Issue #108 发现的两个 P0
 * （Confirm 恒 401 / 并发同 key 重复创建）已由 fix(#108) / PR #113 合入修复。
 *
 * 覆盖：
 *   R1 相同幂等键重放        R2 同 key 换包冲突        R3 并发确认
 *   R4 快照过期              R5 快照篡改              R6 Confirm 中途失败 → failed 收口 + 重试
 *   R7 数据清洁（成功/失败）  R8 Preview 租约与清理边界
 *
 * 环境（全部走环境变量，不写凭据/本机路径）：
 *   MYSQL_HOST/MYSQL_PORT/MYSQL_USER/MYSQL_PASSWORD/MYSQL_DATABASE 或 DATABASE_URL
 *   未配置 MySQL 时按仓库既有约定 skip（CI 提供 mysql:8.0 service）。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import yazl from 'yazl'
import { PassThrough } from 'node:stream'
import * as helpers from './fixtures/production-package/helpers.mjs'
import { prepareIsolatedMySql } from './fixtures/production-package/mysql-isolate.mjs'

process.env.NODE_ENV = 'test'
process.env.MYSQL_NO_INIT = '1'
const snapshotRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jisu-pp-rel-snapshot-'))
process.env.PREVIEW_SNAPSHOT_ROOT = snapshotRoot
process.env.PREVIEW_PACKAGE_SNAPSHOT_STORE = 'mysql'

const FIXTURE_PACKAGE = path.join(helpers.PACKAGES_DIR, 'fixture-rain-lantern')
const hasMySql = Boolean(process.env.MYSQL_HOST || process.env.DATABASE_URL)
const isolated = hasMySql ? await prepareIsolatedMySql('jisu_pp_rel') : null
const mysql = hasMySql ? (await import('mysql2/promise')).default : null
const poolOptions = process.env.DATABASE_URL
  ? { uri: process.env.DATABASE_URL }
  : { host: process.env.MYSQL_HOST, port: Number(process.env.MYSQL_PORT || 3306), user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD, database: process.env.MYSQL_DATABASE }
const pool = hasMySql ? mysql.createPool(poolOptions) : null

const {
  createProductionPackagePreview,
  getProductionPackageSnapshotForConfirm,
  cleanupExpiredProductionPackagePreviewsShared,
  cleanupOrphanedProductionPackagePreviewDirectories,
  PREVIEW_LIMITS,
} = await import('../src/services/production-package-preview.ts')
const { confirmProductionPackageImport } = await import('../src/services/production-package-import.ts')

const createdDramaIds = new Set()
const usedKeys = new Set()

function zipDirectory(root) {
  const archive = new yazl.ZipFile()
  const output = new PassThrough()
  const chunks = []
  output.on('data', chunk => chunks.push(chunk))
  const done = new Promise((resolve, reject) => { output.once('end', resolve); output.once('error', reject) })
  archive.outputStream.pipe(output)
  const walk = (dir, rel) => {
    for (const name of fs.readdirSync(path.join(dir, rel))) {
      const childRel = rel ? `${rel}/${name}` : name
      const abs = path.join(dir, childRel)
      if (fs.statSync(abs).isDirectory()) walk(dir, childRel)
      else archive.addBuffer(fs.readFileSync(abs), childRel)
    }
  }
  walk(root, '')
  archive.end()
  return done.then(() => Buffer.concat(chunks))
}

const newKey = (prefix) => { const key = `${prefix}-${crypto.randomUUID()}`; usedKeys.add(key); return key }
const owner = (userId) => JSON.stringify(['tenant-e2e', userId])

async function makePreview(userId, mutate) {
  const zip = mutate ? await zipDirectory(mutate(FIXTURE_PACKAGE)) : await zipDirectory(FIXTURE_PACKAGE)
  const preview = await createProductionPackagePreview({ zip, owner: owner(userId) })
  return { zip, preview }
}

async function counts(dramaId) {
  const q = async (sql, params) => (await pool.query(sql, params))[0][0].c
  return {
    episodes: await q('SELECT COUNT(*) AS c FROM episodes WHERE drama_id = ?', [dramaId]),
    characters: await q('SELECT COUNT(*) AS c FROM characters WHERE drama_id = ?', [dramaId]),
    scenes: await q('SELECT COUNT(*) AS c FROM scenes WHERE drama_id = ?', [dramaId]),
    sourceVersions: await q('SELECT COUNT(*) AS c FROM source_versions WHERE drama_id = ?', [dramaId]),
    episodeCharacters: await q('SELECT COUNT(*) AS c FROM episode_characters ec JOIN episodes e ON e.id = ec.episode_id WHERE e.drama_id = ?', [dramaId]),
  }
}

test('R1 相同幂等键重放：只创建一个项目，重放返回同一结果', async (t) => {
  if (!hasMySql) { t.skip('requires the CI MySQL service'); return }
  const userId = 'user-r1'
  const { preview } = await makePreview(userId)
  const key = newKey('e2e-r1')
  const first = await confirmProductionPackageImport({
    token: preview.preview_token, owner: owner(userId),
    packageFingerprint: preview.package.package_fingerprint,
    validationFingerprint: preview.package.validation_fingerprint,
    idempotencyKey: key,
  })
  const replay = await confirmProductionPackageImport({
    token: preview.preview_token, owner: owner(userId),
    packageFingerprint: preview.package.package_fingerprint,
    validationFingerprint: preview.package.validation_fingerprint,
    idempotencyKey: key,
  })
  const [importRows] = await pool.query('SELECT COUNT(*) AS c, MAX(drama_id) AS drama_id FROM production_package_imports WHERE idempotency_key = ?', [key])
  console.log('[R1]', JSON.stringify({ first: { status: first.status, dramaId: first.drama_id, replayed: first.replayed }, replay: { status: replay.status, dramaId: replay.drama_id, replayed: replay.replayed }, importRows: importRows[0].c, importDramaId: importRows[0].drama_id }))
  assert.equal(first.status, 'completed')
  assert.equal(first.replayed, false)
  assert.equal(replay.status, 'completed')
  assert.equal(replay.replayed, true)
  assert.equal(replay.drama_id, first.drama_id, '重放必须返回同一项目')
  assert.equal(importRows[0].c, 1, '同一幂等键只能有一行导入记录')
  assert.equal(Number(importRows[0].drama_id), first.drama_id, '导入记录应指向同一唯一项目')
  createdDramaIds.add(first.drama_id)
})

test('R2 相同 key 换包冲突：409 PACKAGE_IMPORT_IDEMPOTENCY_CONFLICT 且不创建项目', async (t) => {
  if (!hasMySql) { t.skip('requires the CI MySQL service'); return }
  const userId = 'user-r2'
  const first = await makePreview(userId)
  const key = newKey('e2e-r2')
  await confirmProductionPackageImport({
    token: first.preview.preview_token, owner: owner(userId),
    packageFingerprint: first.preview.package.package_fingerprint,
    validationFingerprint: first.preview.package.validation_fingerprint,
    idempotencyKey: key,
  })
  createdDramaIds.add((await pool.query('SELECT drama_id FROM production_package_imports WHERE idempotency_key = ?', [key]))[0][0].drama_id)
  // 换包：改写一集正文（改变指纹）
  const mutatedRoot = helpers.copyPackage(FIXTURE_PACKAGE, path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jisu-pp-rel-mut-')), 'package'))
  helpers.applyMutation(mutatedRoot, { mutate: 'replace', target: 'episodes/001.md', replace: { find: '雨', with: '雪' } })
  const second = await makePreview(userId, () => mutatedRoot)
  const error = await confirmProductionPackageImport({
    token: second.preview.preview_token, owner: owner(userId),
    packageFingerprint: second.preview.package.package_fingerprint,
    validationFingerprint: second.preview.package.validation_fingerprint,
    idempotencyKey: key,
  }).then(() => null, (e) => e)
  const [importRows] = await pool.query('SELECT COUNT(*) AS c, MAX(drama_id) AS drama_id FROM production_package_imports WHERE idempotency_key = ?', [key])
  console.log('[R2]', JSON.stringify({ code: error?.code, status: error?.status, importRows: importRows[0].c, importDramaId: importRows[0].drama_id }))
  assert.equal(error?.code, 'PACKAGE_IMPORT_IDEMPOTENCY_CONFLICT')
  assert.equal(error?.status, 409)
  assert.equal(importRows[0].c, 1, '冲突后该幂等键仍只对应一行（未创建新项目）')
})

test('R3 并发确认：只有一个请求真正创建项目，其余为 409 或重放', async (t) => {
  if (!hasMySql) { t.skip('requires the CI MySQL service'); return }
  const userId = 'user-r3'
  const { preview } = await makePreview(userId)
  const key = newKey('e2e-r3')
  const results = await Promise.all(Array.from({ length: 5 }, () => confirmProductionPackageImport({
    token: preview.preview_token, owner: owner(userId),
    packageFingerprint: preview.package.package_fingerprint,
    validationFingerprint: preview.package.validation_fingerprint,
    idempotencyKey: key,
  }).then((value) => ({ ok: value }), (error) => ({ error }))))
  const created = results.filter(r => r.ok && r.ok.replayed === false)
  const replayed = results.filter(r => r.ok && r.ok.replayed === true && r.ok.status === 'completed')
  const rejected = results.filter(r => r.error)
  // 健康目标（fix #113 合入后）：并发同 key 只允许 1 个请求写入，其余只能重放或 409
  const [linked] = await pool.query('SELECT drama_id FROM production_package_imports WHERE idempotency_key = ?', [key])
  const linkedIds = new Set(linked.map(r => Number(r.drama_id)))
  const orphanDramas = created.map(r => r.ok.drama_id).filter(id => !linkedIds.has(id))
  console.log('[R3]', JSON.stringify({
    created: created.length,
    replayed: replayed.length,
    rejected: rejected.map(r => `${r.error.code}:${r.error.status}`),
    uniqueCreatedDramaIds: [...new Set(created.map(r => r.ok.drama_id))].length,
    orphanDramas: orphanDramas.length,
  }))
  assert.equal(created.length, 1, '并发下只能有一个请求真正写入（修复后健康目标）')
  assert.equal(new Set(created.map(r => r.ok.drama_id)).size, 1, '并发下只能产生一个唯一项目')
  assert.equal(orphanDramas.length, 0, '不得产生孤儿项目')
  for (const r of rejected) assert.equal(r.error.status, 409, '未取得 claim 的请求应为 409 IN_PROGRESS')
  for (const r of replayed) assert.equal(r.ok.drama_id, created[0].ok.drama_id, '重放必须返回同一项目')
  for (const id of created.map(r => r.ok.drama_id)) createdDramaIds.add(id)
})

test('R4 快照过期：410 PACKAGE_PREVIEW_EXPIRED 且过期快照被清理', async (t) => {
  if (!hasMySql) { t.skip('requires the CI MySQL service'); return }
  const userId = 'user-r4'
  const { preview } = await makePreview(userId)
  await pool.query('UPDATE preview_package_snapshots SET expires_at = ? WHERE token = ?', [Date.now() - 1000, preview.preview_token])
  const error = await getProductionPackageSnapshotForConfirm(preview.preview_token, owner(userId), {
    packageFingerprint: preview.package.package_fingerprint,
    validationFingerprint: preview.package.validation_fingerprint,
  }).then(() => null, (e) => e)
  const rows = (await pool.query('SELECT COUNT(*) AS c FROM preview_package_snapshots WHERE token = ?', [preview.preview_token]))[0][0].c
  console.log('[R4]', JSON.stringify({ code: error?.code, status: error?.status, snapshotRowsLeft: rows }))
  assert.equal(error?.code, 'PACKAGE_PREVIEW_EXPIRED')
  assert.equal(error?.status, 410)
  assert.equal(rows, 0, '过期快照应被清理，避免无限堆积')
})

test('R5 快照篡改：upload.zip 被替换 → 409 PACKAGE_SNAPSHOT_MISMATCH', async (t) => {
  if (!hasMySql) { t.skip('requires the CI MySQL service'); return }
  const userId = 'user-r5'
  const { preview } = await makePreview(userId)
  const [row] = (await pool.query('SELECT snapshot_id, root_relative FROM preview_package_snapshots WHERE token = ?', [preview.preview_token]))[0]
  const directory = path.join(snapshotRoot, row.snapshot_id)
  fs.writeFileSync(path.join(directory, 'upload.zip'), Buffer.from('tampered-upload-bytes'))
  const error = await getProductionPackageSnapshotForConfirm(preview.preview_token, owner(userId), {
    packageFingerprint: preview.package.package_fingerprint,
    validationFingerprint: preview.package.validation_fingerprint,
  }).then(() => null, (e) => e)
  console.log('[R5]', JSON.stringify({ code: error?.code, status: error?.status }))
  assert.equal(error?.code, 'PACKAGE_SNAPSHOT_MISMATCH')
  assert.equal(error?.status, 409)
})

test('R6 Confirm 中途失败：幂等记录收口为 failed 且可诊断，无半成品数据，新 key 可重试成功', async (t) => {
  if (!hasMySql) { t.skip('requires the CI MySQL service'); return }
  const userId = 'user-r6'
  const { preview } = await makePreview(userId)
  const key = newKey('e2e-r6')
  const db = await import('../src/db/index.ts')
  const originalGetConnection = db.pool.getConnection.bind(db.pool)
  let connectionIndex = 0
  db.pool.getConnection = async () => {
    connectionIndex += 1
    const connection = await originalGetConnection()
    if (connectionIndex === 2) {
      const originalExecute = connection.execute.bind(connection)
      connection.execute = async (sql, ...rest) => {
        if (String(sql).includes('INSERT INTO dramas')) throw new Error('注入：模拟写入阶段失败')
        return originalExecute(sql, ...rest)
      }
    }
    return connection
  }
  const dramaBefore = (await pool.query('SELECT COUNT(*) AS c FROM dramas'))[0][0].c
  let error = null
  try {
    await confirmProductionPackageImport({
      token: preview.preview_token, owner: owner(userId),
      packageFingerprint: preview.package.package_fingerprint,
      validationFingerprint: preview.package.validation_fingerprint,
      idempotencyKey: key,
    })
  } catch (e) { error = e } finally { db.pool.getConnection = originalGetConnection }
  const row = (await pool.query('SELECT status, error_json FROM production_package_imports WHERE idempotency_key = ?', [key]))[0][0]
  const dramaAfter = (await pool.query('SELECT COUNT(*) AS c FROM dramas'))[0][0].c
  console.log('[R6]', JSON.stringify({ errorCode: error?.code, errorStatus: error?.status, importStatus: row?.status, hasErrorJson: Boolean(row?.error_json), dramaDelta: dramaAfter - dramaBefore }))
  assert.equal(error?.code, 'PACKAGE_IMPORT_FAILED')
  assert.equal(row.status, 'failed', '失败必须收口为 failed，不能卡在 processing')
  assert.ok(row.error_json, '失败记录必须可诊断')
  assert.equal(dramaAfter - dramaBefore, 0, '失败后不得留下半成品项目')

  const retrySameKey = await confirmProductionPackageImport({
    token: preview.preview_token, owner: owner(userId),
    packageFingerprint: preview.package.package_fingerprint,
    validationFingerprint: preview.package.validation_fingerprint,
    idempotencyKey: key,
  })
  console.log('[R6] retry same key =', JSON.stringify(retrySameKey))
  assert.equal(retrySameKey.status, 'failed', '同 key 重放返回既有 failed 结果（语义事实，见报告）')
  assert.equal(retrySameKey.replayed, true)

  const retryNewKey = await confirmProductionPackageImport({
    token: preview.preview_token, owner: owner(userId),
    packageFingerprint: preview.package.package_fingerprint,
    validationFingerprint: preview.package.validation_fingerprint,
    idempotencyKey: newKey('e2e-r6-retry'),
  })
  console.log('[R6] retry new key =', JSON.stringify(retryNewKey))
  assert.equal(retryNewKey.status, 'completed')
  createdDramaIds.add(retryNewKey.drama_id)
})

test('R7 数据清洁：成功导入的数据完整且引用闭合；失败不产生孤儿', async (t) => {
  if (!hasMySql) { t.skip('requires the CI MySQL service'); return }
  const userId = 'user-r7'
  const { preview } = await makePreview(userId)
  const result = await confirmProductionPackageImport({
    token: preview.preview_token, owner: owner(userId),
    packageFingerprint: preview.package.package_fingerprint,
    validationFingerprint: preview.package.validation_fingerprint,
    idempotencyKey: newKey('e2e-r7'),
  })
  createdDramaIds.add(result.drama_id)
  const c = await counts(result.drama_id)
  const orphanEpisodeCharacters = (await pool.query('SELECT COUNT(*) AS c FROM episode_characters ec LEFT JOIN episodes e ON e.id = ec.episode_id WHERE e.id IS NULL'))[0][0].c
  const orphanEpisodeScenes = (await pool.query('SELECT COUNT(*) AS c FROM episode_scenes es LEFT JOIN episodes e ON e.id = es.episode_id WHERE e.id IS NULL'))[0][0].c
  console.log('[R7]', JSON.stringify({ dramaId: result.drama_id, episodesInPackage: preview.episodes.length, ...c, orphanEpisodeCharacters, orphanEpisodeScenes }))
  assert.equal(c.episodes, preview.episodes.length)
  assert.equal(c.characters, preview.characters.length)
  assert.equal(c.scenes, preview.scenes.length)
  assert.equal(c.sourceVersions, 1, '应写入一条 source 版本')
  assert.equal(orphanEpisodeCharacters, 0)
  assert.equal(orphanEpisodeScenes, 0)
})

test('R8 Preview 租约与清理边界：过期快照与孤儿目录被回收', async (t) => {
  if (!hasMySql) { t.skip('requires the CI MySQL service'); return }
  const userId = 'user-r8'
  const { preview } = await makePreview(userId)
  const orphanDirectory = path.join(snapshotRoot, crypto.randomUUID())
  fs.mkdirSync(orphanDirectory, { recursive: true })
  const stale = new Date(Date.now() - PREVIEW_LIMITS.ttlMs - 60_000)
  fs.utimesSync(orphanDirectory, stale, stale)
  const removed = await cleanupExpiredProductionPackagePreviewsShared(Date.now() + PREVIEW_LIMITS.ttlMs + 1)
  const rows = (await pool.query('SELECT COUNT(*) AS c FROM preview_package_snapshots WHERE token = ?', [preview.preview_token]))[0][0].c
  const orphanRemoved = cleanupOrphanedProductionPackagePreviewDirectories()
  console.log('[R8]', JSON.stringify({ removedExpired: removed, snapshotRowsLeft: rows, orphanRemoved, orphanDirectoryExists: fs.existsSync(orphanDirectory) }))
  assert.ok(removed >= 1, '过期快照应被回收')
  assert.equal(rows, 0)
  assert.ok(orphanRemoved >= 1, '孤儿目录应被回收')
  assert.equal(fs.existsSync(orphanDirectory), false)
})

after(async () => {
  fs.rmSync(snapshotRoot, { recursive: true, force: true })
  if (pool) await pool.end().catch(() => undefined)
  if (isolated) await isolated.cleanup() // 隔离库直接 DROP
})
