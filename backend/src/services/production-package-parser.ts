import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export type Diagnostic = {
  path?: string
  field?: string
  code?: string
  message: string
}

export type ProductionPackagePreview = {
  contract_version: '0.1'
  source_kind: 'markdown_episode_package'
  target_mode: 'new_project'
  status: 'ready' | 'blocked'
  can_confirm: boolean
  preview_token: string
  package: {
    package_id?: string
    package_version?: number
    package_fingerprint: string
    validation_fingerprint: string
    source_version_canonical_hash: string
    files: Array<{ path: string; file_hash: string; byte_length: number }>
  }
  project: Record<string, unknown>
  characters: Array<Record<string, unknown>>
  scenes: Array<Record<string, unknown>>
  episodes: Array<Record<string, unknown>>
  source: Record<string, unknown>
  diagnostics: {
    missing: Diagnostic[]
    conflicts: Diagnostic[]
    warnings: Diagnostic[]
    errors: Diagnostic[]
  }
  write_plan: { writes_on_parse: []; writes_after_confirm: string[] }
}

const MANIFEST = 'source-manifest.md'
const EPISODE_RE = /^episodes\/(\d{3})\.md$/
const REQUIRED = ['drama-package.md', MANIFEST]
const OPTIONAL = new Set(['characters.md', 'scenes.md'])

const displayHash = (bytes: Buffer) => `sha256:${sha256(bytes)}`
const sha256 = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex')

function normalize(raw: Buffer): Buffer {
  if (raw.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) throw new Error('PACKAGE_ENCODING_INVALID: UTF-8 BOM is not allowed')
  if (raw.includes(0)) throw new Error('PACKAGE_ENCODING_INVALID: NUL byte / binary or UTF-16 content is not allowed')
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(raw) } catch { throw new Error('PACKAGE_ENCODING_INVALID: file is not valid UTF-8') }
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n+$/, '') + '\n'
  return Buffer.from(text, 'utf8')
}

function walk(root: string): string[] {
  const result: string[] = []
  const visit = (dir: string, rel: string) => {
    for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${name.name}` : name.name
      const child = path.join(dir, name.name)
      if (name.isDirectory()) visit(child, childRel)
      else if (name.isFile()) result.push(childRel.replaceAll('\\', '/'))
    }
  }
  visit(root, '')
  return result.sort()
}

function scalar(value: string): unknown {
  const v = value.trim()
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1)
  if (v === 'true') return true
  if (v === 'false') return false
  if (/^-?\d+$/.test(v)) return Number(v)
  return v
}

function frontMatter(text: string, file: string, errors: Diagnostic[]) {
  const start = text.startsWith('---\n') ? 0 : text.indexOf('---\n')
  if (start < 0) { errors.push({ path: file, code: 'PACKAGE_FRONTMATTER_INVALID', message: 'front matter must start with ---' }); return { fields: {}, extensions: {}, body: text } }
  const end = text.indexOf('\n---', start + 4)
  if (end < 0) {
    errors.push({ path: file, code: 'PACKAGE_FRONTMATTER_INVALID', message: 'front matter closing --- is missing' })
    return { fields: {}, extensions: {}, body: text }
  }
  const head = text.slice(start + 4, end)
  const body = text.slice(end + 4).replace(/^\n/, '')
  const fields: Record<string, unknown> = {}
  const extensions: Record<string, unknown> = {}
  if (start > 0) {
    for (const line of text.slice(0, start).split('\n')) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/)
      if (m) extensions[m[1]] = scalar(m[2])
    }
  }
  let arrayKey: string | null = null
  for (const line of head.split('\n')) {
    if (!line.trim()) continue
    const item = line.match(/^\s*-\s+(.*)$/)
    if (item && arrayKey) { (fields[arrayKey] as unknown[]).push(scalar(item[1])); continue }
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/)
    if (!m) { errors.push({ path: file, code: 'PACKAGE_FRONTMATTER_INVALID', message: `invalid front matter line: ${line}` }); continue }
    const [, key, raw] = m
    if (!raw) { fields[key] = []; arrayKey = key; continue }
    arrayKey = null
    const value = scalar(raw)
    const known = new Set(['schema', 'schema_version', 'package_id', 'package_version', 'title', 'target_episode_count', 'genre', 'style', 'aspect_ratio', 'logline', 'audience', 'language', 'episode_id', 'episode_number', 'status', 'source_id', 'source_kind', 'processed_at', 'processor', 'human_reviewed', 'package_fingerprint', 'original_name', 'original_uri', 'original_content_hash'])
    ;(known.has(key) ? fields : extensions)[key] = value
  }
  return { fields, extensions, body }
}

function sections(body: string) {
  const map = new Map<string, string>()
  const re = /^##\s+([^\n]+)\n/gm
  const matches = [...body.matchAll(re)]
  matches.forEach((m, i) => map.set(m[1].trim(), body.slice(m.index! + m[0].length, i + 1 < matches.length ? matches[i + 1].index! : body.length).replace(/\n+$/, '')))
  return map
}

function bulletFields(text: string) {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*-\s+`([^`]+)`:\s*(.*)$/)
    if (m) out[m[1]] = m[2].trim()
  }
  return out
}

function entities(body: string, kind: 'character' | 'scene', warnings: Diagnostic[], errors: Diagnostic[]) {
  const out: Array<Record<string, unknown>> = []
  const re = new RegExp(`^##\\s+${kind}:\\s*([^\\n]+)\\n`, 'gm')
  const matches = [...body.matchAll(re)]
  const seen = new Set<string>()
  matches.forEach((m, i) => {
    const id = m[1].trim(); const end = i + 1 < matches.length ? matches[i + 1].index! : body.length
    const fields = bulletFields(body.slice(m.index! + m[0].length, end))
    if (seen.has(id)) errors.push({ code: 'PACKAGE_DUPLICATE_ID', message: `duplicate ${kind} external_id ${id}` })
    seen.add(id)
    if (kind === 'character' && !fields.name) errors.push({ code: 'PACKAGE_FRONTMATTER_INVALID', field: 'name', message: `character ${id} requires name` })
    if (kind === 'scene' && (!fields.location || !fields.time)) errors.push({ code: 'PACKAGE_FRONTMATTER_INVALID', field: 'location/time', message: `scene ${id} requires location and time` })
    out.push({ external_id: id, ...fields })
  })
  return out
}

function contentSection(body: string) {
  const heading = /^## Content\s*$/m.exec(body)
  if (!heading) return ''
  const rest = body.slice(heading.index + heading[0].length).replace(/^\n/, '')
  const next = /\n##\s+[^\n]+/.exec(rest)
  return (next ? rest.slice(0, next.index) : rest).replace(/\n+$/, '')
}

export function parseProductionPackage(packageRoot: string, options: { targetMode?: string } = {}): ProductionPackagePreview {
  const errors: Diagnostic[] = []; const warnings: Diagnostic[] = []; const missing: Diagnostic[] = []; const conflicts: Diagnostic[] = []
  if (options.targetMode && options.targetMode !== 'new_project') errors.push({ code: 'PACKAGE_TARGET_UNSUPPORTED', message: 'v0.1 only supports new_project target' })
  if (!fs.existsSync(packageRoot) || !fs.statSync(packageRoot).isDirectory()) {
    errors.push({ code: 'PACKAGE_EMPTY', message: 'package directory does not exist or is empty' })
  }
  const files = new Map<string, Buffer>(); const rows: Array<{ path: string; fileHash: string; byteLength: number }> = []
  for (const rel of fs.existsSync(packageRoot) ? walk(packageRoot) : []) {
    try {
      const normalized = normalize(fs.readFileSync(path.join(packageRoot, rel))); files.set(rel, normalized); rows.push({ path: rel, fileHash: sha256(normalized), byteLength: normalized.length })
    } catch (e) { errors.push({ path: rel, code: 'PACKAGE_ENCODING_INVALID', message: String(e).replace(/^Error:\s*/, '') }) }
  }
  const known = new Set([...REQUIRED, ...OPTIONAL]);
  for (const rel of rows.map(r => r.path)) if (!known.has(rel) && !EPISODE_RE.test(rel)) warnings.push({ path: rel, code: 'PACKAGE_FILE_UNEXPECTED', message: `unexpected file ${rel}` })
  for (const rel of REQUIRED) if (!files.has(rel)) missing.push({ path: rel, code: 'PACKAGE_FILE_MISSING', message: `required file missing: ${rel}` })
  const packageFp = displayHash(Buffer.from(rows.filter(r => r.path !== MANIFEST).map(r => `${r.path}\0${r.fileHash}\n`).join('')))
  const validationFp = displayHash(Buffer.from(rows.map(r => `${r.path}\0${r.fileHash}\n`).join('')))
  const episodeRows = rows.filter(r => EPISODE_RE.test(r.path)).sort((a, b) => a.path.localeCompare(b.path))
  const episodeNumbers = episodeRows.map(r => Number(EPISODE_RE.exec(r.path)![1]))
  if (episodeNumbers.length && (episodeNumbers[0] !== 1 || episodeNumbers.some((n, i) => n !== i + 1))) missing.push({ path: 'episodes/', code: 'PACKAGE_FILE_MISSING', message: 'episode files must be numbered continuously from 001' })
  const episodeData: Array<Record<string, unknown>> = []; const canonicalParts: Buffer[] = []
  for (const row of episodeRows) {
    const num = Number(EPISODE_RE.exec(row.path)![1]); const text = files.get(row.path)!.toString('utf8'); const fm = frontMatter(text, row.path, errors); const sec = sections(fm.body); const content = contentSection(fm.body)
    if (!content.trim()) errors.push({ path: row.path, code: 'PACKAGE_EPISODE_INVALID', field: 'Content', message: 'Content must not be empty' })
    if (fm.fields.schema_version !== '0.1' || fm.fields.status !== 'confirmed' || Number(fm.fields.episode_number) !== num) errors.push({ path: row.path, code: 'PACKAGE_EPISODE_INVALID', message: 'episode schema/version/number/status invalid' })
    const cbytes = Buffer.from(content + '\n', 'utf8'); canonicalParts.push(cbytes); if (row !== episodeRows.at(-1)) canonicalParts.push(Buffer.from('\n'))
    const refs = (name: string) => (sec.get(name)?.match(/^[ \t]*-[ \t]+([^\n]+)$/gm) ?? []).map(v => v.replace(/^[ \t]*-[ \t]+/, '').trim())
    episodeData.push({ external_id: fm.fields.episode_id, episode_number: num, title: fm.fields.title, status: fm.fields.status, content_char_count: content.length + 1, content_hash: displayHash(cbytes), character_refs: refs('Character Refs'), scene_refs: refs('Scene Refs'), _characters: refs('Character Refs'), _scenes: refs('Scene Refs') })
  }
  const drama = files.has('drama-package.md') ? frontMatter(files.get('drama-package.md')!.toString('utf8'), 'drama-package.md', errors) : { fields: {}, extensions: {}, body: '' }
  const manifest = files.has(MANIFEST) ? frontMatter(files.get(MANIFEST)!.toString('utf8'), MANIFEST, errors) : { fields: {}, extensions: {}, body: '' }
  const chars = files.has('characters.md') ? entities(frontMatter(files.get('characters.md')!.toString('utf8'), 'characters.md', errors).body, 'character', warnings, errors) : (warnings.push({ path: 'characters.md', message: 'optional characters.md is missing' }), [])
  const scenes = files.has('scenes.md') ? entities(frontMatter(files.get('scenes.md')!.toString('utf8'), 'scenes.md', errors).body, 'scene', warnings, errors) : (warnings.push({ path: 'scenes.md', message: 'optional scenes.md is missing' }), [])
  const charIds = new Set(chars.map(c => c.external_id)); const sceneIds = new Set(scenes.map(s => s.external_id))
  for (const ep of episodeData) { if (chars.length) for (const id of ep._characters as string[]) if (!charIds.has(id)) errors.push({ code: 'PACKAGE_REFERENCE_UNKNOWN', path: String(ep.external_id), message: `unknown character reference ${id}` }); if (scenes.length) for (const id of ep._scenes as string[]) if (!sceneIds.has(id)) errors.push({ code: 'PACKAGE_REFERENCE_UNKNOWN', path: String(ep.external_id), message: `unknown scene reference ${id}` }); delete ep._characters; delete ep._scenes }
  if (drama.fields.schema !== 'jisu-production-package' || drama.fields.schema_version !== '0.1') errors.push({ path: 'drama-package.md', code: 'PACKAGE_SCHEMA_UNSUPPORTED', message: 'unsupported drama package schema/version' })
  for (const key of ['package_id', 'title', 'package_version', 'target_episode_count']) if (drama.fields[key] === undefined) errors.push({ path: 'drama-package.md', field: key, code: 'PACKAGE_MANIFEST_INVALID', message: `missing required field ${key}` })
  if (typeof drama.fields.package_id === 'string' && !/^[a-z0-9][a-z0-9._-]{2,63}$/.test(drama.fields.package_id)) errors.push({ path: 'drama-package.md', field: 'package_id', code: 'PACKAGE_FRONTMATTER_INVALID', message: 'package_id format is invalid' })
  if (Number(drama.fields.target_episode_count) !== episodeData.length) errors.push({ path: 'drama-package.md', field: 'target_episode_count', code: 'PACKAGE_EPISODE_INVALID', message: 'target episode count does not match files' })
  if (Object.keys(drama.extensions).length) warnings.push({ path: 'drama-package.md', code: 'PACKAGE_FILE_UNEXPECTED', message: `unknown front matter fields: ${Object.keys(drama.extensions).join(', ')}` })
  if (!(sections(drama.body).get('Drama Bible') ?? '').trim()) warnings.push({ path: 'drama-package.md', field: 'Drama Bible', message: 'Drama Bible is empty' })
  const canonical = Buffer.concat(canonicalParts)
  const errorList = [...missing, ...errors]
  const diagnostics = { missing, conflicts, warnings, errors: errorList }
  const source: Record<string, unknown> = { source_id: manifest.fields.source_id, human_reviewed: manifest.fields.human_reviewed, processor: manifest.fields.processor }
  const dto: ProductionPackagePreview = { contract_version: '0.1', source_kind: 'markdown_episode_package', target_mode: 'new_project', status: errorList.length ? 'blocked' : 'ready', can_confirm: errorList.length === 0, preview_token: `pv_${crypto.randomBytes(12).toString('hex')}`, package: { package_id: drama.fields.package_id as string, package_version: drama.fields.package_version as number, package_fingerprint: packageFp, validation_fingerprint: validationFp, source_version_canonical_hash: displayHash(canonical), files: rows.map(r => ({ path: r.path, file_hash: `sha256:${r.fileHash}`, byte_length: r.byteLength })) }, project: { title: drama.fields.title, genre: drama.fields.genre, style: drama.fields.style, aspect_ratio: drama.fields.aspect_ratio, target_episode_count: drama.fields.target_episode_count, bible_summary: sections(drama.body).get('Drama Bible') ?? '' }, characters: chars.map(c => ({ external_id: c.external_id, name: c.name, role: c.role, episode_refs: episodeData.filter(e => (e.character_refs as string[]).includes(String(c.external_id))).map(e => e.external_id) })), scenes: scenes.map(s => ({ external_id: s.external_id, location: s.location, time: s.time, episode_refs: episodeData.filter(e => (e.scene_refs as string[]).includes(String(s.external_id))).map(e => e.external_id) })), episodes: episodeData, source, diagnostics, write_plan: { writes_on_parse: [], writes_after_confirm: ['drama', 'source_version', 'episodes', 'characters', 'scenes', 'episode_links'] } }
  return dto
}

export default parseProductionPackage
