import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ProductionPackageImportError, validateProductionPackageImportInput } from '../src/services/production-package-import.ts'

const fingerprints = {
  targetMode: 'new_project',
  packageFingerprint: `sha256:${'a'.repeat(64)}`,
  validationFingerprint: `sha256:${'b'.repeat(64)}`,
}

test('Confirm 接受现有 Preview 发出的裸 Base64URL token，也兼容 pv_ token', () => {
  const common = { owner: 'tenant:user', idempotencyKey: 'confirm-001', ...fingerprints }
  assert.doesNotThrow(() => validateProductionPackageImportInput({ ...common, token: 'A'.repeat(32) }))
  assert.doesNotThrow(() => validateProductionPackageImportInput({ ...common, token: `pv_${'A'.repeat(32)}` }))
})

test('Confirm 仍拒绝短 token 和非法幂等键', () => {
  const common = { owner: 'tenant:user', idempotencyKey: 'confirm-001', ...fingerprints }
  assert.throws(() => validateProductionPackageImportInput({ ...common, token: 'too-short' }), ProductionPackageImportError)
  assert.throws(() => validateProductionPackageImportInput({ ...common, token: 'A'.repeat(32), idempotencyKey: 'contains whitespace' }), ProductionPackageImportError)
})

test('Confirm 拒绝缺失或格式非法的 target_mode（契约 §5.2 必填）', () => {
  const common = { owner: 'tenant:user', idempotencyKey: 'confirm-001', token: 'A'.repeat(32), ...fingerprints }
  // 缺失（undefined）与空串都必须拒绝；支持性校验（existing_project/未知 mode）
  // 不在格式层，留给服务层在幂等身份比对之后判定。
  assert.throws(() => validateProductionPackageImportInput({ ...common, targetMode: undefined }), ProductionPackageImportError)
  assert.throws(() => validateProductionPackageImportInput({ ...common, targetMode: '' }), ProductionPackageImportError)
  assert.throws(() => validateProductionPackageImportInput({ ...common, targetMode: 'New Project' }), ProductionPackageImportError)
  assert.doesNotThrow(() => validateProductionPackageImportInput({ ...common, targetMode: 'existing_project' }))
})
