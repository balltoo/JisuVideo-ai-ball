import crypto from 'node:crypto'
import type { MiddlewareHandler } from 'hono'
import type { VerifiedPreviewIdentity } from '../routes/productionPackages.js'

const AUTHENTICATED_TENANT = 'x-authenticated-tenant-id'
const AUTHENTICATED_USER = 'x-authenticated-user-id'
const AUTHENTICATED_IAT = 'x-authenticated-issued-at'
const AUTHENTICATED_EXP = 'x-authenticated-expires-at'
const AUTHENTICATED_AUDIENCE = 'x-authenticated-audience'
const AUTHENTICATED_SIGNATURE = 'x-authenticated-signature'
export const PREVIEW_AUTH_AUDIENCE = 'production-package-preview'
export const PREVIEW_AUTH_MAX_AGE_MS = 30 * 60 * 1000
const CLOCK_SKEW_MS = 30_000

export type TrustedPreviewIdentity = VerifiedPreviewIdentity & {
  issuedAt: number
  expiresAt: number
  audience: typeof PREVIEW_AUTH_AUDIENCE
}

function validSecret(secret: string | undefined): Buffer | null {
  if (!secret) return null
  try {
    const decoded = Buffer.from(secret, 'base64url')
    return decoded.length >= 32 ? decoded : null
  } catch { return null }
}

function header(c: Parameters<MiddlewareHandler>[0], name: string): string | null {
  const value = c.req.header(name)?.trim()
  return value || null
}

function finiteNumber(value: string | null): number | null {
  if (!value || !/^\d+(?:\.\d+)?$/.test(value)) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function verifyTrustedIdentity(c: Parameters<MiddlewareHandler>[0], secret: Buffer, now = Date.now()): VerifiedPreviewIdentity | null {
  const tenantId = header(c, AUTHENTICATED_TENANT)
  const userId = header(c, AUTHENTICATED_USER)
  const audience = header(c, AUTHENTICATED_AUDIENCE)
  const issuedAt = finiteNumber(header(c, AUTHENTICATED_IAT))
  const expiresAt = finiteNumber(header(c, AUTHENTICATED_EXP))
  const signature = header(c, AUTHENTICATED_SIGNATURE)
  if (!tenantId || !userId || audience !== PREVIEW_AUTH_AUDIENCE || issuedAt === null || expiresAt === null || !signature) return null
  if (issuedAt > now + CLOCK_SKEW_MS || expiresAt <= now || expiresAt > now + PREVIEW_AUTH_MAX_AGE_MS || now - issuedAt > PREVIEW_AUTH_MAX_AGE_MS + CLOCK_SKEW_MS || expiresAt <= issuedAt) return null
  const canonical = `${audience}\n${tenantId}\n${userId}\n${issuedAt}\n${expiresAt}`
  const expected = crypto.createHmac('sha256', secret).update(canonical).digest()
  let supplied: Buffer
  try { supplied = Buffer.from(signature, 'base64url') } catch { return null }
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return null
  return { tenantId, userId }
}

/**
 * Verify an identity assertion signed by the trusted auth gateway/host.
 * Client-controlled x-user-id/x-tenant-id headers are deliberately ignored.
 * An absent or weak PREVIEW_AUTH_PROXY_SECRET keeps the endpoint closed.
 */
export function createPreviewSessionAuth(secret = process.env.PREVIEW_AUTH_PROXY_SECRET): MiddlewareHandler {
  const key = validSecret(secret)
  return async (c, next) => {
    if (!key) return c.json({ code: 'PACKAGE_PREVIEW_AUTH_UNAVAILABLE', severity: 'error', message: '预览认证服务未配置' }, 503)
    const identity = verifyTrustedIdentity(c, key)
    if (!identity) return c.json({ code: 'PACKAGE_PREVIEW_UNAUTHORIZED', severity: 'error', message: '需要上游认证网关提供有效身份' }, 401)
    c.set('verifiedPreviewIdentity', identity)
    await next()
  }
}

/** Test/integration helper representing the trusted gateway signer. */
export function signPreviewIdentity(identity: TrustedPreviewIdentity, secret: string): string {
  const canonical = `${identity.audience}\n${identity.tenantId}\n${identity.userId}\n${identity.issuedAt}\n${identity.expiresAt}`
  return crypto.createHmac('sha256', validSecret(secret) || Buffer.from(secret)).update(canonical).digest('base64url')
}
