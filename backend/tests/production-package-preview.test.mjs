import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
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
import { createPreviewSessionAuth, signPreviewSession } from '../src/middleware/preview-auth.ts'

const fixtureRoot = path.join(helpers.PACKAGES_DIR, 'fixture-rain-lantern')
let verifiedIdentity = { tenantId: 'tenant-a', userId: 'route-user' }
const testProductionPackages = createProductionPackagesRouter(() => verifiedIdentity)
const integrationApi = new Hono()
integrationApi.use('/production-packages/*', createPreviewSessionAuth('integration-secret'))
integrationApi.route('/production-packages', productionPackages)

afterEach(() => clearProductionPackagePreviews())

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

test('主应用默认挂载路径使用已验证会话身份，且不同身份不能读取同一 token', async () => {
  const session = signPreviewSession({ tenantId: 'tenant-integration', userId: 'user-a', exp: Date.now() + 60_000 }, 'integration-secret')
  const form = new FormData()
  form.set('file', new File([await zipEntries(fixtureEntries())], 'fixture.zip'))
  const response = await integrationApi.request('/production-packages/preview', { method: 'POST', body: form, headers: { cookie: `jisu_session=${session}`, 'x-user-id': 'forged' } })
  assert.equal(response.status, 200)
  const token = (await response.json()).data.preview_token

  const otherSession = signPreviewSession({ tenantId: 'tenant-integration', userId: 'user-b', exp: Date.now() + 60_000 }, 'integration-secret')
  const forbidden = await integrationApi.request(`/production-packages/preview/${token}`, { headers: { cookie: `jisu_session=${otherSession}`, 'x-user-id': 'user-a' } })
  assert.equal(forbidden.status, 404)
  assert.equal((await forbidden.json()).code, 'PACKAGE_PREVIEW_NOT_FOUND')

  const own = await integrationApi.request(`/production-packages/preview/${token}`, { headers: { cookie: `jisu_session=${session}`, 'x-user-id': 'forged-other' } })
  assert.equal(own.status, 200)
})
