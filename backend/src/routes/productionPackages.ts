import { Hono } from 'hono'
import type { Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { success } from '../utils/response.js'
import { createProductionPackagePreview, getProductionPackagePreview, ProductionPackagePreviewError, PREVIEW_LIMITS } from '../services/production-package-preview.js'
import { MAX_PREVIEW_REQUEST_BYTES } from '../middleware/preview-request-body.js'

export type VerifiedPreviewIdentity = {
  tenantId: string
  userId: string
}

export type PreviewIdentityResolver = (c: Context) => VerifiedPreviewIdentity | null

/**
 * The application auth middleware must attach a verified identity to the
 * request context. Client-controlled x-user-id/x-tenant-id headers are never
 * consulted here. Until auth middleware is wired, the endpoint is denied.
 */
const identityFromAuthContext: PreviewIdentityResolver = (c) => {
  const context = c as unknown as { get: (key: string) => unknown }
  const value = context.get('verifiedPreviewIdentity')
  if (!value || typeof value !== 'object') return null
  const identity = value as Partial<VerifiedPreviewIdentity>
  if (typeof identity.tenantId !== 'string' || !identity.tenantId.trim() || typeof identity.userId !== 'string' || !identity.userId.trim()) return null
  return { tenantId: identity.tenantId.trim(), userId: identity.userId.trim() }
}

function ownerOf(identity: VerifiedPreviewIdentity): string {
  return JSON.stringify([identity.tenantId, identity.userId])
}

function previewError(c: any, error: unknown) {
  if (error instanceof ProductionPackagePreviewError) return c.json({ code: error.code, severity: 'error', message: error.message }, error.status)
  console.error('[production-package-preview]', error)
  return c.json({ code: 'PACKAGE_ARCHIVE_INVALID', severity: 'error', message: '生产包无法处理，请重新导出后再试' }, 400)
}

export function createProductionPackagesRouter(resolveIdentity: PreviewIdentityResolver = identityFromAuthContext) {
  const app = new Hono()
  app.use('/preview', bodyLimit({ maxSize: MAX_PREVIEW_REQUEST_BYTES, onError: c => c.json({ code: 'PACKAGE_ARCHIVE_LIMIT', severity: 'error', message: '上传请求超过允许大小' }, 413) }))

  app.post('/preview', async (c) => {
    try {
      const identity = resolveIdentity(c)
      if (!identity) return c.json({ code: 'PACKAGE_PREVIEW_UNAUTHORIZED', severity: 'error', message: '需要已验证的登录身份' }, 401)
      const contentType = c.req.header('content-type')?.toLowerCase() || ''
      if (!contentType.startsWith('multipart/form-data;')) return c.json({ code: 'PACKAGE_ARCHIVE_INVALID', severity: 'error', message: '必须使用 multipart/form-data 上传 ZIP' }, 400)
      const body = await c.req.parseBody({ all: true })
      const keys = Object.keys(body)
      if (keys.length !== 1 || keys[0] !== 'file') return c.json({ code: 'PACKAGE_ARCHIVE_INVALID', severity: 'error', message: '请求只能包含一个名为 file 的 ZIP 文件' }, 400)
      const file = body.file
      if (Array.isArray(file) || !(file instanceof File)) return c.json({ code: 'PACKAGE_ARCHIVE_INVALID', severity: 'error', message: '请上传一个 ZIP 文件' }, 400)
      if (!file.name.toLowerCase().endsWith('.zip')) return c.json({ code: 'PACKAGE_ARCHIVE_INVALID', severity: 'error', message: '仅支持 ZIP 文件' }, 400)
      if (file.size > PREVIEW_LIMITS.maxUploadBytes) return c.json({ code: 'PACKAGE_ARCHIVE_LIMIT', severity: 'error', message: 'ZIP 大小不能超过 25 MiB' }, 413)
      const bytes = Buffer.from(await file.arrayBuffer())
      if (bytes.length > PREVIEW_LIMITS.maxUploadBytes) return c.json({ code: 'PACKAGE_ARCHIVE_LIMIT', severity: 'error', message: 'ZIP 大小不能超过 25 MiB' }, 413)
      const preview = await createProductionPackagePreview({ zip: bytes, owner: ownerOf(identity) })
      return success(c, preview)
    } catch (error) { return previewError(c, error) }
  })

  app.get('/preview/:token', (c) => {
    try {
      const identity = resolveIdentity(c)
      if (!identity) return c.json({ code: 'PACKAGE_PREVIEW_UNAUTHORIZED', severity: 'error', message: '需要已验证的登录身份' }, 401)
      return success(c, getProductionPackagePreview(c.req.param('token'), ownerOf(identity)))
    } catch (error) { return previewError(c, error) }
  })

  return app
}

export default createProductionPackagesRouter()
