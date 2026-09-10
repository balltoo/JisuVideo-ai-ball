import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { Hono } from 'hono'

process.env.NODE_ENV = 'test'

const { createLocalPreviewSessionAuth } = await import('../src/middleware/preview-local-session.ts')
const secret = crypto.randomBytes(32).toString('base64url')

function createApp(sessionSecret = secret) {
  const app = new Hono()
  app.use('/production-packages/*', createLocalPreviewSessionAuth(sessionSecret, {
    allowedOrigins: ['http://localhost:3013', 'http://localhost:5679'],
  }))
  app.post('/production-packages/preview', c => {
    const identity = c.get('verifiedPreviewIdentity')
    return c.json({ tenantId: identity.tenantId, userId: identity.userId })
  })
  return app
}

test('本地会话：服务端签发 HttpOnly cookie，忽略客户端伪造身份头', async () => {
  const app = createApp()
  const response = await app.request('/production-packages/preview', {
    method: 'POST',
    headers: {
      origin: 'http://localhost:3013',
      'x-authenticated-tenant-id': 'forged-tenant',
      'x-authenticated-user-id': 'forged-user',
    },
  })
  assert.equal(response.status, 200)
  const identity = await response.json()
  assert.equal(identity.tenantId, 'local')
  assert.match(identity.userId, /^local-[A-Za-z0-9_-]+$/)
  const cookie = response.headers.get('set-cookie')
  assert.ok(cookie)
  assert.match(cookie, /HttpOnly/i)
  assert.match(cookie, /SameSite=Strict/i)
  assert.match(cookie, /Path=\/api\/v1\/production-packages/i)
})

test('本地会话：同一签名 cookie 稳定复用身份，篡改 cookie fail closed', async () => {
  const app = createApp()
  const first = await app.request('/production-packages/preview', { method: 'POST', headers: { origin: 'http://localhost:3013' } })
  const cookie = first.headers.get('set-cookie')?.split(';')[0]
  assert.ok(cookie)
  const firstIdentity = await first.json()
  const replay = await app.request('/production-packages/preview', { method: 'POST', headers: { origin: 'http://localhost:3013', cookie } })
  assert.equal(replay.status, 200)
  assert.deepEqual(await replay.json(), firstIdentity)
  const tampered = await app.request('/production-packages/preview', { method: 'POST', headers: { origin: 'http://localhost:3013', cookie: `${cookie}tampered` } })
  assert.equal(tampered.status, 401)
  assert.equal((await tampered.json()).code, 'PACKAGE_PREVIEW_UNAUTHORIZED')
})

test('本地会话：不同会话密钥不可互认，网关密钥不能签发本地会话', async () => {
  const localSecret = crypto.randomBytes(32).toString('base64url')
  const proxySecret = crypto.randomBytes(32).toString('base64url')
  const proxyApp = createApp(proxySecret)
  const proxyResponse = await proxyApp.request('/production-packages/preview', { method: 'POST', headers: { origin: 'http://localhost:3013' } })
  const proxyCookie = proxyResponse.headers.get('set-cookie')?.split(';')[0]
  assert.ok(proxyCookie)
  const localApp = createApp(localSecret)
  const rejected = await localApp.request('/production-packages/preview', { method: 'POST', headers: { origin: 'http://localhost:3013', cookie: proxyCookie } })
  assert.equal(rejected.status, 401)
})

test('本地会话：拒绝无 Origin 与非回环来源，生产模式缺密钥 fail closed', async () => {
  const app = createApp()
  const originless = await app.request('/production-packages/preview', { method: 'POST' })
  assert.equal(originless.status, 403)
  assert.equal((await originless.json()).code, 'PACKAGE_PREVIEW_FORBIDDEN')
  const rejected = await app.request('/production-packages/preview', { method: 'POST', headers: { origin: 'https://example.com' } })
  assert.equal(rejected.status, 403)
  assert.equal((await rejected.json()).code, 'PACKAGE_PREVIEW_FORBIDDEN')
  const unavailable = createApp('')
  const response = await unavailable.request('/production-packages/preview', { method: 'POST', headers: { origin: 'http://localhost:3013' } })
  assert.equal(response.status, 503)
  assert.equal((await response.json()).code, 'PACKAGE_PREVIEW_AUTH_UNAVAILABLE')
})
