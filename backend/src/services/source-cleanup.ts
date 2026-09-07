/**
 * S2 原文整理运行时（Issue #72）。
 *
 * 这个模块只负责可证明的部分：规则健康检查、删除建议质量门、任务生命周期、
 * 以及 cleaned 候选的原子落库。Agent 的提示词/注册由 #73 提供；在适配器未
 * 注册时，路由必须明确拒绝请求，不能用猜测或静默改写代替。
 */
import { createHash, randomUUID } from 'node:crypto'
import type { Pool } from 'mysql2/promise'
import { pool, getInsertId } from '../db/index.js'
import { getActiveConfigWithId, getConfigById } from './ai.js'
import { sourceVersionContentHash } from './source-versions.js'
import { acquireAiRequest } from './request-guard.js'
import { ensureSourceAnchorsInTransaction } from './source-anchors.js'

export const SOURCE_CLEANUP_TYPE = 'source_cleanup'
/** worker 活跃租约：claim 与每次 checkpoint 均续期至此。慢文本模型（如 gpt-5.6-luna）单块调用可达分钟级，
 *  若仅靠初始 60s 租约，恢复服务会把仍在工作的 worker 误判为中断并安全失败（UNSAFE_RECOVERY）。 */
export const SOURCE_CLEANUP_LEASE_MS = 300_000
export const SOURCE_CLEANUP_MAX_CHARS = 200_000
export const SOURCE_CLEANUP_CHUNK_SIZE = 12_000
export const REMOVAL_CATEGORIES = ['ad', 'watermark', 'duplicate', 'garbage'] as const
export type RemovalCategory = (typeof REMOVAL_CATEGORIES)[number]

export interface SourceRemoval {
  start: number
  end: number
  snippet: string
  category: RemovalCategory | string
}

export interface SourceCleanupProposal {
  input_version_id: number
  input_content_hash: string
  removals: SourceRemoval[]
}

export class SourceCleanupProposalError extends Error {
  constructor(public readonly code: 'INVALID_PROPOSAL' | 'STALE_PROPOSAL', message: string) {
    super(message)
  }
}

export interface HealthIssue {
  type: RemovalCategory
  count: number
  sample_ranges: Array<[number, number]>
}

export interface SourceCleanupAdapterInput {
  taskId: number
  dramaId: number
  inputVersionId: number
  inputContentHash: string
  configId: number
  content: string
  chunk: { index: number; start: number; end: number; text: string }
}

export type SourceCleanupAdapter = (input: SourceCleanupAdapterInput) => Promise<SourceCleanupProposal>

// #73 会在 Agent 注册后设置正式适配器。导出测试 setter 是为了让 CI 覆盖真实
// 生命周期而不触发任何收费模型请求。
let cleanupAdapter: SourceCleanupAdapter | null = null
export function registerSourceCleanupAdapter(adapter: SourceCleanupAdapter | null): void {
  cleanupAdapter = adapter
}
// 兼容既有测试调用名；生产注册统一使用 registerSourceCleanupAdapter。
export const setSourceCleanupAdapterForTests = registerSourceCleanupAdapter
export function isSourceCleanupAdapterReady(): boolean {
  return cleanupAdapter !== null
}

const now = () => new Date().toISOString()
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

function rangesForPattern(content: string, pattern: RegExp): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  let match: RegExpExecArray | null
  while ((match = pattern.exec(content)) !== null) {
    ranges.push([match.index, match.index + match[0].length])
    if (match[0].length === 0) pattern.lastIndex += 1
  }
  return ranges
}

/** 纯规则检查：只读取传入内容，不调用 Agent/模型，也不写数据库。 */
export function inspectSourceHealth(rawContent: unknown): { status: 'clean' | 'issues'; issues: HealthIssue[]; char_count: number } {
  const content = String(rawContent ?? '').trim()
  const byType = new Map<RemovalCategory, Array<[number, number]>>()
  const add = (type: RemovalCategory, ranges: Array<[number, number]>) => {
    if (ranges.length) byType.set(type, ranges)
  }
  add('watermark', rangesForPattern(content, /(?:水印|作者(?:有话说|的话)|本章(?:完|未完待续)|首发[：:])[^\n]{0,120}/gi))
  add('ad', rangesForPattern(content, /(?:关注(?:公众号|本号)|加(?:微|V|vx)|免费(?:阅读|领取)|下载(?:APP|客户端)|推广|广告合作)[^\n]{0,120}/gi))
  add('garbage', rangesForPattern(content, /(?:�|[\uE000-\uF8FF]|[~`^_=]{4,}|(?:乱码){2,})+/g))

  // 相同完整段落第二次出现起才是重复；章节标题不参与候选，避免被当作噪声。
  const seen = new Map<string, number>()
  const duplicateRanges: Array<[number, number]> = []
  const paragraph = /[^\n]+/g
  let line: RegExpExecArray | null
  while ((line = paragraph.exec(content)) !== null) {
    const text = line[0].trim()
    if (text.length < 12 || isChapterMarker(text)) continue
    const previous = seen.get(text)
    if (previous !== undefined) duplicateRanges.push([line.index, line.index + line[0].length])
    else seen.set(text, line.index)
  }
  add('duplicate', duplicateRanges)

  const issues = REMOVAL_CATEGORIES.flatMap(type => {
    const ranges = byType.get(type) || []
    return ranges.length ? [{ type, count: ranges.length, sample_ranges: ranges.slice(0, 3) }] : []
  })
  return { status: issues.length ? 'issues' : 'clean', issues, char_count: content.length }
}

function isChapterMarker(text: string): boolean {
  return /^(?:第[0-9一二三四五六七八九十百千零〇两]+[章节卷回]|(?:chapter|卷)[\s\d一二三四五六七八九十]+)/i.test(text.trim())
}

function removalTouchesChapterMarker(content: string, start: number, end: number): boolean {
  const lines = content.split(/(?<=\n)/)
  let offset = 0
  for (const line of lines) {
    const lineEnd = offset + line.length
    if (start < lineEnd && end > offset && isChapterMarker(line)) return true
    offset = lineEnd
  }
  return false
}

/**
 * 删除建议的全量质量门。坐标均为 JS UTF-16 code unit，和 String.slice 一致。
 * 任何一项失败都整体拒绝，不返回部分可用结果。
 */
export function validateSourceCleanupProposal(
  content: string,
  expectedVersionId: number,
  expectedContentHash: string,
  proposal: SourceCleanupProposal,
): SourceRemoval[] {
  if (Number(proposal?.input_version_id) !== expectedVersionId || proposal?.input_content_hash !== expectedContentHash) {
    throw new SourceCleanupProposalError('STALE_PROPOSAL', '整理建议所基于的正文版本已变化，请重新发起')
  }
  if (!Array.isArray(proposal.removals)) {
    throw new SourceCleanupProposalError('INVALID_PROPOSAL', '整理建议缺少 removals 数组')
  }
  let previousEnd = -1
  return proposal.removals.map((raw, index) => {
    const start = Number(raw?.start)
    const end = Number(raw?.end)
    const snippet = String(raw?.snippet ?? '')
    const category = String(raw?.category ?? '')
    const fail = (reason: string) => {
      throw new SourceCleanupProposalError('INVALID_PROPOSAL', `第 ${index + 1} 个删除区间无效：${reason}`)
    }
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > content.length) fail('坐标越界或区间为空')
    if (start < previousEnd) fail('删除区间必须按 start 升序且不得重叠')
    if (!snippet) fail('snippet 不能为空')
    if (!REMOVAL_CATEGORIES.includes(category as RemovalCategory)) fail('category 不在允许集合内')
    if (content.slice(start, end) !== snippet) fail('snippet 与基线坐标内容不一致')
    if (removalTouchesChapterMarker(content, start, end)) fail('章节标题不得作为普通噪声删除')
    previousEnd = end
    return { start, end, snippet, category }
  })
}

export function applySourceRemovals(content: string, removals: SourceRemoval[]): string {
  let cursor = 0
  let cleaned = ''
  for (const item of removals) {
    cleaned += content.slice(cursor, item.start)
    cursor = item.end
  }
  return cleaned + content.slice(cursor)
}

function splitIntoParagraphChunks(content: string): Array<{ index: number; start: number; end: number; text: string }> {
  if (content.length <= SOURCE_CLEANUP_CHUNK_SIZE) return [{ index: 0, start: 0, end: content.length, text: content }]
  const chunks: Array<{ index: number; start: number; end: number; text: string }> = []
  let start = 0
  while (start < content.length) {
    let end = Math.min(content.length, start + SOURCE_CLEANUP_CHUNK_SIZE)
    if (end < content.length) {
      const boundary = content.lastIndexOf('\n', end)
      if (boundary > start) end = boundary + 1
    }
    if (end <= start) end = Math.min(content.length, start + SOURCE_CLEANUP_CHUNK_SIZE)
    chunks.push({ index: chunks.length, start, end, text: content.slice(start, end) })
    start = end
  }
  return chunks
}

interface ResolvedTextConfig { id: number; provider: string; model: string }
async function resolveTextConfig(configId?: unknown): Promise<ResolvedTextConfig> {
  const parsed = configId === undefined || configId === null || configId === '' ? null : Number(configId)
  if (parsed !== null && (!Number.isInteger(parsed) || parsed <= 0)) throw new Error('config_id 必须是合法正整数')
  if (parsed !== null) {
    const [rows] = await pool.query<any[]>('SELECT service_type FROM ai_service_configs WHERE id = ? AND is_active = 1', [parsed])
    if (!rows[0] || rows[0].service_type !== 'text') throw new Error('指定配置必须是已启用的文本模型')
    const config = await getConfigById(parsed)
    if (!config) throw new Error('指定的文本模型配置不存在或未启用')
    return { id: parsed, provider: config.provider, model: config.model }
  }
  const active = await getActiveConfigWithId('text')
  if (!active) throw new Error('未配置可用的文本模型，无法发起原文整理')
  return { id: active.id, provider: active.config.provider, model: active.config.model }
}

/** 只读估算：与 clean 使用同一配置解析规则，绝不创建任务或调用模型。 */
export async function estimateSourceCleanup(dramaId: number, configId?: unknown): Promise<Record<string, unknown>> {
  const config = await resolveTextConfig(configId)
  const [dramas] = await pool.query<any[]>('SELECT id, description, current_source_version_id, deleted_at FROM dramas WHERE id = ?', [dramaId])
  const drama = dramas[0]
  if (!drama || drama.deleted_at) throw new Error('项目不存在')
  let versionId = Number(drama.current_source_version_id || 0)
  let content = String(drama.description ?? '').trim()
  let contentHash = sourceVersionContentHash(content)
  if (versionId) {
    const [versions] = await pool.query<any[]>('SELECT id, content, content_hash FROM source_versions WHERE id = ? AND drama_id = ?', [versionId, dramaId])
    if (!versions[0]) throw new Error('当前原文版本不存在，无法估算')
    versionId = Number(versions[0].id)
    content = String(versions[0].content || '')
    contentHash = String(versions[0].content_hash)
  }
  if (!content) throw new Error('原文为空，无法估算')
  if (content.length > SOURCE_CLEANUP_MAX_CHARS) throw new Error('全文内容超过 20 万字，请先精简后再整理')
  return {
    input_version_id: versionId || null,
    input_content_hash: contentHash,
    char_count: content.length,
    estimated_tokens: Math.ceil(content.length / 2),
    estimated_cost: null,
    pricing_status: 'pricing_unavailable',
    config: { id: config.id, provider: config.provider, model: config.model },
  }
}

export interface SourceCleanupStartResult { status: 'running' | 'already_running'; task_key: string }

/** 在项目行锁内固化基线、执行项目级互斥并创建 sys_task。 */
export async function startSourceCleanup(dramaId: number, configId?: unknown, connectionPool: Pool = pool): Promise<SourceCleanupStartResult> {
  const config = await resolveTextConfig(configId)
  const conn = await connectionPool.getConnection()
  try {
    await conn.beginTransaction()
    try {
      const [dramas] = await conn.query<any[]>('SELECT id, description, current_source_version_id, deleted_at FROM dramas WHERE id = ? FOR UPDATE', [dramaId])
      const drama = dramas[0]
      if (!drama || drama.deleted_at) throw new Error('项目不存在')
      let inputVersionId = Number(drama.current_source_version_id || 0)
      if (!inputVersionId) {
        const content = String(drama.description ?? '').trim()
        if (!content) throw new Error('原文为空，无法发起整理')
        const hash = sourceVersionContentHash(content)
        const ts = now()
        const insert = await conn.execute(
          `INSERT INTO source_versions (drama_id, base_kind, content, content_hash, base_hash, parent_version_id, diff, stats, created_at, updated_at)
           VALUES (?, 'source', ?, ?, ?, NULL, NULL, NULL, ?, ?)`,
          [dramaId, content, hash, hash, ts, ts],
        )
        inputVersionId = getInsertId(insert)
        await conn.execute('UPDATE dramas SET current_source_version_id = ?, updated_at = ? WHERE id = ?', [inputVersionId, ts, dramaId])
      }
      const [versions] = await conn.query<any[]>('SELECT id, content, content_hash FROM source_versions WHERE id = ? AND drama_id = ?', [inputVersionId, dramaId])
      const input = versions[0]
      if (!input) throw new Error('当前原文版本不存在，无法发起整理')
      const content = String(input.content || '')
      if (!content || content.length > SOURCE_CLEANUP_MAX_CHARS) throw new Error(content ? '全文内容超过 20 万字，请先精简后再整理' : '原文为空，无法发起整理')

      const [running] = await conn.query<any[]>(
        `SELECT id FROM sys_task WHERE drama_id = ? AND type = ? AND status = 'processing' ORDER BY id DESC LIMIT 1 FOR UPDATE`,
        [dramaId, SOURCE_CLEANUP_TYPE],
      )
      if (running.length) {
        await conn.commit()
        return { status: 'already_running', task_key: String(running[0].id) }
      }
      const chunks = splitIntoParagraphChunks(content)
      const inputHash = String(input.content_hash)
      const intentKey = sha256(`source_cleanup:v1:${dramaId}:${inputVersionId}:${inputHash}:${config.id}`)
      const params = {
        source_cleanup: {
          config_id: config.id,
          intent_key: intentKey,
          input_version_id: inputVersionId,
          input_content_hash: inputHash,
          phase: 'queued',
          chunk_size: SOURCE_CLEANUP_CHUNK_SIZE,
          checkpoint: {
            input_version_id: inputVersionId,
            input_content_hash: inputHash,
            chunk_count: chunks.length,
            next_chunk_index: 0,
            removals: [],
            estimated_cost: null,
            inflight_chunk_index: null,
            submission_state: 'not_submitted',
            task_id: null,
          },
        },
      }
      const ts = now()
      const insert = await conn.execute(
        `INSERT INTO sys_task (type, drama_id, provider, model, params, task_id, result_url, local_path, status, error_msg, created_at, updated_at, completed_at, recovery_at, recovery_owner)
         VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, 'processing', NULL, ?, ?, NULL, NULL, NULL)`,
        [SOURCE_CLEANUP_TYPE, dramaId, config.provider, config.model, JSON.stringify(params), ts, ts],
      )
      const taskId = getInsertId(insert)
      await conn.commit()
      return { status: 'running', task_key: String(taskId) }
    } catch (error) {
      await conn.rollback()
      throw error
    }
  } finally {
    conn.release()
  }
}

function parseCleanupParams(raw: unknown): any {
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw } catch { return null }
}

async function markCleanupFailed(taskId: number, message: string, detail: Record<string, unknown> = {}): Promise<void> {
  const [rows] = await pool.query<any[]>('SELECT params FROM sys_task WHERE id = ? AND type = ?', [taskId, SOURCE_CLEANUP_TYPE])
  const params = parseCleanupParams(rows[0]?.params) || { source_cleanup: {} }
  params.source_cleanup = { ...(params.source_cleanup || {}), error: { code: detail.code || 'SOURCE_CLEANUP_FAILED', message, ...detail } }
  await pool.query(
    `UPDATE sys_task SET status = 'failed', error_msg = ?, params = ?, updated_at = ?, recovery_at = NULL, recovery_owner = NULL
     WHERE id = ? AND type = ? AND status = 'processing'`,
    [message, JSON.stringify(params), now(), taskId, SOURCE_CLEANUP_TYPE],
  )
}

async function updateCleanupCheckpoint(taskId: number, patch: Record<string, unknown>): Promise<void> {
  const [rows] = await pool.query<any[]>('SELECT params FROM sys_task WHERE id = ? AND type = ? AND status = ?', [taskId, SOURCE_CLEANUP_TYPE, 'processing'])
  const params = parseCleanupParams(rows[0]?.params)
  if (!params?.source_cleanup) throw new Error('整理任务检查点缺失')
  params.source_cleanup = {
    ...params.source_cleanup,
    phase: patch.phase || params.source_cleanup.phase,
    checkpoint: { ...(params.source_cleanup.checkpoint || {}), ...(patch.checkpoint || {}) },
  }
  await pool.query(
    'UPDATE sys_task SET params = ?, recovery_at = ?, updated_at = ? WHERE id = ? AND type = ? AND status = ?',
    [JSON.stringify(params), String(Date.now() + SOURCE_CLEANUP_LEASE_MS), now(), taskId, SOURCE_CLEANUP_TYPE, 'processing'],
  )
}

/** 执行已创建的任务；#73 注册适配器前不会触发该路径。 */
export async function runSourceCleanupTask(taskId: number): Promise<void> {
  const owner = `source-cleanup:${randomUUID()}`
  const claimAt = Date.now()
  const [claim] = await pool.query<any[]>(
    `UPDATE sys_task SET recovery_at = ?, recovery_owner = ?, updated_at = ?
     WHERE id = ? AND type = ? AND status = 'processing'
       AND (recovery_at IS NULL OR recovery_at = '' OR CAST(recovery_at AS UNSIGNED) < ?)`,
    [String(claimAt + SOURCE_CLEANUP_LEASE_MS), owner, now(), taskId, SOURCE_CLEANUP_TYPE, claimAt],
  )
  if (Number((claim as any)?.affectedRows || 0) !== 1) return
  try {
    const [tasks] = await pool.query<any[]>('SELECT * FROM sys_task WHERE id = ? AND type = ?', [taskId, SOURCE_CLEANUP_TYPE])
    const task = tasks[0]
    const params = parseCleanupParams(task?.params)
    const meta = params?.source_cleanup
    if (!task || !meta || !cleanupAdapter) {
      await markCleanupFailed(taskId, '原文整理 Agent 适配器尚未就绪', { code: 'ADAPTER_UNAVAILABLE' })
      return
    }
    const [versions] = await pool.query<any[]>(
      'SELECT id, content, content_hash FROM source_versions WHERE id = ? AND drama_id = ?',
      [meta.input_version_id, task.drama_id],
    )
    const input = versions[0]
    if (!input || String(input.content_hash) !== meta.input_content_hash) {
      await markCleanupFailed(taskId, '整理任务的原文基线已失效，请重新发起', { code: 'STALE_INPUT' })
      return
    }
    const content = String(input.content)
    const chunks = splitIntoParagraphChunks(content)
    const allRemovals: SourceRemoval[] = []
    for (const chunk of chunks) {
      await updateCleanupCheckpoint(taskId, {
        phase: 'cleaning',
        checkpoint: { inflight_chunk_index: chunk.index, submission_state: 'submitting', task_id: null },
      })
      const gate = acquireAiRequest(`source-cleanup:${task.drama_id}`, 3, 1)
      if (!gate.ok) throw new Error(`${gate.message}（请稍后手动重新发起）`)
      let proposal: SourceCleanupProposal
      try {
        proposal = await cleanupAdapter!({
          taskId, dramaId: Number(task.drama_id), inputVersionId: Number(input.id), inputContentHash: String(input.content_hash), configId: Number(meta.config_id), content, chunk,
        })
      } finally {
        gate.release()
      }
      const checked = validateSourceCleanupProposal(content, Number(input.id), String(input.content_hash), proposal)
      allRemovals.push(...checked)
      await updateCleanupCheckpoint(taskId, {
        checkpoint: { next_chunk_index: chunk.index + 1, removals: allRemovals, inflight_chunk_index: null, submission_state: 'not_submitted', task_id: null },
      })
    }
    allRemovals.sort((a, b) => a.start - b.start)
    const checked = validateSourceCleanupProposal(content, Number(input.id), String(input.content_hash), {
      input_version_id: Number(input.id), input_content_hash: String(input.content_hash), removals: allRemovals,
    })
    await updateCleanupCheckpoint(taskId, { phase: 'verifying' })
    const cleaned = applySourceRemovals(content, checked)
    await completeSourceCleanupTask(taskId, Number(task.drama_id), Number(input.id), String(input.content_hash), cleaned, checked)
  } catch (error: any) {
    const detail = error instanceof SourceCleanupProposalError ? { code: error.code } : { code: 'SOURCE_CLEANUP_FAILED' }
    await markCleanupFailed(taskId, error?.message || '原文整理失败', detail)
  }
}

/** 路由层只创建任务后排入本进程后台；恢复服务负责进程中断后的安全续跑。 */
export function queueSourceCleanupTask(taskId: number): void {
  setImmediate(() => {
    void runSourceCleanupTask(taskId)
  })
}

async function completeSourceCleanupTask(taskId: number, dramaId: number, inputVersionId: number, inputHash: string, cleaned: string, removals: SourceRemoval[]): Promise<void> {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [tasks] = await conn.query<any[]>('SELECT * FROM sys_task WHERE id = ? AND type = ? FOR UPDATE', [taskId, SOURCE_CLEANUP_TYPE])
    const task = tasks[0]
    if (!task || task.status !== 'processing') { await conn.commit(); return }
    const params = parseCleanupParams(task.params)
    if (params?.source_cleanup?.cleaned_version_id) { await conn.commit(); return }
    const [versions] = await conn.query<any[]>('SELECT id, content_hash FROM source_versions WHERE id = ? AND drama_id = ?', [inputVersionId, dramaId])
    if (!versions[0] || String(versions[0].content_hash) !== inputHash) throw new Error('整理任务的原文基线已失效，请重新发起')
    const contentHash = sourceVersionContentHash(cleaned)
    const ts = now()
    const insert = await conn.execute(
      `INSERT INTO source_versions (drama_id, base_kind, content, content_hash, base_hash, parent_version_id, diff, stats, created_at, updated_at)
       VALUES (?, 'cleaned', ?, ?, ?, ?, ?, ?, ?, ?)`,
      [dramaId, cleaned, contentHash, inputHash, inputVersionId, JSON.stringify({ removals }), JSON.stringify({ removed_chars: removals.reduce((sum, item) => sum + item.end - item.start, 0), removal_count: removals.length }), ts, ts],
    )
    const cleanedVersionId = getInsertId(insert)
    // cleaned 版本刚创建即在同一事务生成其专属锚点；未确认候选只拥有自身锚点，
    // 不会改 dramas.current_source_version_id 或污染当前正文消费者。
    await ensureSourceAnchorsInTransaction(conn, dramaId, cleanedVersionId)
    params.source_cleanup = {
      ...(params.source_cleanup || {}), phase: 'ready', cleaned_version_id: cleanedVersionId,
      checkpoint: { ...(params.source_cleanup?.checkpoint || {}), next_chunk_index: params.source_cleanup?.checkpoint?.chunk_count || 1, inflight_chunk_index: null, submission_state: 'not_submitted', task_id: null, removals },
    }
    await conn.execute(
      `UPDATE sys_task SET status = 'completed', params = ?, task_id = NULL, error_msg = NULL, completed_at = ?, updated_at = ?, recovery_at = NULL, recovery_owner = NULL
       WHERE id = ? AND status = 'processing'`,
      [JSON.stringify(params), ts, ts, taskId],
    )
    await conn.commit()
  } catch (error) {
    await conn.rollback()
    throw error
  } finally {
    conn.release()
  }
}

/** 启动恢复专用：只允许安全的 not_submitted 检查点续跑；未知送达状态一律失败。 */
export async function resumeSourceCleanupTask(taskId: number): Promise<void> {
  const [tasks] = await pool.query<any[]>('SELECT params FROM sys_task WHERE id = ? AND type = ? AND status = ?', [taskId, SOURCE_CLEANUP_TYPE, 'processing'])
  const checkpoint = parseCleanupParams(tasks[0]?.params)?.source_cleanup?.checkpoint
  if (!checkpoint || checkpoint.submission_state === 'submitting' || (checkpoint.submission_state === 'accepted' && !checkpoint.task_id)) {
    await markCleanupFailed(taskId, '整理任务在服务中断时处于未知送达状态，请手动重新发起', { code: 'UNSAFE_RECOVERY' })
    return
  }
  if (checkpoint.submission_state === 'accepted') {
    await markCleanupFailed(taskId, '当前整理 Agent 不支持查询上游任务状态，请手动重新发起', { code: 'UPSTREAM_STATUS_UNAVAILABLE' })
    return
  }
  if (checkpoint.submission_state !== 'not_submitted' || checkpoint.inflight_chunk_index !== null) {
    await markCleanupFailed(taskId, '整理任务检查点损坏，请手动重新发起', { code: 'INVALID_CHECKPOINT' })
    return
  }
  await runSourceCleanupTask(taskId)
}
