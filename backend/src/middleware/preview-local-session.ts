import crypto from 'node:crypto'
import type { MiddlewareHandler } from 'hono'
import { getCookie, getSignedCookie, setSignedCookie } from 'hono/cookie'
import type { VerifiedPreviewIdentity } from '../routes/productionPackages.js'

const COOKIE_NAME = 'jisu_preview_session'
const COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60
const LOCAL_ORIGIN_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])
let developmentSecret: string | null = null

function configuredSecret(secret: string | undefined): string | null {
  if (secret) {
    if (!/^[A-Za-z0-9_-]+$/.test(secret)) return null
    try {
      const decoded = Buffer.from(secret, 'base64url')
      if (decoded.length >= 32 && decoded.toString('base64url') === secret) return secret
    } catch { /* fail closed below */ }
    return null
  }
  // Development is explicitly local-only. An ephemeral secret gives the HMR
  // stack a safe default without introducing a reusable production credential.
  if (process.env.NODE_ENV === 'development') {
    developmentSecret ??= crypto.randomBytes(32).toString('base64url')
    return developmentSecret
  }
  return null
}

function isAllowedLocalOrigin(origin: string | undefined, allowedOrigins: readonly string[]): boolean {
  // Non-browser integration clients have no Origin. They still need a valid
  // HttpOnly cookie and cannot impersonate another session from headers.
  if (!origin) return true
  if (!allowedOrigins.includes(origin)) return false
  try { return LOCAL_ORIGIN_HOSTS.has(new URL(origin).hostname) } catch { return false }
}

function identityFor(sessionId: string, secret: string): VerifiedPreviewIdentity {
  const digest = crypto.createHmac('sha256', Buffer.from(secret, 'base64url')).update(`jisu-local-preview-session\n${sessionId}`).digest('base64url')
  return { tenantId: 'local', userId: `local-${digest}` }
}

export type LocalPreviewSessionOptions = {
  allowedOrigins: readonly string[]
  secureCookie?: boolean
}

/**
 * Local single-user authentication for the packaged desktop/LAN-local stack.
 * The browser receives only an HttpOnly signed cookie; identity headers and
 * PREVIEW_AUTH_PROXY_SECRET never cross the browser boundary. Public or
 * non-local deployments must use the existing trusted-gateway mode instead.
 */
export function createLocalPreviewSessionAuth(secret: string | undefined, options: LocalPreviewSessionOptions): MiddlewareHandler {
  const key = configuredSecret(secret)
  return async (c, next) => {
    if (!key) return c.json({ code: 'PACKAGE_PREVIEW_AUTH_UNAVAILABLE', severity: 'error', message: '本地预览会话密钥未配置' }, 503)
    if (!isAllowedLocalOrigin(c.req.header('origin'), options.allowedOrigins)) {
      return c.json({ code: 'PACKAGE_PREVIEW_FORBIDDEN', severity: 'error', message: '本地预览仅允许受信任的回环来源' }, 403)
    }

    const rawCookie = getCookie(c, COOKIE_NAME)
    const existing = await getSignedCookie(c, key, COOKIE_NAME)
    if (existing === false || (rawCookie && !existing)) return c.json({ code: 'PACKAGE_PREVIEW_UNAUTHORIZED', severity: 'error', message: '本地预览会话无效，请刷新后重试' }, 401)

    const sessionId = existing || crypto.randomBytes(32).toString('base64url')
    if (!existing) {
      await setSignedCookie(c, COOKIE_NAME, sessionId, key, {
        httpOnly: true,
        sameSite: 'Strict',
        secure: options.secureCookie === true,
        path: '/api/v1/production-packages',
        maxAge: COOKIE_MAX_AGE_SECONDS,
      })
    }
    c.set('verifiedPreviewIdentity', identityFor(sessionId, key))
    await next()
  }
}
