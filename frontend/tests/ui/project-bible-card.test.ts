/**
 * Issue #121 批次 A 挂载级交互测试：ProjectBibleCard 的真实接线
 * （空态可编辑 / 已确认展示 / 携带乐观锁保存 / 409 冲突不静默覆盖 / 普通错误 toast）。
 *
 * 与 source-cleanup-card.test.ts 同做法：vitest 真实编译 .vue + happy-dom，
 * 仅 mock 外部边界（vue-sonner 与 composables/useApi 的 bibleAPI）。
 * 运行：`npm run test:ui`（CI 强制）。
 */
import { beforeEach, expect, test, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import ProjectBibleCard from '../../app/components/ProjectBibleCard.vue'

const m = vi.hoisted(() => ({
  get: vi.fn(),
  save: vi.fn(),
  versions: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}))

vi.mock('vue-sonner', () => ({ toast: m.toast }))
vi.mock('~/composables/useApi', () => ({ bibleAPI: m }))

const emptyView = {
  version_id: null, source: null, content_hash: null, created_at: null, updated_at: null,
  has_data: false, bible: null,
}

function filledView(versionId: number, logline: string) {
  return {
    version_id: versionId,
    source: 'manual',
    content_hash: 'hash',
    created_at: '2026-09-12T00:00:00.000Z',
    updated_at: '2026-09-12T00:00:00.000Z',
    has_data: true,
    bible: {
      logline,
      genre: '职场',
      audience: '上班族',
      tone: '现实',
      visual_style: '真人实拍',
      worldview: '普通公司',
      main_conflict: '新人逆袭',
      core_suspense: '能否转正',
      ending_promise: '拿到晋升',
      stages: [{ name: '开局', goal: '建立反差', episode_range: '1-3' }],
      foreshadowing: ['体检报告'],
      forbidden: ['不可提前揭示反派身份'],
      episodes: [
        { episode_number: 1, objective: '目标一', hook: '钩子一', previous_recap: '承接一', next_teaser: '预告一' },
      ],
    },
  }
}

function buttonIn(wrapper: ReturnType<typeof mount<typeof ProjectBibleCard>>, text: string) {
  const btn = wrapper.findAll('button').find(b => b.text().includes(text))
  if (!btn) throw new Error(`missing button "${text}"`)
  return btn
}

function conflictError(status: number, message: string) {
  const err = new Error(message) as Error & { status: number }
  err.status = status
  return err
}

async function mountCard(view: unknown) {
  m.get.mockResolvedValueOnce(view)
  const wrapper = mount(ProjectBibleCard, { props: { dramaId: 7 } })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  vi.resetAllMocks()
})

test('空态：展示「尚未创建大纲」，可进入编辑并显示保存入口', async () => {
  const wrapper = await mountCard(emptyView)
  expect(m.get).toHaveBeenCalledWith(7)
  expect(wrapper.text()).toContain('尚未创建大纲')

  await buttonIn(wrapper, '开始编辑').trigger('click')
  await flushPromises()
  expect(wrapper.find('input.input').exists()).toBe(true)
  expect(wrapper.text()).toContain('保存并确认')
})

test('已确认：展示版本号、阶段结构与每集目标/承接/钩子', async () => {
  const wrapper = await mountCard(filledView(3, '一句话卖点'))
  expect(wrapper.text()).toContain('已确认 · V3')
  expect(wrapper.text()).toContain('一句话卖点')
  expect(wrapper.text()).toContain('开局')
  expect(wrapper.text()).toContain('目标一')
  expect(wrapper.text()).toContain('承接一')
  expect(wrapper.text()).toContain('钩子一')
  // 只读态不渲染表单
  expect(wrapper.find('form.project-bible-form').exists()).toBe(false)
})

test('保存：提交规范化大纲并携带 expected_version_id（乐观锁），成功后回到只读', async () => {
  const wrapper = await mountCard(filledView(3, '旧标题'))
  m.save.mockResolvedValueOnce(filledView(4, '新标题'))

  await buttonIn(wrapper, '编辑并确认新版本').trigger('click')
  await wrapper.get('input.input').setValue('新标题')
  await wrapper.get('form.project-bible-form').trigger('submit')
  await flushPromises()

  expect(m.save).toHaveBeenCalledTimes(1)
  const [dramaId, payload] = m.save.mock.calls[0]
  expect(dramaId).toBe(7)
  expect(payload.expected_version_id).toBe(3)
  expect(payload.bible.logline).toBe('新标题')
  expect(payload.bible.stages[0].name).toBe('开局')
  expect(m.toast.success).toHaveBeenCalled()
  expect(wrapper.text()).toContain('已确认 · V4')
  expect(wrapper.find('form.project-bible-form').exists()).toBe(false)
})

test('409 冲突：保留编辑器、显示冲突与「加载服务器最新版本」，不静默覆盖', async () => {
  const wrapper = await mountCard(filledView(3, '旧标题'))
  m.save.mockRejectedValueOnce(conflictError(409, 'VERSION_CONFLICT：大纲已有更新'))
  m.get.mockResolvedValueOnce(filledView(5, '服务器最新标题'))

  await buttonIn(wrapper, '编辑并确认新版本').trigger('click')
  await wrapper.get('form.project-bible-form').trigger('submit')
  await flushPromises()

  expect(wrapper.find('form.project-bible-form').exists()).toBe(true)
  expect(wrapper.text()).toContain('VERSION_CONFLICT：大纲已有更新')
  expect(m.toast.success).not.toHaveBeenCalled()

  await buttonIn(wrapper, '加载服务器最新版本').trigger('click')
  await flushPromises()
  expect(m.get).toHaveBeenCalledTimes(2)
  // 编辑器已重置为服务器最新版本（input 的 value 不进入 text() 断言）
  expect((wrapper.get('input.input').element as HTMLInputElement).value).toBe('服务器最新标题')
})

test('普通错误：toast 提示且编辑器保持打开，可重试', async () => {
  const wrapper = await mountCard(filledView(3, '旧标题'))
  m.save.mockRejectedValueOnce(new Error('网络请求失败'))

  await buttonIn(wrapper, '编辑并确认新版本').trigger('click')
  await wrapper.get('form.project-bible-form').trigger('submit')
  await flushPromises()

  expect(m.toast.error).toHaveBeenCalled()
  expect(wrapper.find('form.project-bible-form').exists()).toBe(true)
  expect(wrapper.text()).not.toContain('VERSION_CONFLICT')
})

test('整版全空：客户端拦截，不发出保存请求（避免空版本覆盖空态）', async () => {
  const wrapper = await mountCard(emptyView)

  await buttonIn(wrapper, '开始编辑').trigger('click')
  await flushPromises()
  await wrapper.get('form.project-bible-form').trigger('submit')
  await flushPromises()

  expect(m.save).not.toHaveBeenCalled()
  expect(m.toast.error).toHaveBeenCalled()
  expect(wrapper.find('form.project-bible-form').exists()).toBe(true)
})
