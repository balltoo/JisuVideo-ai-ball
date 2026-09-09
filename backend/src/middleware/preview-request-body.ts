import type { MiddlewareHandler } from 'hono'
import crypto from 'node:crypto'

// 25 MiB ZIP limit plus a bounded multipart envelope. This guard runs before
// authentication so chunked unauthenticated uploads cannot force an unbounded
// body/hash read.
export const MAX_PREVIEW_REQUEST_BYTES = 25 * 1024 * 1024 + 1024 * 1024
export const PREVIEW_BODY_HASH_CONTEXT_KEY = 'previewRequestBodySha256'

export function previewRequestBodyLimit(): MiddlewareHandler {
  return async (c, next) => {
    const stream = c.req.raw.body
    if (!stream) {
      c.set(PREVIEW_BODY_HASH_CONTEXT_KEY, crypto.createHash('sha256').digest('hex'))
      return next()
    }

    const reader = stream.getReader()
    const chunks: Uint8Array[] = []
    const hash = crypto.createHash('sha256')
    let size = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > MAX_PREVIEW_REQUEST_BYTES) {
          await reader.cancel()
          return c.json({ code: 'PACKAGE_ARCHIVE_LIMIT', severity: 'error', message: '上传请求超过允许大小' }, 413)
        }
        hash.update(value)
        chunks.push(value)
      }
    } catch {
      await reader.cancel().catch(() => undefined)
      return c.json({ code: 'PACKAGE_ARCHIVE_INVALID', severity: 'error', message: '上传请求无法读取' }, 400)
    }

    // Rebuild the request from the bounded bytes for downstream multipart
    // parsing. The auth layer consumes the hash from context and does not clone
    // or buffer the body a second time.
    const body = Buffer.concat(chunks.map(chunk => Buffer.from(chunk)))
    chunks.length = 0
    c.req.raw = new Request(c.req.raw, { body: body.length ? body : null })
    c.set(PREVIEW_BODY_HASH_CONTEXT_KEY, hash.digest('hex'))
    return next()
  }
}
