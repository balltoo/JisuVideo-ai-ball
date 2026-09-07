/**
 * Issue #74 · 74-C 挂载级交互测试：SourceCleanupCard 的真实接线（success / 409 conflict /
 * network failure / 超长全文不截断 / 编辑当前正文 / diff-stats-parent 副信息）。
 *
 * 与 theme-appearance-card.test.ts 同样的做法：vitest 真实编译 .vue + happy-dom，
 * 仅 mock 外部边界（vue-sonner toast 与 composables/useApi 的 dramaAPI），组件本身
 * （script + template + 样式结构）原样运行。运行：`npm run test:ui`（CI 强制）。
 */
import { beforeEach, expect, test, vi } from 'vitest'
import { flushPromises, mount, type DOMWrapper } from '@vue/test-utils'
import SourceCleanupCard from '../../app/components/SourceCleanupCard.vue'

const m = vi.hoisted(() => ({
  sourceVersions: vi.fn(),
  sourceHealthCheck: vi.fn(),
  startSourceCleanup: vi.fn(),
  confirmSource: vi.fn(),
  skipSource: vi.fn(),
  switchSourceVersion: vi.fn(),
  updateCurrentSource: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}))

vi.mock('vue-sonner', () => ({ toast: m.toast }))
vi.mock('~/composables/useApi', () => ({ dramaAPI: m }))

interface Row {
  id: number
  kind: string
  parent_version_id: number | null
  content: string
  stats?: unknown
  diff?: unknown
}
interface ListPayload {
  current: { id: number; kind: string } | null
  versions: Row[]
  skipped_at?: string | null
}

const sourceRow: Row = { id: 1, kind: 'source', parent_version_id: null, content: '这是原文第一段。\n这是原文第二段，包含重复句子。重复句子。' }
const cleanedRow: Row = {
  id: 2, kind: 'cleaned', parent_version_id: 1, content: '这是整理后的正文。',
  stats: { removed_chars: 320, removal_count: 4 }, diff: { removals: [] },
}
const confirmedRow: Row = {
  id: 3, kind: 'confirmed', parent_version_id: 2, content: '已确认的正文。',
  stats: {}, diff: { removals: [], removed_chars: 0 },
}
const editedRow: Row = { id: 4, kind: 'user-edited', parent_version_id: 3, content: '人工编辑后的正文。', stats: null, diff: null }

function payload(versions: Row[], currentId: number | null, skipped_at: string | null = null): ListPayload {
  const cur = versions.find(v => v.id === currentId) ?? null
  return { current: cur ? { id: cur.id, kind: cur.kind } : null, versions, skipped_at }
}

async function mountCard(list: ListPayload) {
  m.sourceVersions.mockResolvedValueOnce(list)
  const wrapper = mount(SourceCleanupCard, { props: { dramaId: 7 } })
  await (wrapper.vm as { loadSourceVersions: () => Promise<void> }).loadSourceVersions()
  await flushPromises()
  return wrapper
}

function rowOf(wrapper: ReturnType<typeof mount<typeof SourceCleanupCard>>, id: number) {
  const row = wrapper.findAll('.source-version-row').find(r => r.text().includes(`V${id} ·`))
  if (!row) throw new Error(`missing version row V${id}`)
  return row
}

function buttonIn(scope: DOMWrapper<Element>, text: string) {
  const btn = scope.findAll('button').find(b => b.text().includes(text))
  if (!btn) throw new Error(`missing button "${text}"`)
  return btn
}

function conflictError(status: number, message: string) {
  const err = new Error(message) as Error & { status: number }
  err.status = status
  return err
}

beforeEach(() => {
  vi.resetAllMocks()
})

test('renders current highlight and diff/stats/parent meta per version row (read path)', async () => {
  const wrapper = await mountCard(payload([sourceRow, cleanedRow, confirmedRow], 3))
  const rows = wrapper.findAll('.source-version-row')
  expect(rows).toHaveLength(3)

  // current 高亮只落在生效行上
  const currentRow = rowOf(wrapper, 3)
  expect(currentRow.text()).toContain('当前生效')
  expect(rowOf(wrapper, 2).text()).toContain('待确认候选')

  // diff/stats/parent 链副信息：cleaned 显示建议删除摘要；confirmed 读 parent cleaned 的 stats
  const cleaned = rowOf(wrapper, 2)
  expect(cleaned.text()).toContain('基于 V1（原始正文）')
  expect(cleaned.text()).toContain('建议删除 320 字（4 处）')
  const confirmed = rowOf(wrapper, 3)
  expect(confirmed.text()).toContain('基于 V2（整理候选）')
  expect(confirmed.text()).toContain('整理稿较原文删除 320 字')

  // source 行无 parent/stats，不渲染 meta 行
  expect(rowOf(wrapper, 1).find('.source-version-meta').exists()).toBe(false)
})

test('confirm happy path: POST confirm with CAS pointer then reload highlights the confirmed current', async () => {
  const wrapper = await mountCard(payload([sourceRow, cleanedRow], 1))
  // 成功后的重读返回新状态（confirmed 成为 current）
  m.sourceVersions.mockResolvedValue(payload([sourceRow, cleanedRow, confirmedRow], 3))

  await buttonIn(rowOf(wrapper, 2), '确认').trigger('click')
  await flushPromises()

  expect(m.confirmSource).toHaveBeenCalledTimes(1)
  expect(m.confirmSource).toHaveBeenCalledWith(7, { target_version_id: 2, expected_current_version_id: 1 })
  expect(m.toast.success).toHaveBeenCalled()
  expect(rowOf(wrapper, 3).text()).toContain('当前生效')
})

test('skip happy path on source current: marks skip and reloads to show the skipped strip', async () => {
  const wrapper = await mountCard(payload([sourceRow, cleanedRow], 1))
  m.sourceVersions.mockResolvedValue(payload([sourceRow, cleanedRow], 1, '2026-09-01T00:00:00.000Z'))

  await buttonIn(wrapper.get('.source-cleanup-actions'), '跳过整理').trigger('click')
  await flushPromises()

  expect(m.skipSource).toHaveBeenCalledTimes(1)
  expect(m.skipSource).toHaveBeenCalledWith(7)
  expect(m.toast.success).toHaveBeenCalled()
  expect(wrapper.text()).toContain('已跳过自动整理')
})

test('409 conflict: banner + refresh-for-review only, write is NOT auto-retried', async () => {
  const wrapper = await mountCard(payload([sourceRow, cleanedRow], 1))
  m.confirmSource.mockRejectedValueOnce(conflictError(409, 'VERSION_CONFLICT：该整理候选不基于当前正文'))
  m.sourceVersions.mockResolvedValue(payload([sourceRow, cleanedRow], 1))

  await buttonIn(rowOf(wrapper, 2), '确认').trigger('click')
  await flushPromises()

  expect(m.confirmSource).toHaveBeenCalledTimes(1)
  expect(m.switchSourceVersion).not.toHaveBeenCalled()
  expect(m.skipSource).not.toHaveBeenCalled()
  expect(wrapper.text()).toContain('版本冲突')
  expect(wrapper.text()).toContain('刷新复核')

  // 点刷新复核 → 冲突横幅清除、只重读列表（共 3 次 load：mount 1 + 冲突自动重读 1 + 手动刷新 1）
  await buttonIn(wrapper.get('.source-conflict'), '刷新复核').trigger('click')
  await flushPromises()
  expect(wrapper.text()).not.toContain('版本冲突')
  expect(m.sourceVersions).toHaveBeenCalledTimes(3)
})

test('network failure (non-409): inline error banner, no conflict banner, action re-enabled', async () => {
  const wrapper = await mountCard(payload([sourceRow, cleanedRow], 1))
  m.confirmSource.mockRejectedValueOnce(new Error('网络请求失败，请稍后重试'))

  const confirmBtn = buttonIn(rowOf(wrapper, 2), '确认')
  await confirmBtn.trigger('click')
  await flushPromises()

  expect(wrapper.text()).toContain('网络请求失败，请稍后重试')
  expect(wrapper.text()).not.toContain('版本冲突')
  expect(m.toast.success).not.toHaveBeenCalled()
  // pending 已复位 → 按钮恢复可点
  expect((confirmBtn.element as HTMLButtonElement).disabled).toBe(false)
})

test('edit current text: prefill full content, save issues PUT current with CAS, panel closes on success', async () => {
  const wrapper = await mountCard(payload([sourceRow, cleanedRow, confirmedRow], 3))
  m.updateCurrentSource.mockResolvedValue({})
  m.sourceVersions.mockResolvedValue(payload([sourceRow, cleanedRow, confirmedRow, editedRow], 4))

  // 入口只在 confirmed/user-edited 当前下出现
  await buttonIn(wrapper.get('.source-cleanup-actions'), '编辑当前正文').trigger('click')
  const textarea = wrapper.get('textarea.source-edit-textarea')
  // 预填当前生效行完整全文
  expect((textarea.element as HTMLTextAreaElement).value).toBe(confirmedRow.content)

  const nextContent = '人工修正后的正文，标点已规范。'
  await textarea.setValue(nextContent)
  await wrapper.get('input.source-edit-note').setValue('补标点')
  await buttonIn(wrapper.get('.source-edit-panel'), '保存编辑').trigger('click')
  await flushPromises()

  expect(m.updateCurrentSource).toHaveBeenCalledTimes(1)
  expect(m.updateCurrentSource).toHaveBeenCalledWith(7, { expected_current_version_id: 3, content: nextContent, note: '补标点' })
  expect(m.toast.success).toHaveBeenCalled()
  // 成功后面板关闭且 current 迁移到 user-edited 行
  expect(wrapper.find('textarea.source-edit-textarea').exists()).toBe(false)
  expect(rowOf(wrapper, 4).text()).toContain('当前生效')
})

test('edit current text: blank content is blocked in the client, PUT not issued', async () => {
  const wrapper = await mountCard(payload([sourceRow, cleanedRow, confirmedRow], 3))

  await buttonIn(wrapper.get('.source-cleanup-actions'), '编辑当前正文').trigger('click')
  await wrapper.get('textarea.source-edit-textarea').setValue('   ')
  await buttonIn(wrapper.get('.source-edit-panel'), '保存编辑').trigger('click')
  await flushPromises()

  expect(m.updateCurrentSource).not.toHaveBeenCalled()
  expect(wrapper.text()).toContain('正文不能为空')
  expect(wrapper.find('textarea.source-edit-textarea').exists()).toBe(true)
})

test('edit conflict (409) keeps the editor open for review, never silently overwrites', async () => {
  const wrapper = await mountCard(payload([sourceRow, cleanedRow, confirmedRow], 3))
  m.updateCurrentSource.mockRejectedValueOnce(conflictError(409, 'VERSION_CONFLICT：当前正文已变化'))
  m.sourceVersions.mockResolvedValue(payload([sourceRow, cleanedRow, confirmedRow], 3))

  await buttonIn(wrapper.get('.source-cleanup-actions'), '编辑当前正文').trigger('click')
  await buttonIn(wrapper.get('.source-edit-panel'), '保存编辑').trigger('click')
  await flushPromises()

  expect(m.updateCurrentSource).toHaveBeenCalledTimes(1)
  // 面板保持打开 + 冲突横幅，用户可继续编辑或刷新复核
  expect(wrapper.find('textarea.source-edit-textarea').exists()).toBe(true)
  expect(wrapper.text()).toContain('版本冲突')
})

test('very long content: preview shows the FULL text and edit submits the FULL text (never truncated)', async () => {
  const longContent = '超长正文'.repeat(1000) + '文' + 'Y7Q最终结尾标记'
  const bigRow: Row = { id: 2, kind: 'user-edited', parent_version_id: 1, content: longContent, stats: null, diff: null }
  const wrapper = await mountCard(payload([{ ...sourceRow }, bigRow], 2))
  m.updateCurrentSource.mockResolvedValue({})
  m.sourceVersions.mockResolvedValue(payload([{ ...sourceRow }, bigRow], 2))

  // 预览行全文：长文展示可截断（本项目未截断），但不能丢尾部标记
  const row = rowOf(wrapper, 2)
  await buttonIn(row, '预览').trigger('click')
  const pre = row.get('.source-version-preview')
  expect(pre.text()).toHaveLength(longContent.length)
  expect(pre.text()).toContain('Y7Q最终结尾标记')
  await buttonIn(row, '收起').trigger('click')

  // 编辑预填与提交 = 完整全文（展示截断 ≠ 提交截断）
  await buttonIn(wrapper.get('.source-cleanup-actions'), '编辑当前正文').trigger('click')
  const textarea = wrapper.get('textarea.source-edit-textarea')
  expect((textarea.element as HTMLTextAreaElement).value).toHaveLength(longContent.length)
  await buttonIn(wrapper.get('.source-edit-panel'), '保存编辑').trigger('click')
  await flushPromises()

  expect(m.updateCurrentSource).toHaveBeenCalledTimes(1)
  const sent = m.updateCurrentSource.mock.calls[0][1] as { content: string }
  expect(sent.content).toHaveLength(longContent.length)
  expect(sent.content).toContain('Y7Q最终结尾标记')
})
