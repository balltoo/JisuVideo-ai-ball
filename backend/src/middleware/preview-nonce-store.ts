import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const DEFAULT_TTL_MS = 30 * 60 * 1000 + 30_000
const CLEANUP_INTERVAL_MS = 60_000
const DEFAULT_MAX_ENTRIES = 100_000
const LOCK_STALE_MS = 60_000
const LOCK_HEARTBEAT_MS = 10_000
const MYSQL_LOCK_NAME = 'jisu:preview-auth:nonce-quota'

function nonceRoot(): string {
  return process.env.PREVIEW_AUTH_NONCE_STORE_PATH || path.resolve(process.cwd(), 'data', 'preview-nonces')
}
function useMySqlStore(): boolean { return process.env.PREVIEW_AUTH_NONCE_STORE === 'mysql' }
function maxEntries(): number {
  const parsed = Number(process.env.PREVIEW_AUTH_NONCE_MAX_ENTRIES || DEFAULT_MAX_ENTRIES)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_ENTRIES
}
function entryPath(root: string, key: string): string {
  return path.join(root, `${crypto.createHash('sha256').update(key).digest('hex')}.nonce`)
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function lockOwner(): string {
  return JSON.stringify({ host: os.hostname(), pid: process.pid, id: crypto.randomBytes(16).toString('hex') })
}
function ownerProcessIsDead(raw: string): boolean {
  try {
    const owner = JSON.parse(raw) as { host?: string; pid?: number }
    const pid = owner.pid
    if (owner.host !== os.hostname() || typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false
    const safePid = pid as number
    try { process.kill(safePid, 0); return false } catch (error: any) { return error?.code === 'ESRCH' }
  } catch { return false }
}
async function syncDirectory(root: string): Promise<void> {
  try {
    const directory = await fsp.open(root, 'r')
    try { await directory.sync() } finally { await directory.close() }
  } catch (error: any) {
    // POSIX directory fsync is required for crash durability.  Windows and
    // some network filesystems reject opening directories for sync; the file
    // itself is still durable and the unsupported operation is harmless.
    if (!['EISDIR', 'EINVAL', 'ENOTSUP', 'EPERM'].includes(error?.code)) throw error
  }
}

async function consumePreviewNonceMySql(key: string, expiresAt: number): Promise<boolean> {
  const { pool } = await import('../db/index.js')
  const connection = await pool.getConnection()
  try {
    const [lockRows] = await connection.query<any[]>('SELECT GET_LOCK(?, 10) AS acquired', [MYSQL_LOCK_NAME])
    if (Number(lockRows[0]?.acquired) !== 1) throw Object.assign(new Error('preview nonce quota lock unavailable'), { code: 'PREVIEW_NONCE_STORE_UNAVAILABLE' })
    try {
      await connection.beginTransaction()
      await connection.query('DELETE FROM preview_auth_nonces WHERE expires_at <= ?', [Date.now()])
      const [rows] = await connection.query<any[]>('SELECT nonce_hash FROM preview_auth_nonces WHERE nonce_hash = ? FOR UPDATE', [crypto.createHash('sha256').update(key).digest('hex')])
      if (rows.length) { await connection.rollback(); return false }
      const [countRows] = await connection.query<any[]>('SELECT COUNT(*) AS count FROM preview_auth_nonces')
      if (Number(countRows[0]?.count || 0) >= maxEntries()) { await connection.rollback(); return false }
      const expiry = Math.max(Date.now() + 1, Math.min(expiresAt, Date.now() + DEFAULT_TTL_MS))
      await connection.query('INSERT INTO preview_auth_nonces (nonce_hash, expires_at, created_at) VALUES (?, ?, ?)', [crypto.createHash('sha256').update(key).digest('hex'), expiry, new Date().toISOString()])
      await connection.commit()
      return true
    } catch (error) { await connection.rollback().catch(() => undefined); throw error }
    finally { await connection.query('SELECT RELEASE_LOCK(?)', [MYSQL_LOCK_NAME]).catch(() => undefined) }
  } finally { connection.release() }
}

async function withStoreLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = path.join(root, '.quota.lock')
  for (;;) {
    try {
      const lock = await fsp.open(lockPath, 'wx', 0o600)
      const owner = lockOwner()
      try {
        await lock.writeFile(owner, 'utf8')
        await lock.sync()
      } catch (error) {
        await lock.close().catch(() => undefined)
        await fsp.rm(lockPath, { force: true }).catch(() => undefined)
        throw error
      }
      await lock.close()
      // Keep a live lock from being mistaken for a crashed owner while a
      // slow filesystem operation is in progress.  Check the owner before
      // touching mtime so a replaced lock can never be refreshed or removed.
      const heartbeat = setInterval(() => {
        fsp.readFile(lockPath, 'utf8')
          .then(current => current === owner ? fsp.utimes(lockPath, new Date(), new Date()) : undefined)
          .catch(() => undefined)
      }, LOCK_HEARTBEAT_MS)
      heartbeat.unref()
      try { return await fn() } finally {
        clearInterval(heartbeat)
        try {
          if (await fsp.readFile(lockPath, 'utf8') === owner) await fsp.rm(lockPath, { force: true })
        } catch { /* another contender already recovered/replaced the lock */ }
      }
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error
      try {
        const stat = await fsp.stat(lockPath)
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          // Never delete a lock merely because its mtime is old.  A lock is
          // reclaimable only when its recorded local owner process is gone;
          // unknown-host owners remain conservative and block rather than
          // risking two writers in a shared directory.
          const currentOwner = await fsp.readFile(lockPath, 'utf8').catch(() => '')
          if (currentOwner && ownerProcessIsDead(currentOwner)) {
            // Atomic rename removes the stale name in one filesystem
            // operation.  Competing reclaimers then get ENOENT and cannot
            // accidentally remove a newly-created lock at lockPath.
            const quarantine = `${lockPath}.stale.${process.pid}.${crypto.randomBytes(8).toString('hex')}`
            try {
              await fsp.rename(lockPath, quarantine)
              await fsp.rm(quarantine, { force: true })
            } catch (reclaimError: any) {
              if (reclaimError?.code !== 'ENOENT') throw reclaimError
            }
          }
        }
      } catch (statError: any) {
        if (statError?.code !== 'ENOENT') throw statError
      }
      await sleep(5)
    }
  }
}

async function listEntries(root: string): Promise<string[]> {
  try { return (await fsp.readdir(root)).filter(name => name.endsWith('.nonce')) } catch (error: any) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}
function parseExpiryRecord(raw: string): number | null {
  // Records are published as String(number).  Keep parsing strict so an
  // empty/partial/whitespace-padded file can never be mistaken for epoch 0.
  if (!/^\d+(?:\.\d+)?$/.test(raw)) return null
  const expiry = Number(raw)
  return Number.isFinite(expiry) ? expiry : null
}
async function removeExpiredLocked(root: string, now: number): Promise<void> {
  for (const name of await listEntries(root)) {
    const file = path.join(root, name)
    try {
      const expiry = parseExpiryRecord(await fsp.readFile(file, 'utf8'))
      // Invalid/partial records are retained as consumed; only complete
      // finite expired records may be removed.
      if (expiry !== null && expiry <= now) await fsp.rm(file, { force: true })
    } catch (error: any) { if (error?.code !== 'ENOENT') throw error }
  }
}

export async function consumePreviewNonce(key: string, expiresAt: number): Promise<boolean> {
  if (useMySqlStore()) return consumePreviewNonceMySql(key, expiresAt)
  const root = nonceRoot()
  await fsp.mkdir(root, { recursive: true, mode: 0o700 })
  return withStoreLock(root, async () => {
    const file = entryPath(root, key)
    try {
      const existing = parseExpiryRecord(await fsp.readFile(file, 'utf8'))
      if (existing === null) return false
      if (existing > Date.now()) return false
      await fsp.rm(file, { force: true })
    } catch (error: any) { if (error?.code !== 'ENOENT') throw error }
    await removeExpiredLocked(root, Date.now())
    if ((await listEntries(root)).length >= maxEntries()) return false
    const expiry = Math.max(Date.now() + 1, Math.min(expiresAt, Date.now() + DEFAULT_TTL_MS))
    const temporary = `${file}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`
    const handle = await fsp.open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(String(expiry), 'utf8')
      await handle.sync()
    } finally { await handle.close() }
    try {
      await fsp.rename(temporary, file)
      await syncDirectory(root)
    } catch (error) {
      await fsp.rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
    return true
  })
}

const cleanupTimer = setInterval(() => {
  const root = nonceRoot()
  fsp.mkdir(root, { recursive: true, mode: 0o700 })
    .then(() => withStoreLock(root, () => removeExpiredLocked(root, Date.now())))
    .catch(() => undefined)
}, CLEANUP_INTERVAL_MS)
cleanupTimer.unref()

export function previewNonceStorePath(): string { return nonceRoot() }
