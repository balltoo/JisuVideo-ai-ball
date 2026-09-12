/**
 * Issue #127 回归测试：AI 配置出参脱敏、PUT 空密钥语义、探针密钥回退。
 *
 * 背景：`GET /ai-configs` / `GET /ai-configs/:id` / `POST /ai-configs` 过去把整行配置
 * 原样返回，`api_key` 明文出口（浏览器 DevTools / 截图 / 日志即可获取）。
 *
 * 环境：MYSQL_* 或 DATABASE_URL；未配置 MySQL 时数据库段按仓库既有约定 skip。
 * 运行：cd backend && node --import tsx/esm --test --test-force-exit tests/ai-config-redaction.test.mjs
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { prepareIsolatedMySql } from './fixtures/production-package/mysql-isolate.mjs'

process.env.NODE_ENV = 'test'
process.env.MYSQL_NO_INIT = '1'

const hasMySql = Boolean(process.env.MYSQL_HOST || process.env.DATABASE_URL)
const isolated = hasMySql ? await prepareIsolatedMySql('jisu_ai_cfg') : null

const { default: aiConfigs, maskApiKey, isMaskedApiKey, resolveProbeApiKey, resolveProbeTarget } = await import('../src/routes/aiConfigs.ts')
const { db, schema } = hasMySql ? await import('../src/db/index.ts') : { db: null, schema: null }
const { eq } = await import('drizzle-orm')

const app = new Hono()
app.route('/ai-configs', aiConfigs)

const LONG_KEY = 'sk-live-abcdefghijklmnopqrstuvwxyz-1234'
const SHORT_KEY = 'sk-123456'
const TWENTY_KEY = 'k'.repeat(20)
const TWENTY_ONE_KEY = `${'k'.repeat(15)}${'z'.repeat(6)}`
const MASK = '********'
const MASKED_LONG_KEY = 'sk-liv********'

const call = async (path, init) => {
  const response = await app.fetch(new Request(`http://localhost${path}`, init))
  return { status: response.status, body: await response.json().catch(() => null) }
}
const post = (path, body) => call(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const put = (path, body) => call(path, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

async function createConfig(apiKey, baseUrl = 'https://api.example.com') {
  const res = await post('/ai-configs', {
    service_type: 'text',
    provider: 'openai',
    name: `test-${Date.now()}-${Math.round(Math.random() * 1e6)}`,
    api_key: apiKey,
    base_url: baseUrl,
    model: ['gpt-x'],
  })
  assert.ok([200, 201].includes(res.status), `创建配置失败: ${JSON.stringify(res.body)}`)
  return res.body.data
}

async function storedRow(id) {
  const [row] = await db.select().from(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, id))
  return row
}

test('maskApiKey：≤20 位整体占位，超长只保留前 6 位（不保留尾号）', () => {
  assert.equal(maskApiKey(''), '')
  assert.equal(maskApiKey(null), '')
  assert.equal(maskApiKey(undefined), '')
  assert.equal(maskApiKey(SHORT_KEY), MASK, '短密钥不得保留任何原文字符')
  assert.equal(maskApiKey(TWENTY_KEY), MASK, '20 位仍整体占位（13 位时保留头尾会暴露 77%）')
  assert.equal(maskApiKey(TWENTY_ONE_KEY), 'kkkkkk********', '21 位起只保留前 6 位')
  assert.equal(maskApiKey(TWENTY_ONE_KEY).endsWith('zzzzzz'), false, '不得保留尾号')
  assert.equal(maskApiKey(LONG_KEY), MASKED_LONG_KEY)
  assert.equal(maskApiKey(LONG_KEY).includes(LONG_KEY), false)
})

test('isMaskedApiKey：识别响应掩码，防止掩码被回传后当作新密钥写库', () => {
  assert.equal(isMaskedApiKey('sk-liv********'), true)
  assert.equal(isMaskedApiKey(MASK), true)
  assert.equal(isMaskedApiKey(''), false)
  assert.equal(isMaskedApiKey('sk-real-key-value-1234567890'), false)
  assert.equal(isMaskedApiKey(null), false)
})

test('resolveProbeTarget：不带 id 用请求值；带 id 时地址/厂商/密钥一律取库中值（复核 P0 锁）', async (t) => {
  // 不带 id：与既有行为一致，完全使用请求参数
  const plain = await resolveProbeTarget({
    service_type: 'text',
    provider: 'openai',
    base_url: 'https://requested.example.com',
    api_key: 'sk-requested-key',
  })
  assert.equal(plain.serviceType, 'text')
  assert.equal(plain.provider, 'openai')
  assert.equal(plain.baseUrl, 'https://requested.example.com')
  assert.equal(plain.apiKey, 'sk-requested-key')
  assert.equal(plain.fromStoredConfig, false)

  if (!hasMySql) { t.skip('requires the CI MySQL service'); return }

  const created = await createConfig(LONG_KEY)

  // 攻击者视角：请求体声明自己的公网地址与厂商，服务端必须忽略，一律用库中值
  const target = await resolveProbeTarget({
    id: created.id,
    service_type: 'video',
    provider: 'gemini',
    base_url: 'https://attacker.example.com',
    api_key: '',
  })
  assert.equal(target.baseUrl, 'https://api.example.com', '必须使用库中 base_url，不得采信请求体')
  assert.equal(target.provider, 'openai', '必须使用库中 provider')
  assert.equal(target.serviceType, 'text', '必须使用库中 service_type')
  assert.equal(target.apiKey, LONG_KEY, '未带明文时回退库中密钥')
  assert.equal(target.fromStoredConfig, true)

  // 请求把响应掩码原样回传时，不得把掩码当明文密钥使用
  const withMask = await resolveProbeTarget({ id: created.id, api_key: maskApiKey(LONG_KEY) })
  assert.equal(withMask.apiKey, LONG_KEY)

  // 显式提供新密钥时仍用库中地址（安全优先），但密钥取新值
  const withNewKey = await resolveProbeTarget({ id: created.id, api_key: 'sk-brand-new-key-0123456789' })
  assert.equal(withNewKey.apiKey, 'sk-brand-new-key-0123456789')
  assert.equal(withNewKey.baseUrl, 'https://api.example.com')

  assert.equal(await resolveProbeTarget({ id: 999999 }), null)
})

test('resolveProbeApiKey：请求带明文时优先请求值，未带时回退库中密钥', () => {
  assert.equal(resolveProbeApiKey('sk-provided', 'sk-stored'), 'sk-provided')
  assert.equal(resolveProbeApiKey('', 'sk-stored'), 'sk-stored')
  assert.equal(resolveProbeApiKey(undefined, 'sk-stored'), 'sk-stored')
  assert.equal(resolveProbeApiKey('', null), '')
})

test('配置接口出参不返回明文密钥（列表 / 详情 / 创建）', async (t) => {
  if (!hasMySql) { t.skip('requires the CI MySQL service'); return }

  const created = await createConfig(LONG_KEY)
  assert.equal(created.api_key, MASKED_LONG_KEY, '创建响应必须脱敏')

  const list = await call('/ai-configs')
  const listed = list.body.data.find(c => c.id === created.id)
  assert.ok(listed, '列表应包含刚创建的配置')
  assert.equal(listed.api_key, MASKED_LONG_KEY)
  assert.equal(JSON.stringify(list.body).includes(LONG_KEY), false, '列表响应不得包含明文密钥')

  const detail = await call(`/ai-configs/${created.id}`)
  assert.equal(detail.body.data.api_key, MASKED_LONG_KEY)
  assert.equal(JSON.stringify(detail.body).includes(LONG_KEY), false, '详情响应不得包含明文密钥')

  const shortCreated = await createConfig(SHORT_KEY)
  assert.equal(shortCreated.api_key, MASK, '短密钥必须整体占位')
  assert.equal(JSON.stringify(shortCreated).includes(SHORT_KEY), false, '创建响应不得包含明文密钥')
})

test('PUT：空串与未提供表示不修改、非空表示更新、null 表示清空', async (t) => {
  if (!hasMySql) { t.skip('requires the CI MySQL service'); return }

  const created = await createConfig(LONG_KEY)

  // 空串 = 不修改（脱敏后前端不回填明文时的默认路径），其它字段正常更新
  await put(`/ai-configs/${created.id}`, { name: 'renamed-by-test', api_key: '' })
  let row = await storedRow(created.id)
  assert.equal(row.apiKey, LONG_KEY, '空 api_key 不得清空已存密钥')
  assert.equal(row.name, 'renamed-by-test', '其它字段应正常更新')

  // 完全不传 api_key = 不修改
  await put(`/ai-configs/${created.id}`, { priority: 3 })
  row = await storedRow(created.id)
  assert.equal(row.apiKey, LONG_KEY)

  // 把响应里的掩码原样回传 = 不修改（防御纵深，复核 P2-2）
  await put(`/ai-configs/${created.id}`, { api_key: maskApiKey(LONG_KEY) })
  row = await storedRow(created.id)
  assert.equal(row.apiKey, LONG_KEY, '掩码回显不得覆盖真实密钥')

  // 非空 = 更新
  const NEW_KEY = 'sk-new-abcdefghijklmnop-9999'
  await put(`/ai-configs/${created.id}`, { api_key: NEW_KEY })
  row = await storedRow(created.id)
  assert.equal(row.apiKey, NEW_KEY)

  // null = 显式清空
  await put(`/ai-configs/${created.id}`, { api_key: null })
  row = await storedRow(created.id)
  assert.equal(row.apiKey, '', 'null 应显式清空密钥')
})

test('探针接口：带 id 时使用库中地址与密钥（忽略请求体地址），响应不泄露密钥', async (t) => {
  if (!hasMySql) { t.skip('requires the CI MySQL service'); return }

  // 库中 base_url 指向私网：SSRF 防护会拒绝，从而可在不真正联网的前提下走完探针分支；
  // 请求体故意声明攻击者公网地址，用于验证服务端确实忽略了它（复核 P0 的接口级锁）。
  const created = await createConfig(LONG_KEY, 'https://127.0.0.1:1/v1')
  const res = await post('/ai-configs/test', {
    id: created.id,
    service_type: 'text',
    provider: 'openai',
    api_key: '',
    base_url: 'https://attacker.example.com',
  })
  assert.ok(res.body, '探针应返回结构化结果，而不是因缺密钥提前失败')
  assert.equal(res.status, 200)
  assert.equal(res.body.data.ok, false)
  // 只有真正使用了库中的私网地址才会命中安全策略；若采信请求体地址则会去访问公网域名
  assert.match(String(res.body.data.message || ''), /安全策略/, `探针必须使用库中地址: ${JSON.stringify(res.body.data)}`)
  assert.equal(JSON.stringify(res.body).includes(LONG_KEY), false, '探针响应不得包含明文密钥')
})

after(async () => {
  if (isolated) await isolated.cleanup()
})
