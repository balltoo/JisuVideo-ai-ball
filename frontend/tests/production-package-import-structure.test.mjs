import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const page = fs.readFileSync(path.join(root, 'app/pages/index.vue'), 'utf8')
const api = fs.readFileSync(path.join(root, 'app/composables/useApi.ts'), 'utf8')

test('project creation exposes a ZIP production-package preview flow', () => {
  assert.match(page, /导入生产包/)
  assert.match(page, /accept="\.zip,application\/zip"/)
  assert.match(page, /productionPackageAPI\.preview\(file\)/)
  assert.match(page, /productionPackageAPI\.confirm\(/)
  assert.match(page, /productionPackagePreview\.project/)
  assert.match(page, /diagnostics\.missing/)
  assert.match(page, /diagnostics\.conflicts/)
  assert.match(page, /diagnostics\.warnings/)
  assert.match(page, /!productionPackagePreview\?\.can_confirm/)
})

test('production-package confirmation carries both fingerprints and an idempotency key', () => {
  assert.match(page, /preview_token: preview\.preview_token/)
  assert.match(page, /package_fingerprint: preview\.package\.package_fingerprint/)
  assert.match(page, /validation_fingerprint: preview\.package\.validation_fingerprint/)
  assert.match(page, /idempotency_key: productionPackageIdempotencyKey\.value/)
})

test('production-package API uploads multipart FormData and uses shared preview endpoints', () => {
  assert.match(api, /function productionPackagePreviewReq/)
  assert.match(api, /new FormData\(\)/)
  assert.match(api, /fd\.append\('file', file\)/)
  assert.match(api, /production-packages\/preview/)
  assert.match(api, /production-packages\/import\/confirm/)
  assert.match(api, /credentials: 'same-origin'/)
})

test('production-package errors preserve actionable retry guidance', () => {
  assert.match(page, /PACKAGE_PREVIEW_UNAUTHORIZED/)
  assert.match(page, /PACKAGE_PREVIEW_AUTH_UNAVAILABLE/)
  assert.match(page, /PACKAGE_PREVIEW_EXPIRED/)
  assert.match(page, /PACKAGE_SNAPSHOT_MISMATCH/)
  assert.match(page, /PACKAGE_IMPORT_IN_PROGRESS/)
  assert.match(page, /PACKAGE_IMPORT_IDEMPOTENCY_CONFLICT/)
  assert.match(page, /PACKAGE_IMPORT_FAILED/)
  assert.match(page, /productionPackageError/)
})

test('production-package auth errors explain session or service recovery', () => {
  assert.match(page, /登录会话已失效或跨域配置异常，请刷新页面重新登录。/)
  assert.match(page, /预览会话服务暂不可用，请稍后重试。/)
  assert.match(page, /请点“返回重新选择”重新上传，以使用新的幂等键。/)
})
