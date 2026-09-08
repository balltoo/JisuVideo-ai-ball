import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import yaml from 'js-yaml'

export type Diagnostic = {
  severity: 'error' | 'warning'
  path: string
  field?: string
  code: string
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
  }
  write_plan: { writes_on_parse: []; writes_after_confirm: string[] }
}

const MANIFEST = 'source-manifest.md'
const EPISODE_RE = /^episodes\/(\d{3})\.md$/
const REQUIRED = ['drama-package.md', MANIFEST]
const OPTIONAL = new Set(['characters.md', 'scenes.md'])
const CHARACTER_FIELDS = ['name', 'role', 'description', 'appearance', 'personality', 'styling'] as const
const SCENE_FIELDS = ['location', 'time', 'prompt', 'lighting', 'description'] as const

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

const KNOWN_FRONT_MATTER_FIELDS = new Set([
  'schema', 'schema_version', 'package_id', 'package_version', 'title',
  'target_episode_count', 'genre', 'style', 'aspect_ratio', 'logline',
  'audience', 'language', 'episode_id', 'episode_number', 'status',
  'source_id', 'source_kind', 'processed_at', 'processor', 'human_reviewed',
  'package_fingerprint', 'original_name', 'original_uri', 'original_content_hash',
  'processing_steps', 'reviewer_note',
])

function frontMatter(text: string, file: string, errors: Diagnostic[]) {
  const start = text.startsWith('---\n') ? 0 : -1
  if (start < 0) { errors.push({ severity: 'error', path: file, code: 'PACKAGE_FRONTMATTER_INVALID', message: 'front matter must start at byte offset 0' }); return { fields: {}, extensions: {}, body: text } }
  const closing = /\n---(?:\n|$)/.exec(text.slice(start + 4))
  if (!closing) {
    errors.push({ severity: 'error', path: file, code: 'PACKAGE_FRONTMATTER_INVALID', message: 'front matter closing --- is missing' })
    return { fields: {}, extensions: {}, body: text }
  }
  const end = start + 4 + closing.index
  const head = text.slice(start + 4, end)
  const body = text.slice(end + closing[0].length)
  const fields: Record<string, unknown> = {}
  const extensions: Record<string, unknown> = {}
  let parsed: unknown
  try {
    parsed = yaml.load(head, { schema: yaml.JSON_SCHEMA })
  } catch (error) {
    errors.push({ severity: 'error', path: file, code: 'PACKAGE_FRONTMATTER_INVALID', message: `invalid YAML front matter: ${error instanceof Error ? error.message : String(error)}` })
    return { fields, extensions, body }
  }
  if (parsed !== undefined && (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))) {
    errors.push({ severity: 'error', path: file, code: 'PACKAGE_FRONTMATTER_INVALID', message: 'front matter must be a YAML mapping' })
    return { fields, extensions, body }
  }
  for (const [key, value] of Object.entries((parsed ?? {}) as Record<string, unknown>)) {
    ;(KNOWN_FRONT_MATTER_FIELDS.has(key) ? fields : extensions)[key] = value
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

function entities(body: string, kind: 'character' | 'scene', file: string, extensions: Record<string, unknown>, errors: Diagnostic[]) {
  const out: Array<Record<string, unknown>> = []
  const allowedFields = new Set<string>(kind === 'character' ? CHARACTER_FIELDS : SCENE_FIELDS)
  const re = new RegExp(`^##\\s+${kind}:\\s*([^\\n]+)\\n`, 'gm')
  const matches = [...body.matchAll(re)]
  const seen = new Set<string>()
  matches.forEach((m, i) => {
    const id = m[1].trim(); const end = i + 1 < matches.length ? matches[i + 1].index! : body.length
    const fields = bulletFields(body.slice(m.index! + m[0].length, end))
    if (seen.has(id)) errors.push({ severity: 'error', path: file, field: 'external_id', code: 'PACKAGE_DUPLICATE_ID', message: `duplicate ${kind} external_id ${id}` })
    if (!/^[A-Za-z0-9._-]+$/.test(id)) errors.push({ severity: 'error', path: file, field: 'external_id', code: 'PACKAGE_FRONTMATTER_INVALID', message: `${kind} external_id must be non-empty ASCII` })
    seen.add(id)
    if (kind === 'character' && !fields.name) errors.push({ severity: 'error', path: file, field: 'name', code: 'PACKAGE_FRONTMATTER_INVALID', message: `character ${id} requires name` })
    if (kind === 'scene' && (!fields.location || !fields.time)) errors.push({ severity: 'error', path: file, field: 'location/time', code: 'PACKAGE_FRONTMATTER_INVALID', message: `scene ${id} requires location and time` })
    // Entity markdown is descriptive data only. Keep an explicit allowlist so
    // fields such as image/video URLs, final_prompt and instructions cannot be
    // silently discarded by the DTO projection. A plain scene `prompt` is a
    // contract-approved descriptive field and remains valid.
    const forbiddenField = Object.keys(fields).find(field => !allowedFields.has(field))
    const forbiddenValue = Object.entries(fields).find(([field, value]) => {
      if (typeof value !== 'string') return false
      // YAML/Markdown values may quote a path and continue with descriptive
      // prose. Strip only a leading quote before checking the path prefix so
      // `"/opt/assets/x.png", ...` cannot bypass the absolute-path guard.
      const candidate = value.trim().replace(/^['"]/, '')
      return /^[A-Za-z]:[\\/]/.test(candidate)
        || candidate.startsWith('\\')
        || candidate.startsWith('/')
        || candidate.toLowerCase().startsWith('file:')
    })
    if (forbiddenField) errors.push({ severity: 'error', path: file, field: forbiddenField, code: 'PACKAGE_FRONTMATTER_INVALID', message: `${kind} contains unsupported or forbidden field ${forbiddenField}` })
    if (forbiddenValue) errors.push({ severity: 'error', path: file, field: forbiddenValue[0], code: 'PACKAGE_FRONTMATTER_INVALID', message: `${kind} contains a local absolute path` })
    out.push({ external_id: id, ...fields, extensions })
  })
  return out
}

function extensionWarning(file: string, extensions: Record<string, unknown>, warnings: Diagnostic[]) {
  if (Object.keys(extensions).length) warnings.push({ severity: 'warning', path: file, field: 'extensions', code: 'PACKAGE_FILE_UNEXPECTED', message: `unknown front matter fields: ${Object.keys(extensions).sort().join(', ')}` })
}

function unsafeExposedValue(value: unknown): 'path' | 'secret' | null {
  if (typeof value !== 'string') return null
  const candidate = value.trim().replace(/^['"]/, '')
  if (/^[A-Za-z]:[\\/]/.test(candidate) || candidate.startsWith('\\') || candidate.startsWith('/') || candidate.toLowerCase().startsWith('file:')) return 'path'
  if (/(?:sk-[A-Za-z0-9_-]{4,}|(?:api[_-]?key|token|secret|password|authorization)\s*(?::|=|\s)\s*\S+|bearer\s+\S+)/i.test(candidate)) return 'secret'
  return null
}

function collectUnsafeExposedValues(value: unknown, pathPrefix: string, fieldPrefix: string, diagnostics: Diagnostic[]) {
  const unsafe = unsafeExposedValue(value)
  if (unsafe) {
    diagnostics.push({
      severity: 'error',
      path: pathPrefix,
      field: fieldPrefix,
      code: 'PACKAGE_FRONTMATTER_INVALID',
      message: unsafe === 'path' ? 'DTO contains a local absolute path or file URI' : 'DTO contains credential or secret material',
    })
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectUnsafeExposedValues(item, pathPrefix, `${fieldPrefix}[${index}]`, diagnostics))
    return
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (/(?:api[_-]?key|token|secret|password|authorization)/i.test(key) && item !== undefined && item !== null && item !== '') {
        diagnostics.push({ severity: 'error', path: pathPrefix, field: fieldPrefix ? `${fieldPrefix}.${key}` : key, code: 'PACKAGE_FRONTMATTER_INVALID', message: 'DTO contains credential or secret material' })
        continue
      }
      collectUnsafeExposedValues(item, pathPrefix, fieldPrefix ? `${fieldPrefix}.${key}` : key, diagnostics)
    }
  }
}

function stableDiagnostics(items: Diagnostic[]): Diagnostic[] {
  return items
    .map(diagnostic => ({ ...diagnostic, field: diagnostic.field ?? '' }))
    .sort((a, b) => `${a.path}\0${a.field}\0${a.code}\0${a.message}`.localeCompare(`${b.path}\0${b.field}\0${b.code}\0${b.message}`))
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
  if (options.targetMode && options.targetMode !== 'new_project') errors.push({ severity: 'error', path: '.', code: 'PACKAGE_TARGET_UNSUPPORTED', message: 'v0.1 only supports new_project target' })
  let packageIsDirectory = false
  try { packageIsDirectory = fs.statSync(packageRoot).isDirectory() } catch { /* handled as PACKAGE_EMPTY below */ }
  if (!packageIsDirectory) errors.push({ severity: 'error', path: '.', code: 'PACKAGE_EMPTY', message: 'package directory does not exist or is empty' })
  const files = new Map<string, Buffer>(); const rows: Array<{ path: string; fileHash: string; byteLength: number }> = []
  let packagePaths: string[] = []
  if (packageIsDirectory) {
    try { packagePaths = walk(packageRoot) } catch { errors.push({ severity: 'error', path: '.', code: 'PACKAGE_EMPTY', message: 'package directory could not be read' }) }
    if (packagePaths.length === 0) errors.push({ severity: 'error', path: '.', code: 'PACKAGE_EMPTY', message: 'package directory does not contain any files' })
  }
  for (const rel of packagePaths) {
    try {
      const normalized = normalize(fs.readFileSync(path.join(packageRoot, rel))); files.set(rel, normalized); rows.push({ path: rel, fileHash: sha256(normalized), byteLength: normalized.length })
    } catch (e) { errors.push({ severity: 'error', path: rel, code: 'PACKAGE_ENCODING_INVALID', message: String(e).replace(/^Error:\s*/, '') }) }
  }
  const known = new Set([...REQUIRED, ...OPTIONAL]);
  for (const rel of rows.map(r => r.path)) if (!known.has(rel) && !EPISODE_RE.test(rel)) warnings.push({ severity: 'warning', path: rel, code: 'PACKAGE_FILE_UNEXPECTED', message: `unexpected file ${rel}` })
  for (const rel of REQUIRED) if (!files.has(rel)) missing.push({ severity: 'error', path: rel, code: 'PACKAGE_FILE_MISSING', message: `required file missing: ${rel}` })
  const packageFp = displayHash(Buffer.from(rows.filter(r => r.path !== MANIFEST).map(r => `${r.path}\0${r.fileHash}\n`).join('')))
  const validationFp = displayHash(Buffer.from(rows.map(r => `${r.path}\0${r.fileHash}\n`).join('')))
  const episodeRows = rows.filter(r => EPISODE_RE.test(r.path)).sort((a, b) => a.path.localeCompare(b.path))
  const episodeNumbers = episodeRows.map(r => Number(EPISODE_RE.exec(r.path)![1]))
  if (!episodeNumbers.length || episodeNumbers[0] !== 1) {
    // The first episode is a required package layout entry. A present 001
    // followed by a gap is different: that is a semantic numbering conflict.
    missing.push({ severity: 'error', path: 'episodes/001.md', code: 'PACKAGE_FILE_MISSING', message: 'required episode file missing: episodes/001.md' })
  } else if (episodeNumbers.some((n, i) => n !== i + 1)) {
    conflicts.push({ severity: 'error', path: 'episodes/', field: 'episode_number', code: 'PACKAGE_EPISODE_INVALID', message: 'episode files must be numbered continuously from 001' })
  }
  const episodeData: Array<Record<string, unknown>> = []; const canonicalParts: Buffer[] = []
  for (const row of episodeRows) {
    const num = Number(EPISODE_RE.exec(row.path)![1]); const text = files.get(row.path)!.toString('utf8'); const fm = frontMatter(text, row.path, errors); extensionWarning(row.path, fm.extensions, warnings); const sec = sections(fm.body); const content = contentSection(fm.body)
    if (!content.trim()) errors.push({ severity: 'error', path: row.path, code: 'PACKAGE_EPISODE_INVALID', field: 'Content', message: 'Content must not be empty' })
    if (fm.fields.schema_version !== '0.1' || fm.fields.status !== 'confirmed' || !Number.isInteger(fm.fields.episode_number) || fm.fields.episode_number !== num) errors.push({ severity: 'error', path: row.path, code: 'PACKAGE_EPISODE_INVALID', field: 'schema_version/episode_number/status', message: 'episode schema/version/number/status invalid' })
    const cbytes = Buffer.from(content + '\n', 'utf8'); canonicalParts.push(cbytes); if (row !== episodeRows.at(-1)) canonicalParts.push(Buffer.from('\n'))
    const refs = (name: string) => (sec.get(name)?.match(/^[ \t]*-[ \t]+([^\n]+)$/gm) ?? []).map(v => v.replace(/^[ \t]*-[ \t]+/, '').trim())
    episodeData.push({ external_id: fm.fields.episode_id, episode_number: num, title: fm.fields.title, status: fm.fields.status, content_char_count: content.length, content_hash: displayHash(cbytes), character_refs: refs('Character Refs').sort(), scene_refs: refs('Scene Refs').sort(), extensions: fm.extensions, _characters: refs('Character Refs'), _scenes: refs('Scene Refs') })
  }
  const drama = files.has('drama-package.md') ? frontMatter(files.get('drama-package.md')!.toString('utf8'), 'drama-package.md', errors) : { fields: {}, extensions: {}, body: '' }
  const manifest = files.has(MANIFEST) ? frontMatter(files.get(MANIFEST)!.toString('utf8'), MANIFEST, errors) : { fields: {}, extensions: {}, body: '' }
  const charsFile = files.has('characters.md') ? frontMatter(files.get('characters.md')!.toString('utf8'), 'characters.md', errors) : null
  const scenesFile = files.has('scenes.md') ? frontMatter(files.get('scenes.md')!.toString('utf8'), 'scenes.md', errors) : null
  if (charsFile) extensionWarning('characters.md', charsFile.extensions, warnings)
  if (scenesFile) extensionWarning('scenes.md', scenesFile.extensions, warnings)
  const chars = charsFile ? entities(charsFile.body, 'character', 'characters.md', charsFile.extensions, errors) : (warnings.push({ severity: 'warning', path: 'characters.md', code: 'PACKAGE_FILE_MISSING', message: 'optional characters.md is missing' }), [])
  const scenes = scenesFile ? entities(scenesFile.body, 'scene', 'scenes.md', scenesFile.extensions, errors) : (warnings.push({ severity: 'warning', path: 'scenes.md', code: 'PACKAGE_FILE_MISSING', message: 'optional scenes.md is missing' }), [])
  const charIds = new Set(chars.map(c => c.external_id)); const sceneIds = new Set(scenes.map(s => s.external_id))
  for (const ep of episodeData) { for (const id of ep._characters as string[]) if (!charIds.has(id)) errors.push({ severity: 'error', code: 'PACKAGE_REFERENCE_UNKNOWN', path: `episodes/${String(ep.episode_number).padStart(3, '0')}.md`, field: 'Character Refs', message: `unknown character reference ${id}` }); for (const id of ep._scenes as string[]) if (!sceneIds.has(id)) errors.push({ severity: 'error', code: 'PACKAGE_REFERENCE_UNKNOWN', path: `episodes/${String(ep.episode_number).padStart(3, '0')}.md`, field: 'Scene Refs', message: `unknown scene reference ${id}` }); delete ep._characters; delete ep._scenes }
  if (drama.fields.schema !== 'jisu-production-package' || drama.fields.schema_version !== '0.1') errors.push({ severity: 'error', path: 'drama-package.md', code: 'PACKAGE_SCHEMA_UNSUPPORTED', message: 'unsupported drama package schema/version' })
  for (const key of ['package_id', 'title', 'package_version', 'target_episode_count']) if (drama.fields[key] === undefined) errors.push({ severity: 'error', path: 'drama-package.md', field: key, code: 'PACKAGE_MANIFEST_INVALID', message: `missing required field ${key}` })
  if (typeof drama.fields.package_id !== 'string' || !/^[a-z0-9][a-z0-9._-]{2,63}$/.test(drama.fields.package_id)) errors.push({ severity: 'error', path: 'drama-package.md', field: 'package_id', code: 'PACKAGE_FRONTMATTER_INVALID', message: 'package_id must match ^[a-z0-9][a-z0-9._-]{2,63}$' })
  if (typeof drama.fields.title !== 'string' || drama.fields.title.trim().length < 1 || drama.fields.title.length > 200) errors.push({ severity: 'error', path: 'drama-package.md', field: 'title', code: 'PACKAGE_FRONTMATTER_INVALID', message: 'title must be 1-200 characters after trimming' })
  if (!Number.isInteger(drama.fields.package_version) || (drama.fields.package_version as number) < 1) errors.push({ severity: 'error', path: 'drama-package.md', field: 'package_version', code: 'PACKAGE_FRONTMATTER_INVALID', message: 'package_version must be a positive integer' })
  if (!Number.isInteger(drama.fields.target_episode_count) || (drama.fields.target_episode_count as number) < 1) errors.push({ severity: 'error', path: 'drama-package.md', field: 'target_episode_count', code: 'PACKAGE_EPISODE_INVALID', message: 'target_episode_count must be a positive integer' })
  if (Number(drama.fields.target_episode_count) !== episodeData.length) errors.push({ severity: 'error', path: 'drama-package.md', field: 'target_episode_count', code: 'PACKAGE_EPISODE_INVALID', message: 'target episode count does not match files' })
  if (Object.keys(drama.extensions).length) warnings.push({ severity: 'warning', path: 'drama-package.md', field: 'extensions', code: 'PACKAGE_FILE_UNEXPECTED', message: `unknown front matter fields: ${Object.keys(drama.extensions).join(', ')}` })
  if (!(sections(drama.body).get('Drama Bible') ?? '').trim()) warnings.push({ severity: 'warning', path: 'drama-package.md', field: 'Drama Bible', code: 'PACKAGE_FILE_UNEXPECTED', message: 'Drama Bible is empty' })
  const manifestRequired = ['schema_version', 'source_id', 'source_kind', 'processed_at', 'processor', 'human_reviewed', 'package_fingerprint']
  extensionWarning(MANIFEST, manifest.extensions, warnings)
  for (const key of manifestRequired) if (manifest.fields[key] === undefined) errors.push({ severity: 'error', path: MANIFEST, field: key, code: 'PACKAGE_MANIFEST_INVALID', message: `missing required field ${key}` })
  if (manifest.fields.schema_version !== '0.1') errors.push({ severity: 'error', path: MANIFEST, field: 'schema_version', code: 'PACKAGE_SCHEMA_UNSUPPORTED', message: 'manifest schema_version must be 0.1' })
  if (typeof manifest.fields.source_id !== 'string' || !manifest.fields.source_id.trim()) errors.push({ severity: 'error', path: MANIFEST, field: 'source_id', code: 'PACKAGE_MANIFEST_INVALID', message: 'source_id must be a non-empty string' })
  if (!['external_prepared', 'external_episodic'].includes(String(manifest.fields.source_kind))) errors.push({ severity: 'error', path: MANIFEST, field: 'source_kind', code: 'PACKAGE_MANIFEST_INVALID', message: 'source_kind enum invalid' })
  if (typeof manifest.fields.processor !== 'string' || !manifest.fields.processor.trim()) errors.push({ severity: 'error', path: MANIFEST, field: 'processor', code: 'PACKAGE_MANIFEST_INVALID', message: 'processor must be a non-empty string' })
  const processor = manifest.fields.processor
  const processorLooksLikeToolVersion = typeof processor === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\s+v?\d+(?:\.[A-Za-z0-9]+)*)$/.test(processor.trim())
  if (typeof processor === 'string' && (!processorLooksLikeToolVersion || /(?:sk-[A-Za-z0-9_-]{4,}|(?:api[_-]?key|token|secret)\s*[:=]?\s*\S+|bearer\s+\S+)/i.test(processor))) errors.push({ severity: 'error', path: MANIFEST, field: 'processor', code: 'PACKAGE_MANIFEST_INVALID', message: 'processor must be a tool name plus version and must not contain credentials or secret material' })
  if (manifest.fields.human_reviewed !== true) errors.push({ severity: 'error', path: MANIFEST, field: 'human_reviewed', code: 'PACKAGE_MANIFEST_INVALID', message: 'human_reviewed must be true' })
  const iso8601 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/
  const processedAt = typeof manifest.fields.processed_at === 'string' ? iso8601.exec(manifest.fields.processed_at) : null
  const validProcessedAt = !!processedAt && Number(processedAt[2]) >= 1 && Number(processedAt[2]) <= 12 && Number(processedAt[3]) >= 1 && Number(processedAt[3]) <= new Date(Number(processedAt[1]), Number(processedAt[2]), 0).getDate() && Number(processedAt[4]) <= 23 && Number(processedAt[5]) <= 59 && Number(processedAt[6]) <= 59 && (processedAt[7] === 'Z' || (Number(processedAt[8]) <= 23 && Number(processedAt[9]) <= 59)) && !Number.isNaN(Date.parse(manifest.fields.processed_at as string))
  if (!validProcessedAt) errors.push({ severity: 'error', path: MANIFEST, field: 'processed_at', code: 'PACKAGE_MANIFEST_INVALID', message: 'processed_at must be ISO-8601 date-time with timezone' })
  if (typeof manifest.fields.package_fingerprint !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(manifest.fields.package_fingerprint)) errors.push({ severity: 'error', path: MANIFEST, field: 'package_fingerprint', code: 'PACKAGE_MANIFEST_INVALID', message: 'package_fingerprint must be sha256:<64 lowercase hex>' })
  else if (manifest.fields.package_fingerprint !== packageFp) errors.push({ severity: 'error', path: MANIFEST, field: 'package_fingerprint', code: 'PACKAGE_HASH_MISMATCH', message: 'manifest package_fingerprint does not match computed fingerprint' })
  const epIds = new Set<string>()
  for (const ep of episodeData) {
    if (typeof ep.external_id !== 'string' || !/^[A-Za-z0-9._-]+$/.test(ep.external_id) || !ep.external_id) errors.push({ severity: 'error', path: `episodes/${String(ep.episode_number).padStart(3, '0')}.md`, field: 'episode_id', code: 'PACKAGE_EPISODE_INVALID', message: 'episode_id is required and must be ASCII' })
    if (epIds.has(String(ep.external_id))) errors.push({ severity: 'error', path: 'episodes/', field: 'episode_id', code: 'PACKAGE_DUPLICATE_ID', message: `duplicate episode_id ${ep.external_id}` }); epIds.add(String(ep.external_id))
    if (typeof ep.title !== 'string' || !ep.title.trim()) errors.push({ severity: 'error', path: `episodes/${String(ep.episode_number).padStart(3, '0')}.md`, field: 'title', code: 'PACKAGE_EPISODE_INVALID', message: 'episode title is required' })
  }
  const canonical = Buffer.concat(canonicalParts)
  const errorList = [...missing, ...conflicts, ...errors]
  const diagnostics = { missing: stableDiagnostics(missing), conflicts: [...stableDiagnostics(conflicts), ...stableDiagnostics(errors)], warnings: stableDiagnostics(warnings) }
  const source: Record<string, unknown> = { source_id: manifest.fields.source_id, human_reviewed: manifest.fields.human_reviewed, processor: manifest.fields.processor }
  chars.sort((a, b) => String(a.external_id).localeCompare(String(b.external_id))); scenes.sort((a, b) => String(a.external_id).localeCompare(String(b.external_id)))
  const projectFields = (entity: Record<string, unknown>, fields: readonly string[]) => Object.fromEntries(fields.map(field => [field, entity[field]]))
  const dto: ProductionPackagePreview = { contract_version: '0.1', source_kind: 'markdown_episode_package', target_mode: 'new_project', status: errorList.length ? 'blocked' : 'ready', can_confirm: errorList.length === 0, preview_token: `pv_${crypto.randomBytes(12).toString('hex')}`, package: { package_id: drama.fields.package_id as string, package_version: drama.fields.package_version as number, package_fingerprint: packageFp, validation_fingerprint: validationFp, source_version_canonical_hash: displayHash(canonical), files: rows.map(r => ({ path: r.path, file_hash: `sha256:${r.fileHash}`, byte_length: r.byteLength })) }, project: { title: drama.fields.title, genre: drama.fields.genre, style: drama.fields.style, aspect_ratio: drama.fields.aspect_ratio, target_episode_count: drama.fields.target_episode_count, bible_summary: sections(drama.body).get('Drama Bible') ?? '', extensions: drama.extensions }, characters: chars.map(c => ({ external_id: c.external_id, ...projectFields(c, CHARACTER_FIELDS), episode_refs: episodeData.filter(e => (e.character_refs as string[]).includes(String(c.external_id))).map(e => e.external_id), extensions: c.extensions })), scenes: scenes.map(s => ({ external_id: s.external_id, ...projectFields(s, SCENE_FIELDS), episode_refs: episodeData.filter(e => (e.scene_refs as string[]).includes(String(s.external_id))).map(e => e.external_id), extensions: s.extensions })), episodes: episodeData, source: { ...source, extensions: manifest.extensions }, diagnostics, write_plan: { writes_on_parse: [], writes_after_confirm: ['drama', 'source_version', 'episodes', 'characters', 'scenes', 'episode_links'] } }
  const exposedDiagnostics: Diagnostic[] = []
  collectUnsafeExposedValues(dto.project, 'drama-package.md', 'project', exposedDiagnostics)
  // Character/scene allowlisted fields are already checked at parse time;
  // scan their extensions here to catch nested untrusted values without
  // duplicating the same field diagnostic in the preview.
  collectUnsafeExposedValues(dto.characters.map(character => character.extensions), 'characters.md', 'characters.extensions', exposedDiagnostics)
  collectUnsafeExposedValues(dto.scenes.map(scene => scene.extensions), 'scenes.md', 'scenes.extensions', exposedDiagnostics)
  collectUnsafeExposedValues(dto.episodes, 'episodes/', 'episodes', exposedDiagnostics)
  collectUnsafeExposedValues(dto.source.extensions, MANIFEST, 'source.extensions', exposedDiagnostics)
  if (exposedDiagnostics.length) {
    dto.status = 'blocked'
    dto.can_confirm = false
    dto.diagnostics.conflicts = stableDiagnostics([...dto.diagnostics.conflicts, ...exposedDiagnostics])
  }
  return dto
}

export default parseProductionPackage
