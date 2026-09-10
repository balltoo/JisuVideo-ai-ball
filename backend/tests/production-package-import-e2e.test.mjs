/**
 * Issue #108 / P0：生产包导入 HTTP 级端到端验收（健康目标版）
 *
 * 依赖：fix(#108) 已合入 master（preview-auth 精确白名单 + import 原子 claim）。
 * 断言为健康目标：HTTP Confirm 必须成功创建项目、幂等重放必须返回同一结果。
 *
 * 覆盖：
 *   A1 签名身份 → ZIP Preview（200）→ 获取 Preview（200）→ Confirm（200 completed）→ 查询创建结果
 *   A2 HTTP 幂等重放：同 key 第二次 Confirm → 200 completed + replayed:true + 同一 drama_id，dramas +1
 *
 * 服务层可靠性矩阵（并发/快照过期与篡改/失败收口/数据清洁/清理）见
 * production-package-import-reliability.test.mjs；历史缺陷证据见
 * docs/production-package-import-reliability-acceptance.md。
 *
 * 环境：MYSQL_* 或 DATABASE_URL；未配置 MySQL 时按仓库既有约定 skip（CI 提供 mysql:8.0 service）。
 * 运行：cd backend && node --import tsx/esm --test --test-force-exit tests/production-package-import-e2e.test.mjs
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
const snapshotRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jisu-pp-e2e-snapshot-'))
process.env.PREVIEW_SNAPSHOT_ROOT = snapshotRoot
process.env.PREVIEW_PACKAGE_SNAPSHOT_STORE = 'mysql'
process.env.PREVIEW_AUTH_NONCE_STORE = 'mysql'
process.env.PREVIEW_REQUEST_RESOURCE_STORE = 'mysql'

// 先建唯一隔离库并把 MYSQL_DATABASE 指向它，再加载 app，避免与其它真实 MySQL
// 测试文件在 npm test 并发运行时互相污染（Issue #108 实测教训）。
const hasMySql = Boolean(process.env.MYSQL_HOST || process.env.DATABASE_URL)
const isolated = hasMySql ? await prepareIsolatedMySql('jisu_pp_e2e') : null
const { app } = await import('../src/index.ts')
const { signPreviewIdentity, PREVIEW_AUTH_AUDIENCE } = await import('../src/middleware/preview-auth.ts')

const FIXTURE_PACKAGE = path.join(helpers.PACKAGES_DIR, 'fixture-rain-lantern')
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

async function previewPackage(userId = 'user-e2e') {
  const form = new FormData()
  form.set('file', new File([await zipDirectory(FIXTURE_PACKAGE)], 'fixture-rain-lantern.zip'))
  return call('/api/v1/production-packages/preview', { body: form, userId })
}

const confirmPayload = (preview, key, token) => JSON.stringify({
  preview_token: token,
  package_fingerprint: preview.package.package_fingerprint,
  validation_fingerprint: preview.package.validation_fingerprint,
  idempotency_key: key,
})

test('A1 HTTP 完整成功路径：Preview → 获取 Preview → Confirm → 查询创建结果', async (t) => {
  if (!hasMySql) { t.skip('requires the CI MySQL service'); return }
  const userId = 'user-e2e-a1'
  const preview = await previewPackage(userId)
  assert.equal(preview.status, 200, `preview 失败: ${JSON.stringify(preview.body)}`)
  assert.equal(preview.body.data.can_confirm, true, 'fixture 包应可确认')
  const token = preview.body.data.preview_token

  const read = await call(`/api/v1/production-packages/preview/${token}`, { method: 'GET', userId })
  assert.equal(read.status, 200, `获取 preview 失败: ${JSON.stringify(read.body)}`)

  const key = `e2e-a1-${crypto.randomUUID()}`
  usedKeys.add(key)
  const confirm = await call('/api/v1/production-packages/import/confirm', { body: confirmPayload(preview.body.data, key, token), userId })
  console.log('[A1]', JSON.stringify({ status: confirm.status, code: confirm.body?.code, data: confirm.body?.data }))
  assert.equal(confirm.status, 200, `confirm 失败: ${JSON.stringify(confirm.body)}`)
  assert.equal(confirm.body.data.status, 'completed')
  assert.equal(confirm.body.data.replayed, false)
  createdDramaIds.add(confirm.body.data.drama_id)

  const created = await app.fetch(new Request(`http://localhost/api/v1/dramas/${confirm.body.data.drama_id}`))
  assert.equal(created.status, 200, '创建结果应可经 GET /dramas/:id 查询')
})

test('A2 HTTP 幂等重放：同 key 第二次 Confirm 返回同一结果，只创建一个项目', async (t) => {
  if (!hasMySql) { t.skip('requires the CI MySQL service'); return }
  const userId = 'user-e2e-a2'
  const preview = await previewPackage(userId)
  const key = `e2e-a2-${crypto.randomUUID()}`
  usedKeys.add(key)
  const token = preview.body.data.preview_token
  const first = await call('/api/v1/production-packages/import/confirm', { body: confirmPayload(preview.body.data, key, token), userId })
  assert.equal(first.status, 200)
  assert.equal(first.body.data.replayed, false)
  createdDramaIds.add(first.body.data.drama_id)
  const replay = await call('/api/v1/production-packages/import/confirm', { body: confirmPayload(preview.body.data, key, token), userId })
  console.log('[A2]', JSON.stringify({ first: { drama: first.body.data?.drama_id, replayed: first.body.data?.replayed }, replay: { status: replay.status, drama: replay.body.data?.drama_id, replayed: replay.body.data?.replayed } }))
  assert.equal(replay.status, 200, `重放失败: ${JSON.stringify(replay.body)}`)
  assert.equal(replay.body.data.status, 'completed')
  assert.equal(replay.body.data.replayed, true)
  assert.equal(replay.body.data.drama_id, first.body.data.drama_id, '重放必须返回同一项目')
})

after(async () => {
  fs.rmSync(snapshotRoot, { recursive: true, force: true })
  if (isolated) await isolated.cleanup() // 隔离库直接 DROP，无需逐表清理
})
