/**
 * Issue #96 — 生产包 v0.1 口径 helper（供 fixture 断言复用）
 *
 * 口径来源：docs/production-package-import-v0.1.md §3.2，与仓库自带的
 * docs/examples/verify-production-package-v0.1.py 对齐。本文件只提供**规范化与
 * 哈希**能力，不做任何 Markdown 语义解析——解析器实现属于后续运行时 PR，本
 * fixture 不实现、不修改。
 *
 * 四种字节口径（§3.2）：
 *   normalized_file_bytes      —— CRLF/CR→LF，末尾恰好一个 LF，不 trim 空白
 *   episode_content_bytes      —— ## Content 区块正文，末尾恰好一个 LF
 *   source_version_canonical   —— 按集号排序拼接，非末集后再追加一个 LF
 *   package / validation 指纹  —— path + NUL + lowercase hex + LF，整体 SHA-256
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

export const FIXTURE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)))
export const PACKAGES_DIR = path.join(FIXTURE_ROOT, 'packages')

export const MANIFEST_NAME = 'source-manifest.md'
export const EPISODE_PATH = /^episodes\/(\d{3})\.md$/
const BOM = Buffer.from([0xef, 0xbb, 0xbf])

/** SHA-256，返回 64 位 lowercase hex（不带 `sha256:` 前缀）。 */
export function sha256(bytes) {
  const hash = crypto.createHash('sha256')
  hash.update(bytes)
  return hash.digest('hex')
}

/** 展示值：`sha256:<64 位 lowercase hex>`。 */
export function sha256Display(bytes) {
  return 'sha256:' + sha256(bytes)
}

/**
 * §3.2 normalized_file_bytes。
 * 拒绝 UTF-8 BOM 与非 UTF-8；CRLF/CR 统一为 LF；去掉全部末尾 LF 后追加恰好一个。
 * 不 trim 空格/制表符，行尾空白与空白行都属于内容。
 */
export function normalizeFileBytes(raw) {
  if (Buffer.compare(raw.subarray(0, 3), BOM) === 0) {
    throw new Error('PACKAGE_ENCODING_INVALID: UTF-8 BOM is not allowed')
  }
  if (!isValidUtf8(raw)) {
    throw new Error('PACKAGE_ENCODING_INVALID: file is not valid UTF-8')
  }
  const folded = Buffer.from(
    Buffer.from(raw, 'latin1').toString('latin1').replace(/\r\n/g, '\n').replace(/\r/g, '\n'),
    'latin1',
  )
  let end = folded.length
  while (end > 0 && folded[end - 1] === 0x0a) end -= 1
  // 必须返回独立副本：subarray 只是 view，共享 folded 的底层内存，哈希会被污染。
  // 追加的 LF 必须显式写入 0x0a：原文件没有末尾 LF 时 end === folded.length，
  // 若用 allocUnsafe 再 copy(end+1)，最后 1 字节保持未初始化，file_hash 会变成
  // 非确定值（契约 §3.2 要求输入 `abc` 得到 `abc\n`，空文件得到 `\n`）。
  const out = Buffer.alloc(end + 1)
  folded.copy(out, 0, 0, end)
  out[end] = 0x0a
  return out
}

function isValidUtf8(raw) {
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true })
    decoder.decode(raw)
    return true
  } catch {
    return false
  }
}

/** §3.2 episode_content_bytes：`## Content` 到下一个 `## ` 之间，末尾恰好一个 LF。 */
export function episodeContentBytes(normalizedFileBytes, relPath) {
  const text = normalizedFileBytes.toString('utf-8')
  const re = /^## Content\n/gm
  const match = re.exec(text)
  if (!match) {
    throw new Error(`PACKAGE_FRONTMATTER_INVALID: missing ## Content heading: ${relPath}`)
  }
  let body = text.slice(match.index + match[0].length)
  if (body.startsWith('\n')) body = body.slice(1) // 恰好一个标题/正文分隔换行
  const next = /\n## [^\n]*\n/.exec(body)
  if (next) {
    body = body.slice(0, next.index)
    if (body.endsWith('\n')) body = body.slice(0, -1) // 恰好一个分隔换行
  }
  while (body.length > 0 && body.endsWith('\n')) body = body.slice(0, -1)
  return Buffer.from(body + '\n', 'utf-8')
}

/** §3.2 指纹：`path + NUL + lowercase hex + LF` 的 UTF-8 字节串再 SHA-256。 */
export function fingerprint(rows) {
  const payload = Buffer.from(
    rows.map((r) => r.path + '\u0000' + r.fileHash + '\n').join(''),
    'utf-8',
  )
  return 'sha256:' + sha256(payload)
}

/** 按集号排序拼接 §3.2 source_version_canonical_bytes。 */
export function sourceVersionCanonicalBytes(episodeContents) {
  const ordered = [...episodeContents].sort((a, b) => a.episodeNumber - b.episodeNumber)
  const parts = []
  ordered.forEach((c, i) => {
    parts.push(c.content)
    if (i < ordered.length - 1) parts.push(Buffer.from('\n', 'utf-8'))
  })
  return Buffer.concat(parts)
}

/**
 * 只读读取一个包，返回逐文件哈希、三类指纹与集正文。
 * **不解析 Markdown 语义、不写库、不调用模型**——只产出 §3.2 规定的字节口径结果，
 * 供 T01 与全部负例的 `PACKAGE_HASH_MISMATCH` 断言复用。
 */
export function readPackage(packageRoot) {
  const rows = []
  const files = new Map()
  const contents = []

  for (const rel of walkRelPaths(packageRoot).sort()) {
    const abs = path.join(packageRoot, rel)
    if (!fs.statSync(abs).isFile()) continue
    const raw = fs.readFileSync(abs)
    const normalized = normalizeFileBytes(raw)
    const fileHash = sha256(normalized)
    rows.push({ path: rel, fileHash, byteLength: normalized.length })
    files.set(rel, normalized)
    const m = EPISODE_PATH.exec(rel)
    if (m) {
      contents.push({
        path: rel,
        episodeNumber: Number(m[1]),
        content: episodeContentBytes(normalized, rel),
      })
    }
  }

  const packageFingerprint = fingerprint(rows.filter((r) => r.path !== MANIFEST_NAME))
  const validationFingerprint = fingerprint(rows)
  const canonicalBytes = sourceVersionCanonicalBytes(contents)

  return {
    packageRoot,
    files,
    rows,
    packageFingerprint,
    validationFingerprint,
    sourceVersionCanonicalBytes: canonicalBytes,
    sourceVersionCanonicalHash: sha256Display(canonicalBytes),
    sourceVersionCanonicalHashHex: sha256(canonicalBytes),
    episodeContents: contents,
  }
}

/** manifest 中声明的 `package_fingerprint`（缺失/非法返回 null）。 */
export function declaredPackageFingerprint(packageRoot) {
  const abs = path.join(packageRoot, MANIFEST_NAME)
  if (!fs.existsSync(abs)) return null
  const m = /^package_fingerprint:\s*["']?(sha256:[0-9a-f]{64})["']?\s*$/m.exec(
    fs.readFileSync(abs, 'utf-8'),
  )
  return m ? m[1] : null
}

/** POSIX 相对路径列表（递归，字典序）。 */
function walkRelPaths(root) {
  const out = []
  const walk = (dir, rel) => {
    for (const entry of fs.readdirSync(path.join(root, dir))) {
      const sub = rel ? `${rel}/${entry}` : entry
      const abs = path.join(root, sub)
      const stat = fs.statSync(abs)
      if (stat.isDirectory()) walk(sub, sub)
      else out.push(sub)
    }
  }
  walk('.', '')
  return out.sort()
}

/**
 * 应用一条负例变异到包的临时副本（深拷贝后原地改）。
 *
 * 变异类型与 manifest.mjs 的 `mutate` 字段一一对应：
 *   delete        —— 删除文件
 *   replace       —— 字符串替换（{find, with}）
 *   binary        —— 前置 BOM 字节（用于 B5 编码阻断）
 *   duplicate-id  —— 把某个区块标题改成已存在的 external_id
 *   insert-after  —— 在锚点后插入一行（未知 front matter 字段）
 *   replace-section —— 从锚点标题到文件末尾整体替换
 *   add-file      —— 新增契约未定义路径的文件
 *
 * 只写文件系统，不触达数据库、不调用模型。
 */
export function applyMutation(destRoot, spec) {
  switch (spec.mutate) {
    case 'delete':
      fs.rmSync(path.join(destRoot, spec.target), { force: true })
      return
    case 'replace':
      modifyText(path.join(destRoot, spec.target), (s) => s.replace(spec.replace.find, spec.replace.with))
      return
    case 'binary':
      {
        const abs = path.join(destRoot, spec.target)
        fs.writeFileSync(abs, Buffer.concat([Buffer.from(spec.prefix), fs.readFileSync(abs)]))
      }
      return
    case 'duplicate-id':
      modifyText(
        path.join(destRoot, spec.target),
        (s) => s.replace(spec.anchor, spec.replacement),
      )
      return
    case 'insert-after':
      modifyText(
        path.join(destRoot, spec.target),
        (s) => s.replace(spec.insertAfter, spec.insertAfter + spec.text),
      )
      return
    case 'insert-before':
      modifyText(
        path.join(destRoot, spec.target),
        (s) => s.replace(spec.insertAfter, spec.text + spec.insertAfter),
      )
      return
    case 'replace-section':
      modifyText(path.join(destRoot, spec.target), (s) => {
        const idx = s.indexOf(spec.replaceSection.heading)
        if (idx < 0) throw new Error(`applyMutation: section not found: ${spec.replaceSection.heading}`)
        return s.slice(0, idx) + spec.replaceSection.with
      })
      return
    case 'add-file':
      {
        const abs = path.join(destRoot, spec.target)
        fs.mkdirSync(path.dirname(abs), { recursive: true })
        fs.writeFileSync(abs, spec.content)
      }
      return
    default:
      throw new Error(`applyMutation: unknown mutate type: ${spec.mutate}`)
  }
}

/** 读改写的 UTF-8 文本（保持 LF，Node 不做行尾转换）。 */
function modifyText(abs, fn) {
  fs.writeFileSync(abs, fn(fs.readFileSync(abs, 'utf-8')))
}

/** 深拷贝一个包到临时目录，供负例按字节改写后重读。 */
export function copyPackage(sourceRoot, destRoot) {
  fs.rmSync(destRoot, { recursive: true, force: true })
  fs.mkdirSync(destRoot, { recursive: true })
  for (const rel of walkRelPaths(sourceRoot).sort()) {
    const abs = path.join(sourceRoot, rel)
    if (!fs.statSync(abs).isFile()) continue
    const target = path.join(destRoot, rel)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(abs, target)
  }
  return destRoot
}
