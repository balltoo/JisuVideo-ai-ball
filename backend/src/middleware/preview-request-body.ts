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
const DEFAULT_MAX_CONCURRENT = 8
const DEFAULT_MAX_RESERVED_BYTES = DEFAULT_MAX_CONCURRENT * MAX_PREVIEW_REQUEST_BYTES
const RESERVATION_STALE_MS = 5 * 60 * 1000
const MYSQL_RESOURCE_LOCK_NAME = 'jisu:preview-request:resource-budget'

function maxConcurrent(): number {
  const parsed = Number(process.env.PREVIEW_REQUEST_MAX_CONCURRENT || DEFAULT_MAX_CONCURRENT)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_CONCURRENT
}

function maxReservedBytes(): number {
  const parsed = Number(process.env.PREVIEW_REQUEST_MAX_SPOOL_BYTES || DEFAULT_MAX_RESERVED_BYTES)
  return Number.isInteger(parsed) && parsed >= MAX_PREVIEW_REQUEST_BYTES ? parsed : DEFAULT_MAX_RESERVED_BYTES
}

function reservationRoot(): string {
  return process.env.PREVIEW_REQUEST_RESERVATION_PATH || path.join(os.tmpdir(), 'jisu-preview-request-reservations')
}
function useMySqlResourceStore(): boolean { return process.env.PREVIEW_REQUEST_RESOURCE_STORE === 'mysql' }
function ownerRecord(): string {
  return JSON.stringify({ host: os.hostname(), pid: process.pid, createdAt: Date.now(), id: crypto.randomBytes(16).toString('hex') })
}
function deadLocalOwner(raw: string): boolean {
  try {
    const owner = JSON.parse(raw) as { host?: string; pid?: number; createdAt?: number }
    const pid = owner.pid
    if (owner.host !== os.hostname() || typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false
    if (!owner.createdAt || Date.now() - owner.createdAt <= RESERVATION_STALE_MS) return false
    const safePid = pid as number
    try { process.kill(safePid, 0); return false } catch (error: any) { return error?.code === 'ESRCH' }
  } catch { return false }
}
async function releaseReservation(root: string, file: string): Promise<void> {
  await fsp.rm(file, { force: true }).catch(() => undefined)
  await fsp.rmdir(root).catch(() => undefined)
}
export async function reservePreviewRequestSlot(): Promise<() => Promise<void>> {
  const root = reservationRoot()
  await fsp.mkdir(root, { recursive: true, mode: 0o700 })
  const slots = Math.min(maxConcurrent(), Math.floor(maxReservedBytes() / MAX_PREVIEW_REQUEST_BYTES))
  for (;;) {
    for (let index = 0; index < slots; index += 1) {
      const file = path.join(root, `${index}.slot`)
      try {
        const handle = await fsp.open(file, 'wx', 0o600)
        try {
          await handle.writeFile(ownerRecord(), 'utf8')
          await handle.sync()
        } catch (error) {
          await handle.close().catch(() => undefined)
          await fsp.rm(file, { force: true }).catch(() => undefined)
          throw error
        }
        await handle.close()
        return () => releaseReservation(root, file)
      } catch (error: any) {
        if (error?.code !== 'EEXIST') throw error
        try {
          const stat = await fsp.stat(file)
          if (Date.now() - stat.mtimeMs > RESERVATION_STALE_MS) {
            const owner = await fsp.readFile(file, 'utf8').catch(() => '')
            if (deadLocalOwner(owner)) {
              const quarantine = `${file}.stale.${process.pid}.${crypto.randomBytes(8).toString('hex')}`
              try { await fsp.rename(file, quarantine); await fsp.rm(quarantine, { force: true }) } catch (reclaimError: any) {
                if (reclaimError?.code !== 'ENOENT') throw reclaimError
              }
            }
          }
        } catch (statError: any) { if (statError?.code !== 'ENOENT') throw statError }
      }
    }
    throw Object.assign(new Error('preview request budget exhausted'), { code: 'PREVIEW_REQUEST_BUSY' })
  }
}

async function reserveRequestSlotMySql(): Promise<(() => Promise<void>) | null> {
  const { pool } = await import('../db/index.js')
  const connection = await pool.getConnection()
  const leaseId = crypto.randomBytes(32).toString('hex')
  try {
    const [lockRows] = await connection.query<any[]>('SELECT GET_LOCK(?, 10) AS acquired', [MYSQL_RESOURCE_LOCK_NAME])
    if (Number(lockRows[0]?.acquired) !== 1) throw Object.assign(new Error('preview resource lock unavailable'), { code: 'PREVIEW_REQUEST_STORE_UNAVAILABLE' })
    try {
      await connection.beginTransaction()
      await connection.query('DELETE FROM preview_request_leases WHERE expires_at <= ?', [Date.now()])
      const [usageRows] = await connection.query<any[]>('SELECT COUNT(*) AS count, COALESCE(SUM(reserved_bytes), 0) AS bytes FROM preview_request_leases')
      const count = Number(usageRows[0]?.count || 0)
      const bytes = Number(usageRows[0]?.bytes || 0)
      if (count >= maxConcurrent() || bytes + MAX_PREVIEW_REQUEST_BYTES > maxReservedBytes()) {
        await connection.rollback()
        return null
      }
      const expiresAt = Date.now() + RESERVATION_STALE_MS
      await connection.query('INSERT INTO preview_request_leases (lease_id, reserved_bytes, expires_at, created_at) VALUES (?, ?, ?, ?)', [leaseId, MAX_PREVIEW_REQUEST_BYTES, expiresAt, new Date().toISOString()])
      await connection.commit()
      const heartbeat = setInterval(() => {
        pool.query('UPDATE preview_request_leases SET expires_at = ? WHERE lease_id = ?', [Date.now() + RESERVATION_STALE_MS, leaseId]).catch(() => undefined)
      }, Math.floor(RESERVATION_STALE_MS / 3))
      heartbeat.unref()
      return async () => {
        clearInterval(heartbeat)
        await pool.query('DELETE FROM preview_request_leases WHERE lease_id = ?', [leaseId]).catch(() => undefined)
      }
    } catch (error) { await connection.rollback().catch(() => undefined); throw error }
    finally { await connection.query('SELECT RELEASE_LOCK(?)', [MYSQL_RESOURCE_LOCK_NAME]).catch(() => undefined) }
  } finally { connection.release() }
}

export function previewRequestBodyLimit(): MiddlewareHandler {
  return async (c, next) => {
    const stream = c.req.raw.body
    if (!stream) {
      c.set(PREVIEW_BODY_HASH_CONTEXT_KEY, crypto.createHash('sha256').digest('hex'))
      return next()
    }

    let releaseReservation: (() => Promise<void>) | null = null
    try {
      releaseReservation = useMySqlResourceStore() ? await reserveRequestSlotMySql() : await reservePreviewRequestSlot()
      if (!releaseReservation) throw Object.assign(new Error('preview request budget exhausted'), { code: 'PREVIEW_REQUEST_BUSY' })
    } catch (error: any) {
      if (error?.code === 'PREVIEW_REQUEST_BUSY') return c.json({ code: 'PACKAGE_PREVIEW_BUSY', severity: 'error', message: '当前上传请求较多，请稍后重试' }, 429)
      return c.json({ code: 'PACKAGE_PREVIEW_BUSY', severity: 'error', message: '上传资源预算暂不可用' }, 503)
    }

    const reader = stream.getReader()
    const hash = crypto.createHash('sha256')
    let size = 0
    let spoolRoot: string | null = null
    let handle: fsp.FileHandle | null = null
    try {
      spoolRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'jisu-preview-request-'))
      const spoolPath = path.join(spoolRoot, 'request.body')
      handle = await fsp.open(spoolPath, 'w')
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > MAX_PREVIEW_REQUEST_BYTES) {
          await reader.cancel()
          await handle.close().catch(() => undefined)
          await fsp.rm(spoolRoot, { recursive: true, force: true }).catch(() => undefined)
          await releaseReservation()
          return c.json({ code: 'PACKAGE_ARCHIVE_LIMIT', severity: 'error', message: '上传请求超过允许大小' }, 413)
        }
        hash.update(value)
        await handle.write(value)
      }
      await handle.close()
    } catch {
      await reader.cancel().catch(() => undefined)
      await handle?.close().catch(() => undefined)
      if (spoolRoot) await fsp.rm(spoolRoot, { recursive: true, force: true }).catch(() => undefined)
      await releaseReservation()
      return c.json({ code: 'PACKAGE_ARCHIVE_INVALID', severity: 'error', message: '上传请求无法读取' }, 400)
    }

    // Rebuild the request from the bounded spool for downstream multipart
    // parsing. The auth layer consumes the hash from context; neither layer
    // needs to clone or retain a second complete body in memory.
    const spoolPath = path.join(spoolRoot!, 'request.body')
    const bodyStream = Readable.toWeb(fs.createReadStream(spoolPath)) as unknown as ReadableStream
    c.req.raw = new Request(c.req.raw, { body: bodyStream, duplex: 'half' } as RequestInit & { duplex: 'half' })
    c.set(PREVIEW_BODY_HASH_CONTEXT_KEY, hash.digest('hex'))
    try {
      return await next()
    } finally {
      await fsp.rm(spoolRoot!, { recursive: true, force: true }).catch(() => undefined)
      await releaseReservation!()
    }
  }
}
