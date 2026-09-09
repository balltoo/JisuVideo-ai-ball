import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'

const DEFAULT_TTL_MS = 30 * 60 * 1000 + 30_000
const CLEANUP_INTERVAL_MS = 60_000
const DEFAULT_MAX_ENTRIES = 100_000
const LOCK_STALE_MS = 60_000
const LOCK_HEARTBEAT_MS = 10_000

function nonceRoot(): string {
  return process.env.PREVIEW_AUTH_NONCE_STORE_PATH || path.resolve(process.cwd(), 'data', 'preview-nonces')
}
function maxEntries(): number {
  const parsed = Number(process.env.PREVIEW_AUTH_NONCE_MAX_ENTRIES || DEFAULT_MAX_ENTRIES)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_ENTRIES
}
function entryPath(root: string, key: string): string {
  return path.join(root, `${crypto.createHash('sha256').update(key).digest('hex')}.nonce`)
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function withStoreLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = path.join(root, '.quota.lock')
  for (;;) {
    try {
      const lock = await fsp.open(lockPath, 'wx', 0o600)
      const owner = `${process.pid}:${crypto.randomBytes(16).toString('hex')}`
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
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) await fsp.rm(lockPath, { force: true })
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
    try { await fsp.rename(temporary, file) } catch (error) {
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
