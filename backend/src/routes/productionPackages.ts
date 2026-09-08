import { Hono } from 'hono'
import type { Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { success } from '../utils/response.js'
import { createProductionPackagePreview, getProductionPackagePreview, ProductionPackagePreviewError } from '../services/production-package-preview.js'

const app = new Hono()

function ownerOf(c: Context): string {
  const user = c.req.header('x-user-id')?.trim()
  const tenant = c.req.header('x-tenant-id')?.trim()
  return `${tenant || 'default'}:${user || 'anonymous'}`
}

function previewError(c: any, error: unknown) {
  if (error instanceof ProductionPackagePreviewError) return c.json({ code: error.code, message: error.message }, error.status)
  console.error('[production-package-preview]', error)
  return c.json({ code: 'PACKAGE_ARCHIVE_INVALID', message: '生产包无法处理，请重新导出后再试' }, 400)
}

app.use('/preview', bodyLimit({ maxSize: 25 * 1024 * 1024, onError: c => c.json({ code: 'PACKAGE_ARCHIVE_LIMIT', message: 'ZIP 大小不能超过 25 MiB' }, 413) }))

app.post('/preview', async (c) => {
  try {
    const body = await c.req.parseBody()
    const file = body.file
    if (!(file instanceof File)) return c.json({ code: 'PACKAGE_ARCHIVE_INVALID', message: '请上传一个 ZIP 文件' }, 400)
    if (!file.name.toLowerCase().endsWith('.zip')) return c.json({ code: 'PACKAGE_ARCHIVE_INVALID', message: '仅支持 ZIP 文件' }, 400)
    const bytes = Buffer.from(await file.arrayBuffer())
    const preview = await createProductionPackagePreview({ zip: bytes, owner: ownerOf(c) })
    return success(c, preview)
  } catch (error) { return previewError(c, error) }
})

app.get('/preview/:token', (c) => {
  try { return success(c, getProductionPackagePreview(c.req.param('token'), ownerOf(c))) }
  catch (error) { return previewError(c, error) }
})

export default app
