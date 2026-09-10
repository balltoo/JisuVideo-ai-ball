/**
 * Issue #108 最小后端修复的回归测试
 *
 * 修复 1（backend/src/middleware/preview-auth.ts）：
 *   端点白名单收敛为精确的 POST /preview、GET /preview/:token、POST /import/confirm
 *   —— 修复前 import/confirm 不在白名单，HTTP 导入链路恒 401。
 * 修复 2（backend/src/services/production-package-import.ts）：
 *   幂等 claim 改为"简单 INSERT 成功即唯一 owner"，未取得 claim 的请求只回放，绝不进入 writeImport
 *   —— 修复前并发同 key 会创建多个项目并留下孤儿。
 *
 * 环境（同 Issue #108 验收）：MYSQL_* 或 DATABASE_URL；未配置 MySQL 时数据库段 skip。
 * 运行：cd backend && node --import tsx/esm --test --test-force-exit tests/production-package-import-fix.test.mjs
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import yazl from 'yazl'
import * as helpers from './fixtures/production-package/helpers.mjs'
import { prepareIsolatedMySql } from './fixtures/production-package/mysql-isolate.mjs'

process.env.NODE_ENV = 'test'
process.env.MYSQL_NO_INIT = '1'
const SECRET = Buffer.alloc(32, 7).toString('base64url')
process.env.PREVIEW_AUTH_PROXY_SECRET = SECRET
const snapshotRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jisu-pp-fix-snapshot-'))
process.env.PREVIEW_SNAPSHOT_ROOT = snapshotRoot
process.env.PREVIEW_PACKAGE_SNAPSHOT_STORE = 'mysql'
process.env.PREVIEW_AUTH_NONCE_STORE = 'mysql'
process.env.PREVIEW_REQUEST_RESOURCE_STORE = 'mysql'

// 与 e2e/reliability 相同：唯一隔离库，避免 npm test 多文件并发互踩。
const hasMySql = Boolean(process.env.MYSQL_HOST || process.env.DATABASE_URL)
const isolated = hasMySql ? await prepareIsolatedMySql('jisu_pp_fix') : null
const { app, createApi } = await import('../src/index.ts')
const { signPreviewIdentity, PREVIEW_AUTH_AUDIENCE } = await import('../src/middleware/preview-auth.ts')

const FIXTURE_PACKAGE = path.join(helpers.PACKAGES_DIR, 'fixture-rain-lantern')
const poolOptions = process.env.DATABASE_URL
  ? { uri: process.env.DATABASE_URL }
  : { host: process.env.MYSQL_HOST, port: Number(process.env.MYSQL_PORT || 3306), user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD, database: process.env.MYSQL_DATABASE }
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

async function createSignedRequest(pathname, { method = 'POST', body, tenantId = 'tenant-fix', userId = 'user-fix' } = {}) {
  const request = new Request(`http://localhost${pathname}`, { method, body })
  const bodyBytes = await request.clone().arrayBuffer()
  const bodySha256 = crypto.createHash('sha256').update(Buffer.from(bodyBytes)).digest('hex')
  const nonce = crypto.randomBytes(16).toString('base64url')
  const issuedAt = Date.now()
  const expiresAt = issuedAt + 60_000
  request.headers.set('x-authenticated-tenant-id', tenantId)
  request.headers.set('x-authenticated-user-id', userId)
  request.headers.set('x-authenticated-issued-at', String(issuedAt))
  request.headers.set('x-authenticated-expires-at', String(expiresAt))
  request.headers.set('x-authenticated-audience', PREVIEW_AUTH_AUDIENCE)
  request.headers.set('x-authenticated-method', method)
  request.headers.set('x-authenticated-path', pathname)
  request.headers.set('x-authenticated-body-sha256', bodySha256)
  request.headers.set('x-authenticated-nonce', nonce)
  request.headers.set('x-authenticated-signature', signPreviewIdentity({ tenantId, userId, issuedAt, expiresAt, audience: PREVIEW_AUTH_AUDIENCE }, SECRET, { method, path: pathname, bodySha256, nonce }))
  return request
}

const call = async (pathname, options) => {
  const response = await app.fetch(await createSignedRequest(pathname, options))
  return { status: response.status, body: await response.json().catch(() => null) }
}

async function previewResponse(userId = 'user-fix') {
  const form = new FormData()
  form.set('file', new File([await zipDirectory(FIXTURE_PACKAGE)], 'fixture-rain-lantern.zip'))
  return call('/api/v1/production-packages/preview', { body: form, userId })
}

const confirmBody = (token, preview, key) => JSON.stringify({
  preview_token: token,
  package_fingerprint: preview.package.package_fingerprint,
  validation_fingerprint: preview.package.validation_fingerprint,
  idempotency_key: key,
})

test('修复 1：HTTP Confirm 现在可以成功创建项目（修复前恒 401）', async (t) => {
  if (!hasMySql) { t.skip('requires the CI MySQL service'); return }
  const preview = await previewResponse()
  assert.equal(preview.status, 200)
  const token = preview.body.data.preview_token
  const key = `fix-http-${crypto.randomUUID()}`
  usedKeys.add(key)
  const confirm = await call('/api/v1/production-packages/import/confirm', { body: confirmBody(token, preview.body.data, key) })
  console.log('[fix-1]', JSON.stringify({ status: confirm.status, code: confirm.body?.code, data: confirm.body?.data }))
  assert.equal(confirm.status, 200, `confirm 应成功：${JSON.stringify(confirm.body)}`)
  assert.equal(confirm.body.data.status, 'completed')
  assert.equal(confirm.body.data.replayed, false)
  createdDramaIds.add(confirm.body.data.drama_id)

  const created = await app.fetch(new Request(`http://localhost/api/v1/dramas/${confirm.body.data.drama_id}`))
  console.log('[fix-1] query drama =', created.status)
  assert.equal(created.status, 200, '创建结果应可通过既有接口查询')
})

test('Issue #112：本地可信会话以普通 HTTP 完成 Preview → Confirm，客户端身份头不生效', async (t) => {
  if (!hasMySql) { t.skip('requires the CI MySQL service'); return }
  const previousMode = process.env.PREVIEW_AUTH_MODE
  const previousSessionSecret = process.env.PREVIEW_LOCAL_SESSION_SECRET
  process.env.PREVIEW_AUTH_MODE = 'local-session'
  process.env.PREVIEW_LOCAL_SESSION_SECRET = SECRET
  const localApi = createApi()
  try {
    const form = new FormData()
    form.set('file', new File([await zipDirectory(FIXTURE_PACKAGE)], 'fixture-rain-lantern.zip'))
    const previewResponse = await localApi.fetch(new Request('http://localhost/production-packages/preview', {
      method: 'POST',
      headers: {
        origin: 'http://localhost:3013',
        'x-authenticated-tenant-id': 'forged-tenant',
        'x-authenticated-user-id': 'forged-user',
      },
      body: form,
    }))
    if (previewResponse.status !== 200) assert.fail(await previewResponse.text())
    assert.equal(previewResponse.status, 200)
    const cookie = previewResponse.headers.get('set-cookie')?.split(';', 1)[0]
    assert.ok(cookie, '本地会话必须由服务端签发 HttpOnly cookie')
    const preview = await previewResponse.json()
    const key = `local-session-${crypto.randomUUID()}`
    usedKeys.add(key)

    const confirmResponse = await localApi.fetch(new Request('http://localhost/production-packages/import/confirm', {
      method: 'POST',
      headers: {
        origin: 'http://localhost:3013',
        cookie,
        'content-type': 'application/json',
        'x-authenticated-tenant-id': 'forged-other-tenant',
        'x-authenticated-user-id': 'forged-other-user',
      },
      body: confirmBody(preview.data.preview_token, preview.data, key),
    }))
    if (confirmResponse.status !== 200) assert.fail(await confirmResponse.text())
    assert.equal(confirmResponse.status, 200)
    const confirmed = await confirmResponse.json()
    assert.equal(confirmed.data.status, 'completed')
    assert.equal(confirmed.data.replayed, false)
    createdDramaIds.add(confirmed.data.drama_id)
  } finally {
    if (previousMode === undefined) delete process.env.PREVIEW_AUTH_MODE
    else process.env.PREVIEW_AUTH_MODE = previousMode
    if (previousSessionSecret === undefined) delete process.env.PREVIEW_LOCAL_SESSION_SECRET
    else process.env.PREVIEW_LOCAL_SESSION_SECRET = previousSessionSecret
  }
})

test('修复 1 回归：白名单仍然收敛（method 与路径必须精确匹配）', async (t) => {
  if (!hasMySql) { t.skip('requires the CI MySQL service'); return }
  const preview = await previewResponse('user-fix-guard')
  assert.equal(preview.status, 200)
  const token = preview.body.data.preview_token
  const mysqlDiag = (await import('mysql2/promise')).default
  const diagPool = mysqlDiag.createPool(poolOptions)
  try {
    const [snapRows] = await diagPool.query('SELECT COUNT(*) AS c FROM preview_package_snapshots WHERE token = ?', [token])
    console.log('[fix-1-guard] snapshotRows =', snapRows[0].c, 'tokenHead =', String(token).slice(0, 8))
  } finally { await diagPool.end() }
  // GET /preview/:token 应被允许（同一 owner 才可读，沿用创建时的 user-fix-guard）
  const wrongMethod = await call(`/api/v1/production-packages/preview/${token}`, { method: 'GET', body: undefined, userId: 'user-fix-guard' })
  console.log('[fix-1-guard] getToken =', wrongMethod.status, JSON.stringify(wrongMethod.body?.code))
  assert.equal(wrongMethod.status, 200, 'GET /preview/:token 应被允许')
  const postToToken = await call(`/api/v1/production-packages/preview/${token}`, { method: 'POST', body: JSON.stringify({}), userId: 'user-fix-guard' })
  assert.equal(postToToken.status, 401, 'POST /preview/:token 必须被拒绝')
  // GET 到 preview 上传路径（应为 POST）→ 401
  const getUpload = await call('/api/v1/production-packages/preview', { method: 'GET' })
  assert.equal(getUpload.status, 401, 'GET /preview 必须被拒绝')
  // PUT 到 confirm → 401
  const putConfirm = await call('/api/v1/production-packages/import/confirm', { method: 'PUT', body: JSON.stringify({}) })
  assert.equal(putConfirm.status, 401, 'PUT /import/confirm 必须被拒绝')
  console.log('[fix-1-guard]', JSON.stringify({ postToToken: postToToken.status, getUpload: getUpload.status, putConfirm: putConfirm.status }))
})

test('修复 2：并发相同幂等键只创建一个项目，其余重放或 409 IN_PROGRESS', async (t) => {
  if (!hasMySql) { t.skip('requires the CI MySQL service'); return }
  const { confirmProductionPackageImport } = await import('../src/services/production-package-import.ts')
  const { createProductionPackagePreview } = await import('../src/services/production-package-preview.ts')
  const userId = 'user-fix-concurrent'
  const ownerKey = JSON.stringify(['tenant-fix', userId])
  const zip = await zipDirectory(FIXTURE_PACKAGE)
  const preview = await createProductionPackagePreview({ zip, owner: ownerKey })
  const key = `fix-concurrent-${crypto.randomUUID()}`
  usedKeys.add(key)
  const mysql = (await import('mysql2/promise')).default
  const poolOptions = process.env.DATABASE_URL
    ? { uri: process.env.DATABASE_URL }
    : { host: process.env.MYSQL_HOST, port: Number(process.env.MYSQL_PORT || 3306), user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD, database: process.env.MYSQL_DATABASE }
  const pool = mysql.createPool(poolOptions)
  try {
    const results = await Promise.all(Array.from({ length: 5 }, () => confirmProductionPackageImport({
      token: preview.preview_token,
      owner: ownerKey,
      packageFingerprint: preview.package.package_fingerprint,
      validationFingerprint: preview.package.validation_fingerprint,
      idempotencyKey: key,
    }).then((value) => ({ ok: value }), (error) => ({ error }))))
    const created = results.filter(r => r.ok && r.ok.replayed === false)
    const replayed = results.filter(r => r.ok && r.ok.replayed === true && r.ok.status === 'completed')
    const rejected = results.filter(r => r.error)
    const [linked] = await pool.query('SELECT drama_id FROM production_package_imports WHERE idempotency_key = ?', [key])
    const orphanDramas = created.map(r => r.ok.drama_id).filter(id => !linked.some(l => Number(l.drama_id) === id))
    console.log('[fix-2]', JSON.stringify({
      created: created.length,
      replayed: replayed.length,
      rejected: rejected.map(r => `${r.error.code}:${r.error.status}`),
      uniqueCreatedDramaIds: [...new Set(created.map(r => r.ok.drama_id))].length,
      orphanDramas: orphanDramas.length,
    }))
    assert.equal(created.length, 1, '并发下只能有一个请求真正写入')
    assert.equal(new Set(created.map(r => r.ok.drama_id)).size, 1, '并发下只能产生一个唯一项目')
    assert.equal(orphanDramas.length, 0, '不得产生孤儿项目')
    for (const r of rejected) assert.equal(r.error.status, 409)
    for (const r of replayed) assert.equal(r.ok.drama_id, created[0].ok.drama_id)
    createdDramaIds.add(created[0].ok.drama_id)
  } finally {
    await pool.end()
  }
})

after(async () => {
  fs.rmSync(snapshotRoot, { recursive: true, force: true })
  if (isolated) await isolated.cleanup() // 隔离库直接 DROP
})
