import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import yazl from 'yazl'

import * as helpers from './fixtures/production-package/helpers.mjs'
import {
  PREVIEW_LIMITS,
  ProductionPackagePreviewError,
  createProductionPackagePreview,
  getProductionPackagePreview,
  cleanupExpiredProductionPackagePreviews,
  clearProductionPackagePreviews,
} from '../src/services/production-package-preview.ts'
import productionPackages from '../src/routes/productionPackages.ts'

const fixtureRoot = path.join(helpers.PACKAGES_DIR, 'fixture-rain-lantern')

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
  for (const [name, content] of entries) archive.addBuffer(Buffer.from(content), name)
  archive.end()
  await done
  return Buffer.concat(chunks)
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
  const response = await productionPackages.request('/preview', { method: 'POST', body: form, headers: { 'x-user-id': 'route-user' } })
  assert.equal(response.status, 200)
  const payload = await response.json()
  assert.equal(payload.code, 200)
  assert.match(payload.data.preview_token, /^[A-Za-z0-9_-]{32,}$/)

  const tokenResponse = await productionPackages.request(`/preview/${payload.data.preview_token}`, { headers: { 'x-user-id': 'other-user' } })
  assert.equal(tokenResponse.status, 404)
  assert.deepEqual(await tokenResponse.json(), {
    code: 'PACKAGE_PREVIEW_NOT_FOUND',
    severity: 'error',
    message: '预览不存在',
  })

  const invalidResponse = await productionPackages.request('/preview', {
    method: 'POST',
    body: new FormData(),
  })
  assert.equal(invalidResponse.status, 400)
  assert.equal((await invalidResponse.json()).severity, 'error')
})
