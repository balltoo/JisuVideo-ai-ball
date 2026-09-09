import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'

const DEFAULT_TTL_MS = 30 * 60 * 1000 + 30_000
const CLEANUP_INTERVAL_MS = 60_000
const DEFAULT_MAX_ENTRIES = 100_000

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

let cachedEntryCount = 0
let countLoaded = false

async function refreshCount(root: string): Promise<number> {
  try {
    const entries = await fsp.readdir(root)
    cachedEntryCount = entries.filter(name => name.endsWith('.nonce')).length
  } catch (error: any) {
    if (error?.code === 'ENOENT') cachedEntryCount = 0
    else throw error
  }
  countLoaded = true
  return cachedEntryCount
}

async function cleanupExpired(root: string, now: number): Promise<void> {
  let names: string[]
  try { names = await fsp.readdir(root) } catch (error: any) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  await Promise.all(names.filter(name => name.endsWith('.nonce')).map(async name => {
    const file = path.join(root, name)
    try {
      const expiresAt = Number(await fsp.readFile(file, 'utf8'))
      if (!Number.isFinite(expiresAt) || expiresAt <= now) await fsp.rm(file, { force: true })
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error
    }
  }))
  await refreshCount(root)
}

/**
 * Durable, filesystem-backed nonce consumption. Atomic `wx` creation makes
 * consumption safe across processes sharing the same mounted root; the file
 * content is the TTL and cleanup removes expired entries. Production Compose
 * mounts /app/data and pins this service to one replica; a future multi-host
 * deployment should replace this store with Redis SET NX PX.
 */
export async function consumePreviewNonce(key: string, expiresAt: number): Promise<boolean> {
  const root = nonceRoot()
  await fsp.mkdir(root, { recursive: true, mode: 0o700 })
  if (!countLoaded) await refreshCount(root)
  if (cachedEntryCount >= maxEntries()) {
    await cleanupExpired(root, Date.now())
    if (cachedEntryCount >= maxEntries()) return false
  }
  const file = entryPath(root, key)
  const expiry = Math.max(Date.now() + 1, Math.min(expiresAt, Date.now() + DEFAULT_TTL_MS))
  try {
    const handle = await fsp.open(file, 'wx', 0o600)
    try { await handle.writeFile(String(expiry), 'utf8') } finally { await handle.close() }
    cachedEntryCount += 1
    return true
  } catch (error: any) {
    if (error?.code !== 'EEXIST') throw error
    try {
      const existingExpiry = Number(await fsp.readFile(file, 'utf8'))
      if (Number.isFinite(existingExpiry) && existingExpiry > Date.now()) return false
      await fsp.rm(file, { force: true })
      return consumePreviewNonce(key, expiresAt)
    } catch (readError: any) {
      if (readError?.code === 'ENOENT') return consumePreviewNonce(key, expiresAt)
      throw readError
    }
  }
}

const cleanupTimer = setInterval(() => {
  cleanupExpired(nonceRoot(), Date.now()).catch(() => undefined)
}, CLEANUP_INTERVAL_MS)
cleanupTimer.unref()

export function previewNonceStorePath(): string { return nonceRoot() }
