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
  uploadSha256: string
  root: string
  packageFingerprint: string
  validationFingerprint: string
  expiresAt: number
  preview: ProductionPackagePreview
}

const snapshots = new Map<string, Snapshot>()
const snapshotRoot = path.join(os.tmpdir(), 'jisu-production-package-previews')

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
  if (!normalized) return { normalized: '', isDirectory: true }
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

async function extractZip(buffer: Buffer): Promise<string> {
  if (buffer.length > PREVIEW_LIMITS.maxUploadBytes) throw new ProductionPackagePreviewError('PACKAGE_ARCHIVE_LIMIT', 'ZIP 大小不能超过 25 MiB', 413)
  const zip = await openZip(buffer).catch(error => {
    if (error instanceof ProductionPackagePreviewError) throw error
    throw archiveError('ZIP 损坏或无法读取')
  })
  const snapshotId = crypto.randomUUID()
  const destination = path.join(snapshotRoot, snapshotId)
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 })
  const seen = new Set<string>()
  const lowerSeen = new Set<string>()
  let fileCount = 0
  let entryCount = 0
  let expandedBytes = 0
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const fail = (error: unknown) => { if (!settled) { settled = true; reject(error) } }
      zip.on('error', fail)
      zip.on('end', () => { if (!settled) { settled = true; resolve() } })
      zip.on('entry', async (entry: Entry) => {
        if (settled) return
        try {
          const info = normalizeEntryName(entry.fileName)
          if (!info.normalized) { zip.readEntry(); return }
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
            const content = await readEntry(zip, entry)
            expandedBytes += content.length
            if (expandedBytes > PREVIEW_LIMITS.maxExpandedBytes) throw new ProductionPackagePreviewError('PACKAGE_ARCHIVE_LIMIT', '归档解压总大小超过 100 MiB')
            const target = path.resolve(destination, ...info.normalized.split('/'))
            if (!target.startsWith(`${path.resolve(destination)}${path.sep}`)) throw new ProductionPackagePreviewError('PACKAGE_ARCHIVE_PATH_INVALID', '归档路径越出隔离目录')
            fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
            fs.writeFileSync(target, content, { flag: 'wx', mode: 0o600 })
          }
          zip.readEntry()
        } catch (error) { fail(error) }
      })
      zip.readEntry()
    })
    zip.close()
    return locatePackageRoot(destination)
  } catch (error) {
    try { zip.close() } catch { /* already closed */ }
    fs.rmSync(destination, { recursive: true, force: true })
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

export async function createProductionPackagePreview(input: { zip: Buffer; owner: string }): Promise<ProductionPackagePreview> {
  cleanupExpiredProductionPackagePreviews()
  const packageRoot = await extractZip(input.zip)
  try {
    const parsed = parseProductionPackage(packageRoot)
    const token = snapshotToken()
    const snapshotId = path.basename(path.dirname(packageRoot))
    const expiresAt = Date.now() + PREVIEW_LIMITS.ttlMs
    const preview = { ...parsed, preview_token: token } as ProductionPackagePreview
    snapshots.set(token, { token, snapshotId, owner: input.owner, uploadSha256: crypto.createHash('sha256').update(input.zip).digest('hex'), root: packageRoot, packageFingerprint: parsed.package.package_fingerprint, validationFingerprint: parsed.package.validation_fingerprint, expiresAt, preview })
    return preview
  } catch (error) {
    fs.rmSync(path.dirname(packageRoot), { recursive: true, force: true })
    throw error
  }
}

export function getProductionPackagePreview(token: string, owner: string): ProductionPackagePreview {
  const snapshot = snapshots.get(token)
  if (!snapshot) throw new ProductionPackagePreviewError('PACKAGE_PREVIEW_NOT_FOUND', '预览已不存在或已被清理', 404)
  if (snapshot.expiresAt <= Date.now()) {
    snapshots.delete(token); fs.rmSync(path.dirname(snapshot.root), { recursive: true, force: true })
    throw new ProductionPackagePreviewError('PACKAGE_PREVIEW_EXPIRED', '预览已过期，请重新上传', 410)
  }
  if (snapshot.owner !== owner) throw new ProductionPackagePreviewError('PACKAGE_PREVIEW_NOT_FOUND', '预览不存在', 404)
  return snapshot.preview
}

export function cleanupExpiredProductionPackagePreviews(now = Date.now()): number {
  let removed = 0
  for (const [token, snapshot] of snapshots) if (snapshot.expiresAt <= now) {
    snapshots.delete(token); fs.rmSync(path.dirname(snapshot.root), { recursive: true, force: true }); removed += 1
  }
  return removed
}

/** Remove snapshot directories left behind by a process crash before the in-memory index was rebuilt. */
export function cleanupOrphanedProductionPackagePreviewDirectories(now = Date.now()): number {
  if (!fs.existsSync(snapshotRoot)) return 0
  let removed = 0
  for (const entry of fs.readdirSync(snapshotRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const directory = path.join(snapshotRoot, entry.name)
    try {
      const age = now - fs.statSync(directory).mtimeMs
      if (age >= PREVIEW_LIMITS.ttlMs) { fs.rmSync(directory, { recursive: true, force: true }); removed += 1 }
    } catch { /* a concurrent cleanup may have removed it */ }
  }
  return removed
}

export function startProductionPackagePreviewCleanup(intervalMs = 5 * 60 * 1000): NodeJS.Timeout {
  cleanupOrphanedProductionPackagePreviewDirectories()
  const timer = setInterval(() => {
    cleanupExpiredProductionPackagePreviews()
    cleanupOrphanedProductionPackagePreviewDirectories()
  }, intervalMs)
  timer.unref()
  return timer
}

export function clearProductionPackagePreviews(): void {
  for (const snapshot of snapshots.values()) fs.rmSync(path.dirname(snapshot.root), { recursive: true, force: true })
  snapshots.clear()
}
