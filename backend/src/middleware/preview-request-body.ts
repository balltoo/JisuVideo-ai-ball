import type { MiddlewareHandler } from 'hono'
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

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
    const hash = crypto.createHash('sha256')
    let size = 0
    const spoolRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'jisu-preview-request-'))
    const spoolPath = path.join(spoolRoot, 'request.body')
    const handle = await fsp.open(spoolPath, 'w')
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > MAX_PREVIEW_REQUEST_BYTES) {
          await reader.cancel()
          await handle.close().catch(() => undefined)
          await fsp.rm(spoolRoot, { recursive: true, force: true }).catch(() => undefined)
          return c.json({ code: 'PACKAGE_ARCHIVE_LIMIT', severity: 'error', message: '上传请求超过允许大小' }, 413)
        }
        hash.update(value)
        await handle.write(value)
      }
      await handle.close()
    } catch {
      await reader.cancel().catch(() => undefined)
      await handle.close().catch(() => undefined)
      await fsp.rm(spoolRoot, { recursive: true, force: true }).catch(() => undefined)
      return c.json({ code: 'PACKAGE_ARCHIVE_INVALID', severity: 'error', message: '上传请求无法读取' }, 400)
    }

    // Rebuild the request from the bounded spool for downstream multipart
    // parsing. The auth layer consumes the hash from context; neither layer
    // needs to clone or retain a second complete body in memory.
    const bodyStream = Readable.toWeb(fs.createReadStream(spoolPath)) as unknown as ReadableStream
    c.req.raw = new Request(c.req.raw, { body: bodyStream, duplex: 'half' } as RequestInit & { duplex: 'half' })
    c.set(PREVIEW_BODY_HASH_CONTEXT_KEY, hash.digest('hex'))
    try {
      return await next()
    } finally {
      await fsp.rm(spoolRoot, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}
