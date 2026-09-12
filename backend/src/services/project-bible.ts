/**
 * 项目圣经（大纲与全局设定）—— Issue #121 批次 A
 *
 * 设计对齐既有版本行范式（source_versions / v0.4 契约 I7）：
 * - 版本行不可变：每次确认 INSERT 一行，历史可查、不可被静默覆盖；
 * - dramas.current_bible_version_id 指针指向当前生效版本，NULL 表示旧项目/尚未创建（空态）；
 * - 写入使用事务 + 锁 dramas 行 + expected_version_id 乐观锁，不一致抛 ProjectBibleConflict（路由转 409）。
 *
 * 数据结构对齐 docs/long-form-production-package-plan.md §5.1「全剧大纲」字段：
 * 一句话卖点 / 题材 / 受众 / 情绪基调 / 画面风格 / 世界观与现实规则 / 主线冲突 /
 * 核心悬念 / 结局承诺 / 全剧阶段结构 / 伏笔 / 禁区 / 每集目标与承接关系。
 */
import { createHash } from 'node:crypto'
import type { Pool } from 'mysql2/promise'
import { pool, getInsertId } from '../db/index.js'

/** 项目圣经来源（版本行 source 列白名单） */
export const PROJECT_BIBLE_SOURCES = ['manual', 'package-import', 'system'] as const
export type ProjectBibleSource = (typeof PROJECT_BIBLE_SOURCES)[number]

export class ProjectBibleConflict extends Error {}
export class ProjectBibleNotFound extends Error {}

export interface ProjectBibleStage {
  name: string
  goal: string
  episode_range: string
}

export interface ProjectBibleEpisode {
  episode_number: number
  objective: string
  hook: string
  previous_recap: string
  next_teaser: string
}

export interface ProjectBible {
  logline: string
  genre: string
  audience: string
  tone: string
  visual_style: string
  worldview: string
  main_conflict: string
  core_suspense: string
  ending_promise: string
  stages: ProjectBibleStage[]
  foreshadowing: string[]
  forbidden: string[]
  episodes: ProjectBibleEpisode[]
}

export interface ProjectBibleView {
  version_id: number | null
  source: string | null
  content_hash: string | null
  created_at: string | null
  updated_at: string | null
  has_data: boolean
  bible: ProjectBible | null
}

function text(value: unknown, max: number, label: string) {
  const raw = String(value ?? '').trim()
  if (raw.length > max) throw new Error(`${label}超过 ${max} 字上限`)
  return raw
}

function textList(value: unknown, max: number, itemMax: number, label: string) {
  const list = Array.isArray(value) ? value : []
  if (list.length > max) throw new Error(`${label}最多 ${max} 条`)
  return list.map(item => text(item, itemMax, label)).filter(Boolean)
}

/**
 * 规范化大纲输入：字段修剪 + 限长；阶段/每集条目结构化。
 * 每集集号保留调用方传入的合法正整数（与剧集列表对应），非法或缺失时按顺序补号，去重后升序。
 */
export function normalizeProjectBible(raw: any): ProjectBible {
  const source = raw && typeof raw === 'object' ? raw : {}

  const stagesRaw = Array.isArray(source.stages) ? source.stages : []
  if (stagesRaw.length > 20) throw new Error('阶段结构最多 20 条')
  const stages = stagesRaw.map((item: any, index: number) => ({
    name: text(item?.name, 100, `第 ${index + 1} 阶段名称`),
    goal: text(item?.goal, 1000, `第 ${index + 1} 阶段目标`),
    episode_range: text(item?.episode_range, 50, `第 ${index + 1} 阶段集数范围`),
  }))

  const episodesRaw = Array.isArray(source.episodes) ? source.episodes : []
  if (episodesRaw.length > 200) throw new Error('每集目标最多 200 条')
  const seen = new Set<number>()
  const episodes: ProjectBibleEpisode[] = []
  episodesRaw.forEach((item: any, index: number) => {
    const rawNumber = Number(item?.episode_number)
    const episodeNumber = Number.isInteger(rawNumber) && rawNumber > 0 ? rawNumber : index + 1
    if (seen.has(episodeNumber)) return
    seen.add(episodeNumber)
    episodes.push({
      episode_number: episodeNumber,
      objective: text(item?.objective, 1000, `第 ${episodeNumber} 集目标`),
      hook: text(item?.hook, 1000, `第 ${episodeNumber} 集结尾钩子`),
      previous_recap: text(item?.previous_recap, 2000, `第 ${episodeNumber} 集上集承接`),
      next_teaser: text(item?.next_teaser, 1000, `第 ${episodeNumber} 集下集预告`),
    })
  })
  episodes.sort((a, b) => a.episode_number - b.episode_number)

  return {
    logline: text(source.logline, 500, '一句话卖点'),
    genre: text(source.genre, 200, '题材'),
    audience: text(source.audience, 200, '受众'),
    tone: text(source.tone, 200, '情绪基调'),
    visual_style: text(source.visual_style, 200, '画面风格'),
    worldview: text(source.worldview, 5000, '世界观与现实规则'),
    main_conflict: text(source.main_conflict, 2000, '主线冲突'),
    core_suspense: text(source.core_suspense, 1000, '核心悬念'),
    ending_promise: text(source.ending_promise, 1000, '结局承诺'),
    stages,
    foreshadowing: textList(source.foreshadowing, 50, 500, '伏笔'),
    forbidden: textList(source.forbidden, 50, 500, '禁区'),
    episodes,
  }
}

/** 版本内容指纹：sha256(规范化 JSON)，用于「当前版本是否变化」判定。 */
export function projectBibleHash(bible: ProjectBible) {
  return createHash('sha256').update(JSON.stringify(bible)).digest('hex')
}

/**
 * 判定大纲是否「整版全空」。
 * 用于两处：① 保存时拒绝空版本（避免「已确认但每项都是 —」且空态永久消失）；
 * ② 读视图 has_data 按内容判定，兼容历史/外部写入的空版本。
 */
export function isProjectBibleEmpty(bible: ProjectBible): boolean {
  const textFields = [
    bible.logline, bible.genre, bible.audience, bible.tone, bible.visual_style,
    bible.worldview, bible.main_conflict, bible.core_suspense, bible.ending_promise,
  ]
  if (textFields.some(value => String(value || '').trim().length > 0)) return false
  if (bible.stages.some(stage => String(stage.name || '').trim() || String(stage.goal || '').trim() || String(stage.episode_range || '').trim())) return false
  if (bible.foreshadowing.length || bible.forbidden.length) return false
  if (bible.episodes.some(episode => (
    String(episode.objective || '').trim()
    || String(episode.hook || '').trim()
    || String(episode.previous_recap || '').trim()
    || String(episode.next_teaser || '').trim()
  ))) return false
  return true
}

export function emptyProjectBible(): ProjectBibleView {
  return {
    version_id: null,
    source: null,
    content_hash: null,
    created_at: null,
    updated_at: null,
    has_data: false,
    bible: null,
  }
}

export function serializeProjectBible(row: any): ProjectBibleView {
  let bible: ProjectBible | null = null
  try {
    bible = normalizeProjectBible(JSON.parse(String(row?.outline_json || '{}')))
  } catch {
    bible = null
  }
  return {
    version_id: Number(row.id),
    source: String(row.source || 'manual'),
    content_hash: String(row.content_hash || ''),
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
    // 按内容判定：空版本（历史/外部写入）不得让「已确认」状态与空态提示同时消失
    has_data: bible !== null && !isProjectBibleEmpty(bible),
    bible,
  }
}

async function loadDrama(connectionPool: Pool, dramaId: number, lock = false) {
  const [rows] = await connectionPool.query<any[]>(
    `SELECT id, current_bible_version_id, deleted_at FROM dramas WHERE id = ?${lock ? ' FOR UPDATE' : ' LIMIT 1'}`,
    [dramaId],
  )
  const drama = rows[0]
  if (!drama || drama.deleted_at) throw new ProjectBibleNotFound('项目不存在')
  return drama
}

function currentBibleVersionId(drama: any): number | null {
  return drama?.current_bible_version_id == null ? null : Number(drama.current_bible_version_id)
}

/** 读取当前生效大纲；无数据或指针悬空时返回空态（不报错，兼容既有项目）。 */
export async function getProjectBible(dramaId: number, connectionPool: Pool = pool): Promise<ProjectBibleView> {
  const drama = await loadDrama(connectionPool, dramaId)
  const versionId = currentBibleVersionId(drama)
  if (!versionId) return emptyProjectBible()
  const [rows] = await connectionPool.query<any[]>(
    'SELECT * FROM project_bible_versions WHERE id = ? AND drama_id = ? LIMIT 1',
    [versionId, dramaId],
  )
  return rows[0] ? serializeProjectBible(rows[0]) : emptyProjectBible()
}

/** 版本历史（倒序，最多 50 条）；供批次 B 历史查看与回退复用。 */
export async function listProjectBibleVersions(dramaId: number, connectionPool: Pool = pool) {
  const drama = await loadDrama(connectionPool, dramaId)
  const currentVersionId = currentBibleVersionId(drama)
  const [rows] = await connectionPool.query<any[]>(
    'SELECT id, source, content_hash, created_at, updated_at FROM project_bible_versions WHERE drama_id = ? ORDER BY id DESC LIMIT 50',
    [dramaId],
  )
  return {
    current_version_id: currentVersionId,
    versions: rows.map((row: any) => ({
      version_id: Number(row.id),
      source: String(row.source || 'manual'),
      content_hash: String(row.content_hash || ''),
      created_at: row.created_at,
      updated_at: row.updated_at,
      is_current: Number(row.id) === currentVersionId,
    })),
  }
}

/**
 * 保存并确认一版大纲：事务内锁 dramas 行 → 乐观锁比对 expected_version_id →
 * INSERT 不可变版本行 → 切换当前指针。旧版本行完整保留。
 */
export async function saveProjectBible(options: {
  dramaId: number
  bible: any
  expectedVersionId: number | null
  source?: string
  connectionPool?: Pool
}): Promise<ProjectBibleView> {
  const connectionPool = options.connectionPool || pool
  const bible = normalizeProjectBible(options.bible)
  const source: ProjectBibleSource = (PROJECT_BIBLE_SOURCES as readonly string[]).includes(String(options.source))
    ? (String(options.source) as ProjectBibleSource)
    : 'manual'
  const expected = options.expectedVersionId == null ? null : Number(options.expectedVersionId)
  if (expected !== null && (!Number.isInteger(expected) || expected <= 0)) {
    throw new Error('expected_version_id 必须是正整数或 null')
  }

  const connection = await connectionPool.getConnection()
  try {
    await connection.beginTransaction()
    try {
      const drama = await loadDrama(connection as unknown as Pool, options.dramaId, true)
      const currentVersionId = currentBibleVersionId(drama)
      if (currentVersionId !== expected) {
        throw new ProjectBibleConflict(
          'VERSION_CONFLICT：大纲已有更新，请重新加载后再保存',
        )
      }
      // 拒绝「整版全空」：否则会写入一个每项都是 — 的版本，且空态提示永久消失。
      // 顺序：404（项目不存在）→ 409（版本冲突）→ 400（内容为空）。
      if (isProjectBibleEmpty(bible)) {
        throw new Error('大纲内容不能全部为空，请至少填写一项后再保存')
      }

      const ts = new Date().toISOString()
      const hash = projectBibleHash(bible)
      const inserted = await connection.execute(
        `INSERT INTO project_bible_versions (drama_id, source, outline_json, content_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [options.dramaId, source, JSON.stringify(bible), hash, ts, ts],
      )
      const versionId = getInsertId(inserted)
      await connection.execute(
        'UPDATE dramas SET current_bible_version_id = ?, updated_at = ? WHERE id = ?',
        [versionId, ts, options.dramaId],
      )
      const [rows] = await connection.query<any[]>(
        'SELECT * FROM project_bible_versions WHERE id = ? LIMIT 1',
        [versionId],
      )
      await connection.commit()
      return serializeProjectBible(rows[0])
    } catch (error) {
      await connection.rollback()
      throw error
    }
  } finally {
    connection.release()
  }
}
