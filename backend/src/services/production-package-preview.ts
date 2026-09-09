import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import yauzl, { type Entry, type ZipFile } from 'yauzl'
import { parseProductionPackage, type ProductionPackagePreview } from './production-package-parser.js'

export const PREVIEW_LIMITS = Object.freeze({
  maxUploadBytes: 25 * 1024 * 1024,
  maxExpandedBytes: 100 * 1024 * 1024,
  maxFiles: 1_000,
  maxFileBytes: 10 * 1024 * 1024,
  maxPathDepth: 8,
  maxCompressionRatio: 100,
  ttlMs: 30 * 60 * 1000,
})

export type PreviewErrorCode =
  | 'PACKAGE_ARCHIVE_INVALID'
  | 'PACKAGE_ARCHIVE_LIMIT'
  | 'PACKAGE_ARCHIVE_PATH_INVALID'
  | 'PACKAGE_ARCHIVE_NESTED'
  | 'PACKAGE_ARCHIVE_ROOT_AMBIGUOUS'
  | 'PACKAGE_PREVIEW_NOT_FOUND'
  | 'PACKAGE_PREVIEW_EXPIRED'
  | 'PACKAGE_SNAPSHOT_MISMATCH'

export class ProductionPackagePreviewError extends Error {
  readonly code: PreviewErrorCode
  readonly status: number
  constructor(code: PreviewErrorCode, message: string, status = 400) {
    super(message)
    this.name = 'ProductionPackagePreviewError'
    this.code = code
    this.status = status
  }
}

type Snapshot = {
  token: string
  snapshotId: string
  owner: string
  createdAt: number
  uploadSha256: string
  snapshotDirectory: string
  root: string
  packageFingerprint: string
  validationFingerprint: string
  expiresAt: number
  preview: ProductionPackagePreview
}

export type ConfirmSnapshot = Snapshot & { uploadPath: string; uploadBytes: Buffer }

export async function extractProductionPackageUploadForConfirm(buffer: Buffer): Promise<{ preview: ProductionPackagePreview; packageRoot: string; cleanup: () => void }> {
  const extracted = await extractZip(buffer)
  try {
    return { preview: parseProductionPackage(extracted.packageRoot), packageRoot: extracted.packageRoot, cleanup: () => fs.rmSync(extracted.snapshotDirectory, { recursive: true, force: true }) }
  } catch (error) { fs.rmSync(extracted.snapshotDirectory, { recursive: true, force: true }); throw error }
}

const snapshots = new Map<string, Snapshot>()
const SNAPSHOT_METADATA = 'snapshot.json'

function snapshotRoot(): string {
  // Docker production explicitly mounts this under /app/data.  Keep the
  // system-temp default for local development and the existing file-based
  // recovery tests.
  return process.env.PREVIEW_SNAPSHOT_ROOT || path.join(os.tmpdir(), 'jisu-production-package-previews')
}

function useMySqlSnapshotStore(): boolean { return process.env.PREVIEW_PACKAGE_SNAPSHOT_STORE === 'mysql' }
function snapshotDirectoryFor(snapshotId: string): string { return path.join(snapshotRoot(), snapshotId) }
function safeSnapshotId(snapshotId: unknown): snapshotId is string { return typeof snapshotId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(snapshotId) }

function archiveError(message: string, status = 400): ProductionPackagePreviewError {
  return new ProductionPackagePreviewError('PACKAGE_ARCHIVE_INVALID', message, status)
}

function normalizeEntryName(raw: string): { normalized: string; isDirectory: boolean } {
  if (!raw || raw.includes('\0')) throw new ProductionPackagePreviewError('PACKAGE_ARCHIVE_PATH_INVALID', '归档包含无效文件名')
  const slashName = raw.replaceAll('\\', '/')
  if (slashName.startsWith('/') || slashName.startsWith('\\') || /^[A-Za-z]:/.test(slashName)) {
    throw new ProductionPackagePreviewError('PACKAGE_ARCHIVE_PATH_INVALID', '归档不能包含绝对路径')
  }
  const isDirectory = slashName.endsWith('/')
  const segments = slashName.split('/').filter(Boolean)
  if (segments.some(segment => segment === '..')) throw new ProductionPackagePreviewError('PACKAGE_ARCHIVE_PATH_INVALID', '归档不能包含路径穿越')
  const normalized = segments.filter(segment => segment !== '.').join('/')
  if (!normalized) throw new ProductionPackagePreviewError('PACKAGE_ARCHIVE_PATH_INVALID', '归档路径规范化后不能为空')
  if (segments.length > PREVIEW_LIMITS.maxPathDepth) throw new ProductionPackagePreviewError('PACKAGE_ARCHIVE_LIMIT', '归档路径层级超过限制')
  return { normalized, isDirectory }
}

function isLinkOrSpecial(entry: Entry): boolean {
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff
  const type = unixMode & 0o170000
  return type === 0o120000 || (type !== 0 && type !== 0o100000 && type !== 0o040000)
}

function isNestedArchive(name: string): boolean {
  return /\.(?:zip|tar|tgz|gz|7z|rar)$/i.test(name)
}

function readEntry(zip: ZipFile, entry: Entry): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) return reject(error || new Error('unable to open archive entry'))
      const chunks: Buffer[] = []
      let total = 0
      stream.on('data', (chunk: Buffer) => {
        total += chunk.length
        if (total > PREVIEW_LIMITS.maxFileBytes) stream.destroy(new ProductionPackagePreviewError('PACKAGE_ARCHIVE_LIMIT', '单文件解压大小超过 10 MiB'))
        else chunks.push(chunk)
      })
      stream.once('error', reject)
      stream.once('end', () => resolve(Buffer.concat(chunks)))
    })
  })
}

function openZip(buffer: Buffer): Promise<ZipFile> {
  return new Promise((resolve, reject) => yauzl.fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, zip) => error || !zip ? reject(error || archiveError('ZIP 无法读取')) : resolve(zip)))
}

async function extractZip(buffer: Buffer): Promise<{ packageRoot: string; snapshotDirectory: string }> {
  if (buffer.length > PREVIEW_LIMITS.maxUploadBytes) throw new ProductionPackagePreviewError('PACKAGE_ARCHIVE_LIMIT', 'ZIP 大小不能超过 25 MiB', 413)
  const snapshotId = crypto.randomUUID()
  const snapshotDirectory = snapshotDirectoryFor(snapshotId)
  const destination = path.join(snapshotDirectory, 'package')
  let zip: ZipFile | undefined
  try {
    zip = await openZip(buffer).catch(error => {
      if (error instanceof ProductionPackagePreviewError) throw error
      throw archiveError('ZIP 损坏或无法读取')
    })
    fs.mkdirSync(destination, { recursive: true, mode: 0o700 })
    // Keep the immutable upload alongside the extracted package for the future
    // Confirm step's snapshot/fingerprint revalidation. It is never parsed or
    // returned to the client.
    fs.writeFileSync(path.join(snapshotDirectory, 'upload.zip'), buffer, { flag: 'wx', mode: 0o600 })
    const seen = new Set<string>()
    const lowerSeen = new Set<string>()
    let fileCount = 0
    let entryCount = 0
    let expandedBytes = 0
    if (!zip) throw archiveError('ZIP 无法读取')
    const archive = zip
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const fail = (error: unknown) => { if (!settled) { settled = true; reject(error) } }
      archive.on('error', fail)
      archive.on('end', () => { if (!settled) { settled = true; resolve() } })
      archive.on('entry', async (entry: Entry) => {
        if (settled) return
        try {
          const info = normalizeEntryName(entry.fileName)
          if (!info.normalized) { archive.readEntry(); return }
          entryCount += 1
          if (entryCount > PREVIEW_LIMITS.maxFiles) throw new ProductionPackagePreviewError('PACKAGE_ARCHIVE_LIMIT', '归档目录项数量超过 1,000')
          if (seen.has(info.normalized) || lowerSeen.has(info.normalized.toLowerCase())) throw new ProductionPackagePreviewError('PACKAGE_ARCHIVE_PATH_INVALID', '归档包含重复路径')
          seen.add(info.normalized); lowerSeen.add(info.normalized.toLowerCase())
          if (isLinkOrSpecial(entry)) throw new ProductionPackagePreviewError('PACKAGE_ARCHIVE_PATH_INVALID', '归档不能包含链接或特殊文件')
          if (entry.isEncrypted()) throw new ProductionPackagePreviewError('PACKAGE_ARCHIVE_INVALID', '不支持加密 ZIP')
          if (!info.isDirectory) {
            fileCount += 1
            if (fileCount > PREVIEW_LIMITS.maxFiles) throw new ProductionPackagePreviewError('PACKAGE_ARCHIVE_LIMIT', '归档文件数量超过 1,000')
            if (entry.uncompressedSize > PREVIEW_LIMITS.maxFileBytes) throw new ProductionPackagePreviewError('PACKAGE_ARCHIVE_LIMIT', '单文件解压大小超过 10 MiB')
            if (entry.compressedSize === 0 && entry.uncompressedSize > 0 || entry.compressedSize > 0 && entry.uncompressedSize / entry.compressedSize > PREVIEW_LIMITS.maxCompressionRatio) throw new ProductionPackagePreviewError('PACKAGE_ARCHIVE_LIMIT', '归档压缩比超过限制')
            if (isNestedArchive(info.normalized)) throw new ProductionPackagePreviewError('PACKAGE_ARCHIVE_NESTED', '不允许嵌套归档文件')
            const content = await readEntry(archive, entry)
            expandedBytes += content.length
            if (expandedBytes > PREVIEW_LIMITS.maxExpandedBytes) throw new ProductionPackagePreviewError('PACKAGE_ARCHIVE_LIMIT', '归档解压总大小超过 100 MiB')
            const target = path.resolve(destination, ...info.normalized.split('/'))
            if (!target.startsWith(`${path.resolve(destination)}${path.sep}`)) throw new ProductionPackagePreviewError('PACKAGE_ARCHIVE_PATH_INVALID', '归档路径越出隔离目录')
            fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
            fs.writeFileSync(target, content, { flag: 'wx', mode: 0o600 })
          }
          archive.readEntry()
        } catch (error) { fail(error) }
      })
      archive.readEntry()
    })
    archive.close()
    zip = undefined
    return { packageRoot: locatePackageRoot(destination), snapshotDirectory }
  } catch (error) {
    try { zip?.close() } catch { /* already closed */ }
    fs.rmSync(snapshotDirectory, { recursive: true, force: true })
    if (error instanceof ProductionPackagePreviewError) throw error
    throw archiveError('ZIP 解压失败')
  }
}

function locatePackageRoot(destination: string): string {
  const direct = fs.readdirSync(destination, { withFileTypes: true }).map(entry => entry.name)
  const hasRequired = (root: string) => fs.existsSync(path.join(root, 'drama-package.md')) && fs.existsSync(path.join(root, 'source-manifest.md'))
  if (hasRequired(destination)) {
    if (direct.some(name => fs.statSync(path.join(destination, name)).isDirectory() && name !== 'episodes')) throw new ProductionPackagePreviewError('PACKAGE_ARCHIVE_ROOT_AMBIGUOUS', '无法唯一定位生产包根目录')
    return destination
  }
  const candidates = direct.filter(name => fs.statSync(path.join(destination, name)).isDirectory()).map(name => path.join(destination, name)).filter(hasRequired)
  if (candidates.length !== 1) throw new ProductionPackagePreviewError('PACKAGE_ARCHIVE_ROOT_AMBIGUOUS', 'ZIP 必须包含根目录或唯一一层生产包目录')
  const candidateName = path.basename(candidates[0])
  if (direct.some(name => name !== candidateName)) throw new ProductionPackagePreviewError('PACKAGE_ARCHIVE_ROOT_AMBIGUOUS', '生产包根目录不能与其他顶级内容混用')
  return candidates[0]
}

function snapshotToken(): string { return crypto.randomBytes(24).toString('base64url') }

function persistSnapshot(snapshot: Snapshot): void {
  fs.writeFileSync(path.join(snapshot.snapshotDirectory, SNAPSHOT_METADATA), JSON.stringify({
    token: snapshot.token,
    snapshotId: snapshot.snapshotId,
    owner: snapshot.owner,
    createdAt: snapshot.createdAt,
    uploadSha256: snapshot.uploadSha256,
    packageFingerprint: snapshot.packageFingerprint,
    validationFingerprint: snapshot.validationFingerprint,
    expiresAt: snapshot.expiresAt,
    uploadRelative: 'upload.zip',
    rootRelative: path.relative(snapshot.snapshotDirectory, snapshot.root),
    preview: snapshot.preview,
  }), { encoding: 'utf8', mode: 0o600 })
}

export function restoreProductionPackagePreviews(now = Date.now()): number {
  // In production MySQL is the source of truth.  Rehydrating local metadata
  // here would let a stale directory resurrect a deleted shared snapshot.
  if (useMySqlSnapshotStore() || !fs.existsSync(snapshotRoot())) return 0
  let restored = 0
  for (const entry of fs.readdirSync(snapshotRoot(), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const directory = path.join(snapshotRoot(), entry.name)
    try {
      const metadata = JSON.parse(fs.readFileSync(path.join(directory, SNAPSHOT_METADATA), 'utf8')) as Partial<Snapshot> & { rootRelative?: string; uploadRelative?: string }
      if (typeof metadata.token !== 'string' || typeof metadata.owner !== 'string' || typeof metadata.expiresAt !== 'number' || metadata.expiresAt <= now || typeof metadata.rootRelative !== 'string' || metadata.uploadRelative !== 'upload.zip') {
        fs.rmSync(directory, { recursive: true, force: true })
        continue
      }
      const root = path.resolve(directory, metadata.rootRelative)
      const upload = path.resolve(directory, metadata.uploadRelative)
      if (!root.startsWith(`${directory}${path.sep}`) || !upload.startsWith(`${directory}${path.sep}`) || !fs.statSync(root).isDirectory() || !fs.statSync(upload).isFile() || !metadata.preview) {
        fs.rmSync(directory, { recursive: true, force: true })
        continue
      }
      snapshots.set(metadata.token, {
        token: metadata.token,
        snapshotId: String(metadata.snapshotId || entry.name),
        owner: metadata.owner,
        createdAt: typeof metadata.createdAt === 'number' ? metadata.createdAt : metadata.expiresAt - PREVIEW_LIMITS.ttlMs,
        uploadSha256: String(metadata.uploadSha256 || ''),
        snapshotDirectory: directory,
        packageFingerprint: String(metadata.packageFingerprint || ''),
        validationFingerprint: String(metadata.validationFingerprint || ''),
        expiresAt: metadata.expiresAt,
        root,
        preview: metadata.preview,
      })
      restored += 1
    } catch {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  }
  return restored
}

async function saveSnapshotToMySql(snapshot: Snapshot): Promise<void> {
  const { pool } = await import('../db/index.js')
  await pool.query(
    `INSERT INTO preview_package_snapshots
      (token, snapshot_id, owner, created_at, upload_sha256, package_fingerprint, validation_fingerprint, expires_at, root_relative, preview_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [snapshot.token, snapshot.snapshotId, snapshot.owner, snapshot.createdAt, snapshot.uploadSha256, snapshot.packageFingerprint, snapshot.validationFingerprint, snapshot.expiresAt, path.relative(snapshot.snapshotDirectory, snapshot.root), JSON.stringify(snapshot.preview)],
  )
}

async function deleteSnapshotFromMySql(token: string): Promise<void> {
  if (!useMySqlSnapshotStore()) return
  const { pool } = await import('../db/index.js')
  await pool.query('DELETE FROM preview_package_snapshots WHERE token = ?', [token])
}

async function loadSnapshotFromMySql(token: string): Promise<Snapshot | undefined> {
  const { pool } = await import('../db/index.js')
  const [rows] = await pool.query<any[]>(
    `SELECT token, snapshot_id, owner, created_at, upload_sha256, package_fingerprint, validation_fingerprint, expires_at, root_relative, preview_json
       FROM preview_package_snapshots WHERE token = ? LIMIT 1`,
    [token],
  )
  const row = rows[0]
  if (!row || !safeSnapshotId(row.snapshot_id) || typeof row.owner !== 'string' || typeof row.root_relative !== 'string') return undefined
  try {
    const snapshotDirectory = snapshotDirectoryFor(row.snapshot_id)
    const root = path.resolve(snapshotDirectory, row.root_relative)
    if (!root.startsWith(`${snapshotDirectory}${path.sep}`) || !fs.statSync(root).isDirectory()) return undefined
    const preview = JSON.parse(String(row.preview_json)) as ProductionPackagePreview
    if (!preview || typeof preview !== 'object' || preview.preview_token !== token) return undefined
    return {
      token,
      snapshotId: row.snapshot_id,
      owner: row.owner,
      createdAt: Number(row.created_at),
      uploadSha256: String(row.upload_sha256),
      snapshotDirectory,
      root,
      packageFingerprint: String(row.package_fingerprint),
      validationFingerprint: String(row.validation_fingerprint),
      expiresAt: Number(row.expires_at),
      preview,
    }
  } catch { return undefined }
}

/** Load the shared snapshot and re-check the immutable upload before import. */
export async function getProductionPackageSnapshotForConfirm(token: string, owner: string, expected: { packageFingerprint: string; validationFingerprint: string }): Promise<ConfirmSnapshot> {
  const snapshot = useMySqlSnapshotStore() ? await loadSnapshotFromMySql(token) : snapshots.get(token)
  if (!snapshot) throw new ProductionPackagePreviewError('PACKAGE_PREVIEW_NOT_FOUND', '预览不存在或已被清理', 404)
  if (snapshot.expiresAt <= Date.now()) {
    await removeSnapshot(snapshot)
    throw new ProductionPackagePreviewError('PACKAGE_PREVIEW_EXPIRED', '预览已过期，请重新上传', 410)
  }
  if (snapshot.owner !== owner) throw new ProductionPackagePreviewError('PACKAGE_PREVIEW_NOT_FOUND', '预览不存在', 404)
  if (snapshot.packageFingerprint !== expected.packageFingerprint || snapshot.validationFingerprint !== expected.validationFingerprint) {
    throw new ProductionPackagePreviewError('PACKAGE_SNAPSHOT_MISMATCH', '预览指纹已变化，请重新上传并预览', 409)
  }
  const uploadPath = path.resolve(snapshot.snapshotDirectory, 'upload.zip')
  if (!uploadPath.startsWith(`${path.resolve(snapshot.snapshotDirectory)}${path.sep}`) || !fs.existsSync(uploadPath)) {
    throw new ProductionPackagePreviewError('PACKAGE_SNAPSHOT_MISMATCH', '预览文件已不存在，请重新上传', 409)
  }
  const uploadBytes = fs.readFileSync(uploadPath)
  const digest = crypto.createHash('sha256').update(uploadBytes).digest('hex')
  if (digest !== snapshot.uploadSha256) throw new ProductionPackagePreviewError('PACKAGE_SNAPSHOT_MISMATCH', '预览文件已被替换，请重新上传', 409)
  return { ...snapshot, uploadPath, uploadBytes }
}

async function removeSnapshot(snapshot: Snapshot): Promise<void> {
  snapshots.delete(snapshot.token)
  await deleteSnapshotFromMySql(snapshot.token)
  fs.rmSync(snapshot.snapshotDirectory, { recursive: true, force: true })
}

export async function createProductionPackagePreview(input: { zip: Buffer; owner: string }): Promise<ProductionPackagePreview> {
  if (useMySqlSnapshotStore()) await cleanupExpiredProductionPackagePreviewsShared()
  else cleanupExpiredProductionPackagePreviews()
  const extracted = await extractZip(input.zip)
  const { packageRoot, snapshotDirectory } = extracted
  try {
    const parsed = parseProductionPackage(packageRoot)
    const token = snapshotToken()
    const snapshotId = path.basename(snapshotDirectory)
    const createdAt = Date.now()
    const expiresAt = createdAt + PREVIEW_LIMITS.ttlMs
    const preview = { ...parsed, preview_token: token } as ProductionPackagePreview
    const snapshot: Snapshot = { token, snapshotId, owner: input.owner, createdAt, uploadSha256: crypto.createHash('sha256').update(input.zip).digest('hex'), snapshotDirectory, root: packageRoot, packageFingerprint: parsed.package.package_fingerprint, validationFingerprint: parsed.package.validation_fingerprint, expiresAt, preview }
    persistSnapshot(snapshot)
    if (useMySqlSnapshotStore()) await saveSnapshotToMySql(snapshot)
    snapshots.set(token, snapshot)
    return preview
  } catch (error) {
    fs.rmSync(snapshotDirectory, { recursive: true, force: true })
    throw error
  }
}

export function getProductionPackagePreview(token: string, owner: string): ProductionPackagePreview {
  const snapshot = snapshots.get(token)
  if (!snapshot) throw new ProductionPackagePreviewError('PACKAGE_PREVIEW_NOT_FOUND', '预览已不存在或已被清理', 404)
  if (snapshot.expiresAt <= Date.now()) {
    snapshots.delete(token); fs.rmSync(snapshot.snapshotDirectory, { recursive: true, force: true })
    throw new ProductionPackagePreviewError('PACKAGE_PREVIEW_EXPIRED', '预览已过期，请重新上传', 410)
  }
  if (snapshot.owner !== owner) throw new ProductionPackagePreviewError('PACKAGE_PREVIEW_NOT_FOUND', '预览不存在', 404)
  return snapshot.preview
}

/**
 * Production route lookup.  With the MySQL store enabled every process reads
 * the same metadata row, while the package files live on PREVIEW_SNAPSHOT_ROOT
 * (the shared Docker data volume).  The old synchronous getter remains for
 * local/file-store callers and compatibility tests.
 */
export async function getProductionPackagePreviewShared(token: string, owner: string): Promise<ProductionPackagePreview> {
  const snapshot = useMySqlSnapshotStore() ? await loadSnapshotFromMySql(token) : snapshots.get(token)
  if (!snapshot) throw new ProductionPackagePreviewError('PACKAGE_PREVIEW_NOT_FOUND', '预览已不存在或已被清理', 404)
  if (snapshot.expiresAt <= Date.now()) {
    await removeSnapshot(snapshot)
    throw new ProductionPackagePreviewError('PACKAGE_PREVIEW_EXPIRED', '预览已过期，请重新上传', 410)
  }
  if (snapshot.owner !== owner) throw new ProductionPackagePreviewError('PACKAGE_PREVIEW_NOT_FOUND', '预览不存在', 404)
  return snapshot.preview
}

export function cleanupExpiredProductionPackagePreviews(now = Date.now()): number {
  let removed = 0
  for (const [token, snapshot] of snapshots) if (snapshot.expiresAt <= now) {
    snapshots.delete(token); fs.rmSync(snapshot.snapshotDirectory, { recursive: true, force: true }); removed += 1
  }
  return removed
}

export async function cleanupExpiredProductionPackagePreviewsShared(now = Date.now()): Promise<number> {
  if (!useMySqlSnapshotStore()) return cleanupExpiredProductionPackagePreviews(now)
  const { pool } = await import('../db/index.js')
  const [rows] = await pool.query<any[]>(
    `SELECT token, snapshot_id, owner, created_at, upload_sha256, package_fingerprint, validation_fingerprint, expires_at, root_relative, preview_json
       FROM preview_package_snapshots WHERE expires_at <= ?`,
    [now],
  )
  await pool.query('DELETE FROM preview_package_snapshots WHERE expires_at <= ?', [now])
  let removed = 0
  for (const row of rows) {
    if (safeSnapshotId(row.snapshot_id)) fs.rmSync(snapshotDirectoryFor(row.snapshot_id), { recursive: true, force: true })
    if (typeof row.token === 'string') snapshots.delete(row.token)
    removed += 1
  }
  return removed
}

/** Remove snapshot directories left behind by a process crash before the in-memory index was rebuilt. */
export function cleanupOrphanedProductionPackagePreviewDirectories(now = Date.now()): number {
  if (!fs.existsSync(snapshotRoot())) return 0
  let removed = 0
  for (const entry of fs.readdirSync(snapshotRoot(), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const directory = path.join(snapshotRoot(), entry.name)
    try {
      const age = now - fs.statSync(directory).mtimeMs
      if (age >= PREVIEW_LIMITS.ttlMs) { fs.rmSync(directory, { recursive: true, force: true }); removed += 1 }
    } catch { /* a concurrent cleanup may have removed it */ }
  }
  return removed
}

export function startProductionPackagePreviewCleanup(intervalMs = 5 * 60 * 1000): NodeJS.Timeout {
  restoreProductionPackagePreviews()
  cleanupOrphanedProductionPackagePreviewDirectories()
  const timer = setInterval(() => {
    void cleanupExpiredProductionPackagePreviewsShared().catch(error => console.error('[production-package-preview] cleanup failed', error))
    cleanupOrphanedProductionPackagePreviewDirectories()
  }, intervalMs)
  timer.unref()
  return timer
}

export function clearProductionPackagePreviews(): void {
  for (const snapshot of snapshots.values()) fs.rmSync(snapshot.snapshotDirectory, { recursive: true, force: true })
  snapshots.clear()
}
