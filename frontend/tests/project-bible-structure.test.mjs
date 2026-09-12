/**
 * Issue #121 批次 A：项目圣经（大纲与全局设定）前端结构守卫
 *
 * 覆盖：bibleAPI 契约、detail.vue 新 Tab 与板块、ProjectBibleCard 空态/编辑/版本确认/409 冲突、
 * episode.vue 本集大纲继承展示、以及 UI token 守卫（不引入硬编码色值）。
 */
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

test('useApi 暴露 bibleAPI，路径与后端端点对齐', () => {
  const api = read('app/composables/useApi.ts')
  assert.match(api, /export const bibleAPI = \{/)
  assert.match(api, /api\.get\(`\/dramas\/\$\{id\}\/bible`\)/)
  assert.match(api, /api\.put\(`\/dramas\/\$\{id\}\/bible`, data\)/)
  assert.match(api, /api\.get\(`\/dramas\/\$\{id\}\/bible\/versions`\)/)
  assert.match(api, /expected_version_id: number \| null/)
  // 批次 B-1：历史详情与回退
  assert.match(api, /api\.get\(`\/dramas\/\$\{id\}\/bible\/versions\/\$\{versionId\}`\)/)
  assert.match(api, /api\.post\(`\/dramas\/\$\{id\}\/bible\/switch`, data\)/)
})

test('detail.vue 新增「大纲与全局设定」Tab 与 ProjectBibleCard 板块', () => {
  const page = read('app/views/drama/detail.vue')
  assert.match(page, /import ProjectBibleCard from '~\/components\/ProjectBibleCard\.vue'/)
  assert.match(page, /activeTab === 'bible'/)
  assert.match(page, /大纲与全局设定/)
  assert.match(page, /<ProjectBibleCard :drama-id="dramaId" \/>/)
})

test('ProjectBibleCard：读路径、空态可编辑、确认新版本、409 冲突恢复', () => {
  const card = read('app/components/ProjectBibleCard.vue')
  // 读路径
  assert.match(card, /bibleAPI\.get\(props\.dramaId\)/)
  // 空态可编辑
  assert.match(card, /尚未创建大纲/)
  assert.match(card, /开始编辑/)
  // 写路径携带乐观锁
  assert.match(card, /bibleAPI\.save\(props\.dramaId, \{/)
  assert.match(card, /expected_version_id: view\.value\?\.version_id \?\? null/)
  // 409 冲突：不静默覆盖，提供加载服务器最新版本
  assert.match(card, /error\?\.status === 409/)
  assert.match(card, /加载服务器最新版本/)
  assert.match(card, /reloadAfterConflict/)
})

test('ProjectBibleCard：覆盖大纲结构化字段（全局设定 / 阶段 / 伏笔禁区 / 每集承接）', () => {
  const card = read('app/components/ProjectBibleCard.vue')
  for (const key of ['logline', 'genre', 'audience', 'tone', 'visual_style', 'worldview', 'main_conflict', 'core_suspense', 'ending_promise']) {
    assert.match(card, new RegExp(key), `缺少字段 ${key}`)
  }
  assert.match(card, /全剧阶段结构/)
  assert.match(card, /伏笔/)
  assert.match(card, /禁区 \/ 不可提前揭示/)
  assert.match(card, /每集目标与承接/)
  assert.match(card, /previous_recap/)
  assert.match(card, /next_teaser/)
})

test('episode.vue 展示本集从大纲继承的目标 / 承接 / 钩子 / 下集预告', () => {
  const page = read('app/views/drama/episode.vue')
  assert.match(page, /bibleAPI/)
  assert.match(page, /const episodeBible = computed/)
  assert.match(page, /Number\(item\.episode_number\) === episodeNumber/)
  assert.match(page, /v-if="episodeBible \|\| bibleLoadError" class="studio-bible-row"/)
  assert.match(page, /本集目标/)
  assert.match(page, /承接/)
  assert.match(page, /钩子/)
  assert.match(page, /下集预告/)
  assert.match(page, /episodeBible\?\.next_teaser/)
})

test('episode.vue 大纲加载失败：保留旧值并内联提示（对齐 R1，不静默置空）', () => {
  const page = read('app/views/drama/episode.vue')
  assert.match(page, /const bibleLoadError = ref\(''\)/)
  assert.match(page, /bibleLoadError\.value = error\?\.message \|\| '大纲信息加载失败'/)
  assert.match(page, /class="tag tag-error studio-bible-error"/)
  assert.doesNotMatch(page, /catch \{\s*\n\s*bibleOutline\.value = null/)
})

test('UI token 守卫：ProjectBibleCard 不引入硬编码色值', () => {
  const card = read('app/components/ProjectBibleCard.vue')
  // 只检查 <style> 块：模板/注释中的 Issue 编号（如 #121）不是色值
  const styleBlock = card.slice(card.indexOf('<style'), card.lastIndexOf('</style>'))
  assert.ok(styleBlock.length > 0, '未找到 style 块')
  assert.doesNotMatch(styleBlock, /#[0-9a-fA-F]{3,8}\b/, '不得硬编码十六进制色值')
  assert.doesNotMatch(styleBlock, /rgba?\(/, '不得硬编码 rgb/rgba 色值')
})

test('ProjectBibleCard：拒绝整版全空保存（与服务端一致，空态不被永久覆盖）', () => {
  const card = read('app/components/ProjectBibleCard.vue')
  assert.match(card, /function hasAnyBibleContent/)
  assert.match(card, /请至少填写一项大纲内容后再保存/)
  assert.match(card, /if \(!hasAnyBibleContent\(payload\)\)/)
})

test('ProjectBibleCard 批次 B-1：版本历史查看与回退（CAS + 409 只刷新不重提）', () => {
  const card = read('app/components/ProjectBibleCard.vue')
  assert.match(card, /const historyOpen = ref\(false\)/)
  assert.match(card, /bibleAPI\.versions\(props\.dramaId\)/)
  assert.match(card, /bibleAPI\.versionDetail\(props\.dramaId, versionId\)/)
  assert.match(card, /bibleAPI\.switchVersion\(props\.dramaId, \{/)
  assert.match(card, /target_version_id: versionId/)
  assert.match(card, /expected_version_id: view\.value\?\.version_id \?\? null/)
  assert.match(card, /回退只切换当前生效版本，不删除任何历史版本/)
  assert.match(card, /class="project-bible-version-list"/)
  assert.match(card, /回退到此版本/)
  // 409：只提示冲突 + 刷新列表，不自动重提
  assert.match(card, /error\?\.status === 409/)
  assert.match(card, /versionConflict\.value = error\.message/)
  assert.match(card, /刷新版本历史/)
})
