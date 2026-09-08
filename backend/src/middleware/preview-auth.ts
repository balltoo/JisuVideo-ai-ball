import crypto from 'node:crypto'
import type { MiddlewareHandler } from 'hono'
import type { VerifiedPreviewIdentity } from '../routes/productionPackages.js'

const SESSION_COOKIE = 'jisu_session'

export type SignedSession = VerifiedPreviewIdentity & { exp: number }

function decodePart(part: string): string {
  return Buffer.from(part, 'base64url').toString('utf8')
}

function verifySession(value: string, secret: string, now = Date.now()): VerifiedPreviewIdentity | null {
  const [payloadPart, signaturePart] = value.split('.')
  if (!payloadPart || !signaturePart) return null
  const expected = crypto.createHmac('sha256', secret).update(payloadPart).digest()
  let supplied: Buffer
  try { supplied = Buffer.from(signaturePart, 'base64url') } catch { return null }
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return null
  try {
    const session = JSON.parse(decodePart(payloadPart)) as Partial<SignedSession>
    if (typeof session.tenantId !== 'string' || !session.tenantId.trim() || typeof session.userId !== 'string' || !session.userId.trim() || typeof session.exp !== 'number' || session.exp <= now) return null
    return { tenantId: session.tenantId.trim(), userId: session.userId.trim() }
  } catch { return null }
}

function cookieValue(header: string | undefined, name: string): string | null {
  if (!header) return null
  for (const item of header.split(';')) {
    const index = item.indexOf('=')
    if (index < 0 || item.slice(0, index).trim() !== name) continue
    return item.slice(index + 1).trim()
  }
  return null
}

/**
 * Verify the server-issued signed session before production-package routes.
 * No client-supplied identity header is accepted. The secret must be supplied
 * through PREVIEW_SESSION_SECRET; without it the protected route stays closed.
 */
export function createPreviewSessionAuth(secret = process.env.PREVIEW_SESSION_SECRET): MiddlewareHandler {
  return async (c, next) => {
    const identity = secret ? verifySession(cookieValue(c.req.header('cookie'), SESSION_COOKIE) || '', secret) : null
    if (!identity) {
      return c.json({ code: 'PACKAGE_PREVIEW_UNAUTHORIZED', severity: 'error', message: '需要已验证的登录身份' }, 401)
    }
    c.set('verifiedPreviewIdentity', identity)
    await next()
  }
}

export function signPreviewSession(session: SignedSession, secret: string): string {
  const payload = Buffer.from(JSON.stringify(session), 'utf8').toString('base64url')
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url')
  return `${payload}.${signature}`
}
