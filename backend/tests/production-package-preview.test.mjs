import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import yazl from 'yazl'
import { Hono } from 'hono'

import * as helpers from './fixtures/production-package/helpers.mjs'
import {
  PREVIEW_LIMITS,
  ProductionPackagePreviewError,
  createProductionPackagePreview,
  getProductionPackagePreview,
  cleanupExpiredProductionPackagePreviews,
  restoreProductionPackagePreviews,
  clearProductionPackagePreviews,
} from '../src/services/production-package-preview.ts'
import productionPackages, { createProductionPackagesRouter } from '../src/routes/productionPackages.ts'
import { createPreviewSessionAuth, signPreviewIdentity, PREVIEW_AUTH_AUDIENCE, PREVIEW_AUTH_MAX_AGE_MS } from '../src/middleware/preview-auth.ts'
import { previewRequestBodyLimit } from '../src/middleware/preview-request-body.ts'
import { consumePreviewNonce, previewNonceStorePath } from '../src/middleware/preview-nonce-store.ts'

const fixtureRoot = path.join(helpers.PACKAGES_DIR, 'fixture-rain-lantern')
let verifiedIdentity = { tenantId: 'tenant-a', userId: 'route-user' }
const testProductionPackages = createProductionPackagesRouter(() => verifiedIdentity)
const integrationApi = new Hono()
const integrationSecret = Buffer.alloc(32, 7).toString('base64url')
integrationApi.use('/production-packages/*', previewRequestBodyLimit())
integrationApi.use('/production-packages/*', createPreviewSessionAuth(integrationSecret))
integrationApi.route('/production-packages', productionPackages)

afterEach(() => clearProductionPackagePreviews())

async function createSignedRequest(pathname, { method = 'POST', body, tenantId = 'tenant-integration', userId = 'user-a', issuedAt = Date.now(), expiresAt = issuedAt + 60_000, secret = integrationSecret, extraHeaders = {} } = {}) {
  const request = new Request(`http://localhost${pathname}`, { method, body })
  const bodyBytes = await request.clone().arrayBuffer()
  const bodySha256 = crypto.createHash('sha256').update(Buffer.from(bodyBytes)).digest('hex')
  const nonce = crypto.randomBytes(16).toString('base64url')
  const identity = { tenantId, userId, issuedAt, expiresAt, audience: PREVIEW_AUTH_AUDIENCE }
  request.headers.set('x-authenticated-tenant-id', tenantId)
  request.headers.set('x-authenticated-user-id', userId)
  request.headers.set('x-authenticated-issued-at', String(issuedAt))
  request.headers.set('x-authenticated-expires-at', String(expiresAt))
  request.headers.set('x-authenticated-audience', PREVIEW_AUTH_AUDIENCE)
  request.headers.set('x-authenticated-method', method)
  request.headers.set('x-authenticated-path', pathname)
  request.headers.set('x-authenticated-body-sha256', bodySha256)
  request.headers.set('x-authenticated-nonce', nonce)
  request.headers.set('x-authenticated-signature', signPreviewIdentity(identity, secret, { method, path: pathname, bodySha256, nonce }))
  for (const [name, value] of Object.entries(extraHeaders)) request.headers.set(name, value)
  return request
}

async function signedRequest(api, pathname, options = {}) {
  return api.fetch(await createSignedRequest(pathname, options))
}

function runNodeWorker(script, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx/esm', '--eval', script], {
      cwd: path.join(path.dirname(fixtureRoot), '..', '..', '..', '..'),
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve(stdout.trim()) : reject(new Error(`worker exited ${code}: ${stderr}`)))
  })
}

async function zipEntries(entries) {
  const archive = new yazl.ZipFile()
  const output = new PassThrough()
  const chunks = []
  output.on('data', chunk => chunks.push(chunk))
  const done = new Promise((resolve, reject) => {
    output.once('end', resolve)
    output.once('error', reject)
  })
  archive.outputStream.pipe(output)
  for (const [name, content, options] of entries) archive.addBuffer(Buffer.from(content), name, options)
  archive.end()
  await done
  return Buffer.concat(chunks)
}

async function zipAtExactSize(targetBytes) {
  const baseEntries = fixtureEntries()
  const base = await zipEntries(baseEntries)
  const emptyPadding = await zipEntries([
    ...baseEntries,
    ['padding-1.bin', Buffer.alloc(0), { compress: false }],
    ['padding-2.bin', Buffer.alloc(0), { compress: false }],
    ['padding-3.bin', Buffer.alloc(0), { compress: false }],
  ])
  const paddingOverhead = emptyPadding.length - base.length
  const totalPadding = targetBytes - base.length - paddingOverhead
  assert.ok(totalPadding > 0)
  const first = Math.floor(totalPadding / 3)
  const second = Math.floor((totalPadding - first) / 2)
  const sizes = [first, second, totalPadding - first - second]
  const make = () => zipEntries([
    ...baseEntries,
    ...sizes.map((size, index) => [`padding-${index + 1}.bin`, Buffer.alloc(size, 0x41), { compress: false }]),
  ])
  let archive = await make()
  const delta = targetBytes - archive.length
  if (delta) {
    sizes[2] += delta
    archive = await make()
  }
  assert.equal(archive.length, targetBytes)
  return archive
}

function fixtureEntries(prefix = '') {
  const result = []
  const walk = (root, relative = '') => {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(root, rel)
      else if (entry.isFile()) result.push(`${prefix}${rel}`)
    }
  }
  const paths = []
  walk(fixtureRoot)
  for (const rel of result.splice(0)) paths.push(rel.slice(prefix.length))
  for (const rel of paths.sort()) {
    const abs = path.join(fixtureRoot, rel)
    result.push([`${prefix}${rel}`, fs.readFileSync(abs)])
  }
  return result
}

test('ZIP 预览返回 parser DTO 并覆盖为快照 token，重复读取不写正式数据', async () => {
  const preview = await createProductionPackagePreview({ zip: await zipEntries(fixtureEntries()), owner: 'tenant:user-a' })
  assert.equal(preview.status, 'ready')
  assert.equal(preview.can_confirm, true)
  assert.match(preview.preview_token, /^[A-Za-z0-9_-]{32,}$/)
  assert.equal(preview.package.files.length >= 5, true)
  assert.deepEqual(getProductionPackagePreview(preview.preview_token, 'tenant:user-a'), preview)
  assert.throws(() => getProductionPackagePreview(preview.preview_token, 'tenant:user-b'), (error) => error.code === 'PACKAGE_PREVIEW_NOT_FOUND')
})

test('单层包根可解析，路径穿越和根目录歧义在 parser 前阻断', async () => {
  const nested = await zipEntries(fixtureEntries('package/'))
  const preview = await createProductionPackagePreview({ zip: nested, owner: 'u' })
  assert.equal(preview.status, 'ready')
  const safeArchive = await zipEntries([['safe', 'x']])
  const traversal = Buffer.from(safeArchive)
  const safeName = Buffer.from('safe')
  const traversalName = Buffer.from('../x')
  const localNameOffset = traversal.indexOf(safeName)
  traversal.set(traversalName, localNameOffset)
  const centralNameOffset = traversal.indexOf(safeName, localNameOffset + 1)
  traversal.set(traversalName, centralNameOffset)
  await assert.rejects(() => createProductionPackagePreview({ zip: traversal, owner: 'u' }), (error) => ['PACKAGE_ARCHIVE_PATH_INVALID', 'PACKAGE_ARCHIVE_INVALID'].includes(error.code))
  const ambiguous = await zipEntries([['a/drama-package.md', 'x'], ['b/source-manifest.md', 'x']])
  await assert.rejects(() => createProductionPackagePreview({ zip: ambiguous, owner: 'u' }), (error) => error.code === 'PACKAGE_ARCHIVE_ROOT_AMBIGUOUS')
})

test('嵌套归档、超大上传和快照不存在返回稳定错误码', async () => {
  const nestedArchive = await zipEntries([['nested.zip', 'not another package']])
  await assert.rejects(() => createProductionPackagePreview({ zip: nestedArchive, owner: 'u' }), (error) => error.code === 'PACKAGE_ARCHIVE_NESTED')
  await assert.rejects(() => createProductionPackagePreview({ zip: Buffer.alloc(PREVIEW_LIMITS.maxUploadBytes + 1), owner: 'u' }), (error) => error.code === 'PACKAGE_ARCHIVE_LIMIT')
  assert.throws(() => getProductionPackagePreview('missing', 'u'), (error) => error.code === 'PACKAGE_PREVIEW_NOT_FOUND')
})

test('过期清理会删除快照并阻止继续读取', async () => {
  const preview = await createProductionPackagePreview({ zip: await zipEntries(fixtureEntries()), owner: 'u' })
  assert.equal(cleanupExpiredProductionPackagePreviews(Date.now() + PREVIEW_LIMITS.ttlMs + 1), 1)
  assert.throws(() => getProductionPackagePreview(preview.preview_token, 'u'), (error) => error.code === 'PACKAGE_PREVIEW_NOT_FOUND')
})

test('快照元数据持久化原始 ZIP，启动扫描可恢复未过期 token', async () => {
  const zip = await zipEntries(fixtureEntries())
  const preview = await createProductionPackagePreview({ zip, owner: 'u' })
  const root = path.join(os.tmpdir(), 'jisu-production-package-previews')
  const directories = fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory())
  assert.equal(directories.length, 1)
  const directory = path.join(root, directories[0].name)
  const metadata = JSON.parse(fs.readFileSync(path.join(directory, 'snapshot.json'), 'utf8'))
  assert.equal(metadata.uploadRelative, 'upload.zip')
  assert.equal(typeof metadata.createdAt, 'number')
  assert.equal(metadata.expiresAt > metadata.createdAt, true)
  assert.deepEqual(fs.readFileSync(path.join(directory, metadata.uploadRelative)), zip)
  assert.equal(restoreProductionPackagePreviews(), 1)
  assert.deepEqual(getProductionPackagePreview(preview.preview_token, 'u'), preview)
})

test('写入原始 ZIP 失败时关闭处理并清理未完成快照目录', async () => {
  const root = path.join(os.tmpdir(), 'jisu-production-package-previews')
  fs.mkdirSync(root, { recursive: true })
  const before = new Set(fs.readdirSync(root))
  const archive = await zipEntries(fixtureEntries())
  const originalWriteFileSync = fs.writeFileSync
  fs.writeFileSync = function (target, ...args) {
    if (String(target).endsWith(`${path.sep}upload.zip`)) throw new Error('simulated disk failure')
    return originalWriteFileSync.call(this, target, ...args)
  }
  try {
    await assert.rejects(
      () => createProductionPackagePreview({ zip: archive, owner: 'u' }),
      (error) => error instanceof ProductionPackagePreviewError && error.code === 'PACKAGE_ARCHIVE_INVALID',
    )
  } finally {
    fs.writeFileSync = originalWriteFileSync
  }
  assert.deepEqual(new Set(fs.readdirSync(root)), before)
})

test('parser blocked 结果保留诊断但仍使用传输层快照 token', async () => {
  const entries = fixtureEntries()
  const index = entries.findIndex(([name]) => name === 'drama-package.md')
  entries[index] = [entries[index][0], entries[index][1].toString('utf8').replace('title: 灯下旧物', 'title: "   "')]
  const preview = await createProductionPackagePreview({ zip: await zipEntries(entries), owner: 'u' })
  assert.equal(preview.status, 'blocked')
  assert.equal(preview.can_confirm, false)
  assert.ok(preview.diagnostics.conflicts.some(item => item.field === 'title'))
  assert.equal(getProductionPackagePreview(preview.preview_token, 'u').preview_token, preview.preview_token)
})

test('Preview 路由只接受 ZIP multipart，并返回稳定传输层错误', async () => {
  const form = new FormData()
  form.set('file', new File([await zipEntries(fixtureEntries())], 'fixture.zip', { type: 'application/zip' }))
  const response = await testProductionPackages.request('/preview', { method: 'POST', body: form, headers: { 'x-user-id': 'forged-user', 'x-tenant-id': 'forged-tenant' } })
  assert.equal(response.status, 200)
  const payload = await response.json()
  assert.equal(payload.code, 200)
  assert.match(payload.data.preview_token, /^[A-Za-z0-9_-]{32,}$/)

  verifiedIdentity = { tenantId: 'tenant-a', userId: 'other-user' }
  const tokenResponse = await testProductionPackages.request(`/preview/${payload.data.preview_token}`, { headers: { 'x-user-id': 'route-user', 'x-tenant-id': 'tenant-a' } })
  assert.equal(tokenResponse.status, 404)
  assert.deepEqual(await tokenResponse.json(), {
    code: 'PACKAGE_PREVIEW_NOT_FOUND',
    severity: 'error',
    message: '预览不存在',
  })

  verifiedIdentity = { tenantId: 'tenant-a', userId: 'route-user' }
  const forgedIdentityResponse = await testProductionPackages.request(`/preview/${payload.data.preview_token}`, { headers: { 'x-user-id': 'other-user', 'x-tenant-id': 'other-tenant' } })
  assert.equal(forgedIdentityResponse.status, 200)

  const invalidResponse = await testProductionPackages.request('/preview', {
    method: 'POST',
    body: new FormData(),
  })
  assert.equal(invalidResponse.status, 400)
  assert.equal((await invalidResponse.json()).severity, 'error')

  const unauthenticatedResponse = await productionPackages.request('/preview', { method: 'POST', body: form })
  assert.equal(unauthenticatedResponse.status, 401)
  assert.equal((await unauthenticatedResponse.json()).code, 'PACKAGE_PREVIEW_UNAUTHORIZED')
})

test('Preview 路由严格校验 multipart 结构，并按 ZIP 原始字节执行 25 MiB 边界', async () => {
  const exactZip = await zipAtExactSize(PREVIEW_LIMITS.maxUploadBytes)
  const exactForm = new FormData()
  exactForm.set('file', new File([exactZip], 'exact.zip', { type: 'application/zip' }))
  const exactResponse = await testProductionPackages.request('/preview', { method: 'POST', body: exactForm })
  assert.equal(exactResponse.status, 200)

  const oversizedZip = await zipAtExactSize(PREVIEW_LIMITS.maxUploadBytes + 1)
  const oversizedForm = new FormData()
  oversizedForm.set('file', new File([oversizedZip], 'oversized.zip', { type: 'application/zip' }))
  const oversizedResponse = await testProductionPackages.request('/preview', { method: 'POST', body: oversizedForm })
  assert.equal(oversizedResponse.status, 413)
  assert.equal((await oversizedResponse.json()).code, 'PACKAGE_ARCHIVE_LIMIT')

  const extraFieldForm = new FormData()
  extraFieldForm.set('file', new File([await zipEntries(fixtureEntries())], 'fixture.zip'))
  extraFieldForm.set('unexpected', 'nope')
  const extraFieldResponse = await testProductionPackages.request('/preview', { method: 'POST', body: extraFieldForm })
  assert.equal(extraFieldResponse.status, 400)

  const duplicateFileForm = new FormData()
  const smallZip = new File([await zipEntries(fixtureEntries())], 'fixture.zip')
  duplicateFileForm.append('file', smallZip)
  duplicateFileForm.append('file', smallZip)
  const duplicateFileResponse = await testProductionPackages.request('/preview', { method: 'POST', body: duplicateFileForm })
  assert.equal(duplicateFileResponse.status, 400)

  const nonMultipartResponse = await testProductionPackages.request('/preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ file: 'fixture.zip' }),
  })
  assert.equal(nonMultipartResponse.status, 400)
})

test('主应用默认挂载路径使用上游签名身份，且不同身份不能读取同一 token', async () => {
  const issuedAt = Date.now()
  const expiresAt = issuedAt + 60_000
  const form = new FormData()
  form.set('file', new File([await zipEntries(fixtureEntries())], 'fixture.zip'))
  const response = await signedRequest(integrationApi, '/production-packages/preview', { body: form, tenantId: 'tenant-integration', userId: 'user-a', issuedAt, expiresAt, extraHeaders: { 'x-user-id': 'forged' } })
  assert.equal(response.status, 200)
  const token = (await response.json()).data.preview_token

  const forbidden = await signedRequest(integrationApi, `/production-packages/preview/${token}`, { method: 'GET', tenantId: 'tenant-integration', userId: 'user-b', extraHeaders: { 'x-user-id': 'user-a' } })
  assert.equal(forbidden.status, 404)
  assert.equal((await forbidden.json()).code, 'PACKAGE_PREVIEW_NOT_FOUND')

  const own = await signedRequest(integrationApi, `/production-packages/preview/${token}`, { method: 'GET', tenantId: 'tenant-integration', userId: 'user-a', extraHeaders: { 'x-user-id': 'forged-other' } })
  assert.equal(own.status, 200)

  const infinity = await signedRequest(integrationApi, '/production-packages/preview', { body: form, tenantId: 'tenant-integration', userId: 'user-a', issuedAt, expiresAt: Infinity })
  assert.equal(infinity.status, 401)
  const weakSecretApi = new Hono()
  weakSecretApi.use('/production-packages/*', createPreviewSessionAuth('weak'))
  weakSecretApi.route('/production-packages', productionPackages)
  const weak = await signedRequest(weakSecretApi, '/production-packages/preview', { body: form, tenantId: 'tenant-integration', userId: 'user-a', issuedAt, expiresAt, secret: 'weak' })
  assert.equal(weak.status, 503)
})

test('签名身份 Header 拒绝重复值、非规范签名和非法身份字段', async () => {
  const form = new FormData()
  form.set('file', new File([await zipEntries(fixtureEntries())], 'fixture.zip'))

  const duplicateUserRequest = await createSignedRequest('/production-packages/preview', { body: form })
  const duplicateUserHeaders = duplicateUserRequest.headers
  duplicateUserHeaders.append('x-authenticated-user-id', 'second-user')
  const duplicateUser = await integrationApi.fetch(duplicateUserRequest)
  assert.equal(duplicateUser.status, 401)

  const duplicateSignatureRequest = await createSignedRequest('/production-packages/preview', { body: form })
  duplicateSignatureRequest.headers.append('x-authenticated-signature', duplicateSignatureRequest.headers.get('x-authenticated-signature'))
  const duplicateSignature = await integrationApi.fetch(duplicateSignatureRequest)
  assert.equal(duplicateSignature.status, 401)

  const paddedRequest = await createSignedRequest('/production-packages/preview', { body: form })
  paddedRequest.headers.set('x-authenticated-signature', `${paddedRequest.headers.get('x-authenticated-signature')}=`)
  const paddedSignature = await integrationApi.fetch(paddedRequest)
  assert.equal(paddedSignature.status, 401)

  let standardSignatureRequest = null
  for (let index = 0; index < 10_000 && !standardSignatureRequest; index += 1) {
    const candidate = await createSignedRequest('/production-packages/preview', { body: form, userId: `user-${index}` })
    if (/[-_]/.test(candidate.headers.get('x-authenticated-signature'))) {
      candidate.headers.set('x-authenticated-signature', candidate.headers.get('x-authenticated-signature').replace(/-/g, '+').replace(/_/g, '/'))
      standardSignatureRequest = candidate
    }
  }
  assert.ok(standardSignatureRequest, 'test fixture should contain a URL-unsafe signature character')
  const standardSignature = await integrationApi.fetch(standardSignatureRequest)
  assert.equal(standardSignature.status, 401)

  const invalidIdentityValues = [
    ['tenant with space', 'user-a'],
    [String.fromCharCode(0x80), 'user-a'], // non-ASCII byte rejected by the identity grammar
    ['tenant-a', 'user,with-comma'],
    ['tenant-a', `user-${'x'.repeat(128)}`],
  ]
  for (const [tenantId, userId] of invalidIdentityValues) {
    const response = await signedRequest(integrationApi, '/production-packages/preview', { body: form, tenantId, userId })
    assert.equal(response.status, 401, `${tenantId}/${userId} should be rejected`)
  }
})

test('认证密钥只接受规范且至少 32 字节的 Base64URL', async () => {
  const form = new FormData()
  form.set('file', new File([await zipEntries(fixtureEntries())], 'fixture.zip'))

  const malformedSecrets = [
    Buffer.alloc(32, 0xff).toString('base64'), // standard Base64 (+, / and padding)
    `${integrationSecret}=`, // padded Base64URL
    `${integrationSecret} `, // trailing whitespace
    `${integrationSecret}!`, // non-alphabet character
    Buffer.alloc(31, 7).toString('base64url'), // decodes below the minimum length
  ]
  for (const secret of malformedSecrets) {
    const api = new Hono()
    api.use('/production-packages/*', previewRequestBodyLimit())
    api.use('/production-packages/*', createPreviewSessionAuth(secret))
    api.route('/production-packages', productionPackages)
    const response = await signedRequest(api, '/production-packages/preview', { body: form, secret })
    assert.equal(response.status, 503, `secret should fail closed: ${secret}`)
    assert.equal((await response.json()).code, 'PACKAGE_PREVIEW_AUTH_UNAVAILABLE')
  }

  const validApi = new Hono()
  validApi.use('/production-packages/*', previewRequestBodyLimit())
  validApi.use('/production-packages/*', createPreviewSessionAuth(integrationSecret))
  validApi.route('/production-packages', productionPackages)
  const valid = await signedRequest(validApi, '/production-packages/preview', { body: form })
  assert.equal(valid.status, 200)
})

test('请求绑定阻止跨路径、跨方法、篡改 body 和 nonce 重放', async () => {
  const form = new FormData()
  form.set('file', new File([await zipEntries(fixtureEntries())], 'fixture.zip'))
  const original = await createSignedRequest('/production-packages/preview', { body: form })
  const replay = original.clone()
  const first = await integrationApi.fetch(original)
  assert.equal(first.status, 200)
  const replayed = await integrationApi.fetch(replay)
  assert.equal(replayed.status, 401)

  const wrongPath = await createSignedRequest('/production-packages/preview')
  wrongPath.headers.set('x-authenticated-path', '/production-packages/preview/other-token')
  assert.equal((await integrationApi.fetch(wrongPath)).status, 401)

  const wrongMethod = await createSignedRequest('/production-packages/preview', { body: form })
  wrongMethod.headers.set('x-authenticated-method', 'PUT')
  assert.equal((await integrationApi.fetch(wrongMethod)).status, 401)

  const wrongBodyHash = await createSignedRequest('/production-packages/preview', { body: form })
  wrongBodyHash.headers.set('x-authenticated-body-sha256', '0'.repeat(64))
  assert.equal((await integrationApi.fetch(wrongBodyHash)).status, 401)
})

test('实际 API 在认证前流式拒绝无签名的超限 chunked 请求', async () => {
  process.env.NODE_ENV = 'test'
  process.env.MYSQL_NO_INIT = '1'
  process.env.PREVIEW_AUTH_PROXY_SECRET = integrationSecret
  const { createApi } = await import('../src/index.ts')
  const maxRequestBytes = PREVIEW_LIMITS.maxUploadBytes + 1024 * 1024
  let sent = 0
  const body = new ReadableStream({
    pull(controller) {
      if (sent > maxRequestBytes) {
        controller.close()
        return
      }
      const size = Math.min(1024 * 1024, maxRequestBytes + 1 - sent)
      sent += size
      controller.enqueue(new Uint8Array(size))
    },
  })
  const request = new Request('http://localhost/production-packages/preview', {
    method: 'POST',
    body,
    duplex: 'half',
    headers: { 'content-type': 'multipart/form-data; boundary=chunked-test' },
  })
  const response = await createApi(integrationSecret).fetch(request)
  assert.equal(response.status, 413)
  assert.equal((await response.json()).code, 'PACKAGE_ARCHIVE_LIMIT')
})

test('同一 nonce 在两个 API 实例中只能消费一次', async () => {
  const form = new FormData()
  form.set('file', new File([await zipEntries(fixtureEntries())], 'fixture.zip'))
  const apiA = new Hono()
  apiA.use('/production-packages/*', previewRequestBodyLimit())
  apiA.use('/production-packages/*', createPreviewSessionAuth(integrationSecret))
  apiA.route('/production-packages', productionPackages)
  const apiB = new Hono()
  apiB.use('/production-packages/*', previewRequestBodyLimit())
  apiB.use('/production-packages/*', createPreviewSessionAuth(integrationSecret))
  apiB.route('/production-packages', productionPackages)
  const request = await createSignedRequest('/production-packages/preview', { body: form })
  assert.equal((await apiA.fetch(request.clone())).status, 200)
  assert.equal((await apiB.fetch(request)).status, 401)
})

test('空的 nonce 记录按已消费处理且不会被清理', async () => {
  const previousPath = process.env.PREVIEW_AUTH_NONCE_STORE_PATH
  const previousMaxEntries = process.env.PREVIEW_AUTH_NONCE_MAX_ENTRIES
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'jisu-preview-nonce-empty-'))
  process.env.PREVIEW_AUTH_NONCE_STORE_PATH = root
  process.env.PREVIEW_AUTH_NONCE_MAX_ENTRIES = '10'
  const key = 'tenant-empty\nuser-empty\nnonce-empty'
  const digest = crypto.createHash('sha256').update(key).digest('hex')
  const file = path.join(previewNonceStorePath(), `${digest}.nonce`)
  try {
    await fs.promises.writeFile(file, '', { mode: 0o600 })
    assert.equal(await consumePreviewNonce(key, Date.now() + 60_000), false)
    assert.equal(fs.existsSync(file), true)
  } finally {
    if (previousPath === undefined) delete process.env.PREVIEW_AUTH_NONCE_STORE_PATH
    else process.env.PREVIEW_AUTH_NONCE_STORE_PATH = previousPath
    if (previousMaxEntries === undefined) delete process.env.PREVIEW_AUTH_NONCE_MAX_ENTRIES
    else process.env.PREVIEW_AUTH_NONCE_MAX_ENTRIES = previousMaxEntries
    await fs.promises.rm(root, { recursive: true, force: true })
  }
})

test('并发消费同一 nonce 只有一次成功', async () => {
  const previousPath = process.env.PREVIEW_AUTH_NONCE_STORE_PATH
  const previousMaxEntries = process.env.PREVIEW_AUTH_NONCE_MAX_ENTRIES
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'jisu-preview-nonce-replay-'))
  process.env.PREVIEW_AUTH_NONCE_STORE_PATH = root
  process.env.PREVIEW_AUTH_NONCE_MAX_ENTRIES = '10'
  const key = 'tenant-race\nuser-race\nnonce-race'
  try {
    const results = await Promise.all(Array.from({ length: 32 }, () => consumePreviewNonce(key, Date.now() + 60_000)))
    assert.equal(results.filter(Boolean).length, 1)
    assert.equal((await fs.promises.readdir(root)).filter(name => name.endsWith('.nonce')).length, 1)
  } finally {
    if (previousPath === undefined) delete process.env.PREVIEW_AUTH_NONCE_STORE_PATH
    else process.env.PREVIEW_AUTH_NONCE_STORE_PATH = previousPath
    if (previousMaxEntries === undefined) delete process.env.PREVIEW_AUTH_NONCE_MAX_ENTRIES
    else process.env.PREVIEW_AUTH_NONCE_MAX_ENTRIES = previousMaxEntries
    await fs.promises.rm(root, { recursive: true, force: true })
  }
})

test('独立 Node 进程并发消费同一 nonce 只有一次成功', async () => {
  const previousPath = process.env.PREVIEW_AUTH_NONCE_STORE_PATH
  const previousMaxEntries = process.env.PREVIEW_AUTH_NONCE_MAX_ENTRIES
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'jisu-preview-nonce-process-'))
  const key = 'tenant-process\nuser-process\nnonce-process'
  const script = "import { consumePreviewNonce } from './src/middleware/preview-nonce-store.ts'; const ok = await consumePreviewNonce(process.env.TEST_NONCE_KEY, Date.now() + 60000); process.stdout.write(ok ? '1' : '0')"
  const env = { PREVIEW_AUTH_NONCE_STORE_PATH: root, PREVIEW_AUTH_NONCE_MAX_ENTRIES: '10', TEST_NONCE_KEY: key }
  try {
    const results = await Promise.all(Array.from({ length: 8 }, () => runNodeWorker(script, env)))
    assert.equal(results.filter(value => value === '1').length, 1)
    assert.equal((await fs.promises.readdir(root)).filter(name => name.endsWith('.nonce')).length, 1)
  } finally {
    if (previousPath === undefined) delete process.env.PREVIEW_AUTH_NONCE_STORE_PATH
    else process.env.PREVIEW_AUTH_NONCE_STORE_PATH = previousPath
    if (previousMaxEntries === undefined) delete process.env.PREVIEW_AUTH_NONCE_MAX_ENTRIES
    else process.env.PREVIEW_AUTH_NONCE_MAX_ENTRIES = previousMaxEntries
    await fs.promises.rm(root, { recursive: true, force: true })
  }
})

test('并发创建不同 nonce 不得突破持久化总配额', async () => {
  const previousPath = process.env.PREVIEW_AUTH_NONCE_STORE_PATH
  const previousMaxEntries = process.env.PREVIEW_AUTH_NONCE_MAX_ENTRIES
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'jisu-preview-nonce-quota-'))
  process.env.PREVIEW_AUTH_NONCE_STORE_PATH = root
  process.env.PREVIEW_AUTH_NONCE_MAX_ENTRIES = '1'
  try {
    const results = await Promise.all(Array.from({ length: 32 }, (_, index) =>
      consumePreviewNonce(`tenant-quota\nuser-quota\nnonce-${index}`, Date.now() + 60_000),
    ))
    assert.equal(results.filter(Boolean).length, 1)
    assert.equal((await fs.promises.readdir(root)).filter(name => name.endsWith('.nonce')).length, 1)
  } finally {
    if (previousPath === undefined) delete process.env.PREVIEW_AUTH_NONCE_STORE_PATH
    else process.env.PREVIEW_AUTH_NONCE_STORE_PATH = previousPath
    if (previousMaxEntries === undefined) delete process.env.PREVIEW_AUTH_NONCE_MAX_ENTRIES
    else process.env.PREVIEW_AUTH_NONCE_MAX_ENTRIES = previousMaxEntries
    await fs.promises.rm(root, { recursive: true, force: true })
  }
})

test('独立 Node 进程并发预留请求资源不得突破总预算', async () => {
  const previousPath = process.env.PREVIEW_REQUEST_RESERVATION_PATH
  const previousMaxConcurrent = process.env.PREVIEW_REQUEST_MAX_CONCURRENT
  const previousMaxBytes = process.env.PREVIEW_REQUEST_MAX_SPOOL_BYTES
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'jisu-preview-resource-process-'))
  const script = "import { reservePreviewRequestSlot } from './src/middleware/preview-request-body.ts'; try { const release = await reservePreviewRequestSlot(); process.stdout.write('1'); await new Promise(resolve => setTimeout(resolve, 3000)); await release() } catch (error) { if (error?.code === 'PREVIEW_REQUEST_BUSY') process.stdout.write('0'); else throw error }"
  const env = { PREVIEW_REQUEST_RESERVATION_PATH: root, PREVIEW_REQUEST_MAX_CONCURRENT: '1', PREVIEW_REQUEST_MAX_SPOOL_BYTES: String(26 * 1024 * 1024) }
  try {
    const results = await Promise.all(Array.from({ length: 8 }, () => runNodeWorker(script, env)))
    assert.equal(results.filter(value => value === '1').length, 1)
  } finally {
    if (previousPath === undefined) delete process.env.PREVIEW_REQUEST_RESERVATION_PATH
    else process.env.PREVIEW_REQUEST_RESERVATION_PATH = previousPath
    if (previousMaxConcurrent === undefined) delete process.env.PREVIEW_REQUEST_MAX_CONCURRENT
    else process.env.PREVIEW_REQUEST_MAX_CONCURRENT = previousMaxConcurrent
    if (previousMaxBytes === undefined) delete process.env.PREVIEW_REQUEST_MAX_SPOOL_BYTES
    else process.env.PREVIEW_REQUEST_MAX_SPOOL_BYTES = previousMaxBytes
    await fs.promises.rm(root, { recursive: true, force: true })
  }
})

test('生产 Compose 注入密钥且实际 API 装配在缺密钥时关闭、有效断言时可用', async () => {
  process.env.NODE_ENV = 'test'
  process.env.MYSQL_NO_INIT = '1'
  process.env.PREVIEW_AUTH_PROXY_SECRET = integrationSecret
  const { app, createApi } = await import('../src/index.ts')
  const compose = fs.readFileSync(path.join(path.dirname(fixtureRoot), '..', '..', '..', '..', '..', 'docker-compose.yml'), 'utf8')
  assert.match(compose, /PREVIEW_AUTH_PROXY_SECRET=\$\{PREVIEW_AUTH_PROXY_SECRET:\?\S[\s\S]*secret manager\}/)
  assert.match(compose, /deploy:\s+replicas:\s+1/)
  assert.match(compose, /PREVIEW_AUTH_NONCE_STORE=mysql/)
  assert.match(compose, /PREVIEW_REQUEST_RESOURCE_STORE=mysql/)
  const mysqlSchema = fs.readFileSync(path.join(path.dirname(fixtureRoot), '..', '..', '..', '..', 'src', 'db', 'mysql-schema.ts'), 'utf8')
  assert.match(mysqlSchema, /CREATE TABLE IF NOT EXISTS preview_auth_nonces/)
  assert.match(mysqlSchema, /CREATE TABLE IF NOT EXISTS preview_request_leases/)
  const transportContract = fs.readFileSync(path.join(path.dirname(fixtureRoot), '..', '..', '..', '..', '..', 'docs', 'production-package-zip-transport-v0.1.md'), 'utf8')
  assert.match(transportContract, /SET preview-auth:nonce:<nonce> 1 NX PX/)

  const form = new FormData()
  form.set('file', new File([await zipEntries(fixtureEntries())], 'fixture.zip'))
  const unavailable = await signedRequest(createApi(''), '/production-packages/preview', { body: form })
  assert.equal(unavailable.status, 503)
  assert.equal((await unavailable.json()).code, 'PACKAGE_PREVIEW_AUTH_UNAVAILABLE')

  const configured = await signedRequest(app, '/api/v1/production-packages/preview', { body: form })
  assert.equal(configured.status, 200)
})
