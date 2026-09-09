/**
 * Issue #108 / P0：生产包导入 HTTP 级端到端可靠性验收（主链路探测版）
 *
 * 契约与基线：docs/production-package-zip-transport-v0.1.md，master 6384cec（PR #106 后）
 * 覆盖（逐步补齐，见 docs/production-package-import-reliability-acceptance.md）：
 *   签名身份 → ZIP Preview → 获取 Preview → Confirm → 查询创建结果
 *
 * 环境前提（不写死凭据与本机路径，全部走环境变量）：
 *   MYSQL_HOST / MYSQL_PORT / MYSQL_USER / MYSQL_PASSWORD / MYSQL_DATABASE（或 DATABASE_URL）
 *   未配置 MySQL 时，**仅**本文件的数据库段按仓库既有约定 skip（CI 提供 mysql:8.0 service）。
 * 生产拓扑开关（与 docker-compose.yml 一致）：
 *   PREVIEW_PACKAGE_SNAPSHOT_STORE=mysql、PREVIEW_AUTH_NONCE_STORE=mysql、PREVIEW_REQUEST_RESOURCE_STORE=mysql
 *
 * 运行：cd backend && node --import tsx/esm --test tests/production-package-import-e2e.test.mjs
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

// 必须在动态 import 任何 ../src/** 之前设置（db/index.ts 顶层 initDb 会建表）
process.env.NODE_ENV = 'test'
process.env.MYSQL_NO_INIT = '1'

const SECRET = Buffer.alloc(32, 7).toString('base64url')
process.env.PREVIEW_AUTH_PROXY_SECRET = SECRET
const snapshotRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jisu-pp-e2e-snapshot-'))
const reservationRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jisu-pp-e2e-reservation-'))
process.env.PREVIEW_SNAPSHOT_ROOT = snapshotRoot
process.env.PREVIEW_REQUEST_RESERVATION_PATH = reservationRoot
process.env.PREVIEW_PACKAGE_SNAPSHOT_STORE = 'mysql'
process.env.PREVIEW_AUTH_NONCE_STORE = 'mysql'
process.env.PREVIEW_REQUEST_RESOURCE_STORE = 'mysql'

const { app } = await import('../src/index.ts')
const { signPreviewIdentity, PREVIEW_AUTH_AUDIENCE } = await import('../src/middleware/preview-auth.ts')

const FIXTURE_PACKAGE = path.join(helpers.PACKAGES_DIR, 'fixture-rain-lantern')
const createdDramaIds = new Set()

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

async function createSignedRequest(pathname, { method = 'POST', body, tenantId = 'tenant-e2e', userId = 'user-e2e' } = {}) {
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

async function previewPackage(tenantId = 'tenant-e2e', userId = 'user-e2e') {
  const form = new FormData()
  form.set('file', new File([await zipDirectory(FIXTURE_PACKAGE)], 'fixture-rain-lantern.zip'))
  return call('/api/v1/production-packages/preview', { body: form, tenantId, userId })
}

const hasMySql = Boolean(process.env.MYSQL_HOST || process.env.DATABASE_URL)

test('HTTP 主链路：Preview → 获取 Preview → Confirm（探测签名路径是否可达）', async (t) => {
  if (!hasMySql) { t.skip('requires the CI MySQL service'); return }
  const preview = await previewPackage()
  console.log('[e2e] preview status =', preview.status, 'code =', preview.body?.code, 'can_confirm =', preview.body?.data?.can_confirm)
  assert.equal(preview.status, 200, `preview 失败: ${JSON.stringify(preview.body)}`)
  const token = preview.body.data.preview_token
  const read = await call(`/api/v1/production-packages/preview/${token}`, { method: 'GET' })
  console.log('[e2e] get preview status =', read.status, 'code =', read.body?.code)
  assert.equal(read.status, 200)

  const confirm = await call('/api/v1/production-packages/import/confirm', {
    body: JSON.stringify({
      preview_token: token,
      package_fingerprint: preview.body.data.package.package_fingerprint,
      validation_fingerprint: preview.body.data.package.validation_fingerprint,
      idempotency_key: `e2e-probe-${crypto.randomUUID()}`,
    }),
  })
  console.log('[e2e] confirm status =', confirm.status, 'code =', confirm.body?.code, 'message =', confirm.body?.message)
  // 已知缺陷（Issue #108 验收发现，待主账号确认热点锁后最小修复）：
  // 签名身份中间件 preview-auth.ts 的 PREVIEW_PATH_PATTERN 只覆盖
  // /production-packages/preview[/token]，不含 /production-packages/import/confirm，
  // 因此 Confirm 在 HTTP 层恒定 401（认证层拒绝，未进入业务层）。
  // 修复后本断言需改为 200 + status === 'completed'。
  assert.equal(confirm.status, 401, `confirm 现状与预期不符（缺陷可能已修复，请更新断言）: ${JSON.stringify(confirm.body)}`)
  assert.equal(confirm.body.code, 'PACKAGE_PREVIEW_UNAUTHORIZED')
})

test('缺陷定位对照：服务层直连同一包可完成导入（证明 401 仅在认证层，业务逻辑本身可用）', async (t) => {
  if (!hasMySql) { t.skip('requires the CI MySQL service'); return }
  const { createProductionPackagePreview } = await import('../src/services/production-package-preview.ts')
  const { confirmProductionPackageImport } = await import('../src/services/production-package-import.ts')
  const tenantId = 'tenant-e2e'
  const userId = 'user-e2e-service'
  const owner = JSON.stringify([tenantId, userId])
  const zip = await zipDirectory(FIXTURE_PACKAGE)
  const preview = await createProductionPackagePreview({ zip, owner })
  assert.equal(preview.can_confirm, true, 'fixture 包应可作为可确认预览')
  const result = await confirmProductionPackageImport({
    token: preview.preview_token,
    owner,
    packageFingerprint: preview.package.package_fingerprint,
    validationFingerprint: preview.package.validation_fingerprint,
    idempotencyKey: `e2e-service-${crypto.randomUUID()}`,
  })
  console.log('[e2e] service confirm =', JSON.stringify({ status: result.status, dramaId: result.drama_id, replayed: result.replayed }))
  assert.equal(result.status, 'completed')
  assert.equal(result.replayed, false)
  createdDramaIds.add(result.drama_id)

  // 静态定位：认证层路径白名单不含 import/confirm
  const authSource = fs.readFileSync(path.join(process.cwd(), 'src', 'middleware', 'preview-auth.ts'), 'utf8')
  const patternLine = /const PREVIEW_PATH_PATTERN = [^\n]+/.exec(authSource)?.[0] ?? ''
  console.log('[e2e] PREVIEW_PATH_PATTERN =', patternLine)
  assert.match(patternLine, /production-packages\\\/preview/, '路径白名单应仅覆盖 preview（缺陷根因待修复后更新）')
})

after(async () => {
  if (!hasMySql || createdDramaIds.size === 0) {
    fs.rmSync(snapshotRoot, { recursive: true, force: true })
    fs.rmSync(reservationRoot, { recursive: true, force: true })
    return
  }
  const mysql = (await import('mysql2/promise')).default
  const options = process.env.DATABASE_URL
    ? { uri: process.env.DATABASE_URL }
    : { host: process.env.MYSQL_HOST, port: Number(process.env.MYSQL_PORT || 3306), user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD, database: process.env.MYSQL_DATABASE }
  const pool = mysql.createPool(options)
  try {
    for (const dramaId of createdDramaIds) {
      await pool.query('DELETE FROM dramas WHERE id = ?', [dramaId])
    }
    await pool.query('DELETE FROM preview_package_snapshots')
  } finally {
    await pool.end()
    fs.rmSync(snapshotRoot, { recursive: true, force: true })
    fs.rmSync(reservationRoot, { recursive: true, force: true })
  }
})
