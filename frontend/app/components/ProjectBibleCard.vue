<template>
  <section class="card project-bible-card">
    <div class="project-bible-head">
      <div>
        <span class="source-eyebrow">DRAMA BIBLE</span>
        <h2>大纲与全局设定</h2>
        <p>全剧层面的权威设定：大纲、阶段结构、每集目标与承接关系。每次确认生成独立版本，历史可追溯、不被静默覆盖。</p>
      </div>
      <div class="project-bible-head-actions">
        <span v-if="hasBible" class="tag">已确认 · V{{ view.version_id }}</span>
        <span v-else class="tag">尚未创建</span>
        <button v-if="!editing" type="button" class="btn" :disabled="loading" @click="startEdit">
          {{ hasBible ? '编辑并确认新版本' : '开始编辑' }}
        </button>
      </div>
    </div>

    <div v-if="loading" class="project-bible-state">加载中…</div>
    <div v-else-if="loadError" class="project-bible-state is-error">
      <span>{{ loadError }}</span>
      <button type="button" class="btn btn-sm" @click="load">重试</button>
    </div>

    <template v-else-if="!editing">
      <div v-if="!hasBible" class="project-bible-state">
        尚未创建大纲。可先填写一句话卖点与每集目标，帮助后续剧本、分镜与提示词理解全剧结构。
      </div>
      <div v-else class="project-bible-view">
        <div v-if="bible.logline" class="project-bible-logline">{{ bible.logline }}</div>
        <dl class="project-bible-fields">
          <div v-for="field in readFields" :key="field.key" class="project-bible-field">
            <dt>{{ field.label }}</dt>
            <dd>{{ bible[field.key] || '—' }}</dd>
          </div>
        </dl>

        <div v-if="bible.stages.length" class="project-bible-block">
          <h3>全剧阶段结构</h3>
          <ul class="project-bible-list">
            <li v-for="(stage, index) in bible.stages" :key="`stage-${index}`">
              <b>{{ stage.name || `阶段 ${index + 1}` }}</b>
              <span v-if="stage.episode_range" class="tag mono">{{ stage.episode_range }}</span>
              <span>{{ stage.goal }}</span>
            </li>
          </ul>
        </div>

        <div v-if="bible.foreshadowing.length || bible.forbidden.length" class="project-bible-block">
          <div class="project-bible-columns">
            <div v-if="bible.foreshadowing.length">
              <h3>伏笔</h3>
              <ul class="project-bible-list"><li v-for="(item, index) in bible.foreshadowing" :key="`fore-${index}`">{{ item }}</li></ul>
            </div>
            <div v-if="bible.forbidden.length">
              <h3>禁区 / 不可提前揭示</h3>
              <ul class="project-bible-list"><li v-for="(item, index) in bible.forbidden" :key="`forbid-${index}`">{{ item }}</li></ul>
            </div>
          </div>
        </div>

        <div v-if="bible.episodes.length" class="project-bible-block">
          <h3>每集目标与承接</h3>
          <ul class="project-bible-episodes">
            <li v-for="episode in bible.episodes" :key="`ep-${episode.episode_number}`">
              <b>第 {{ episode.episode_number }} 集</b>
              <div v-if="episode.objective"><span class="project-bible-ep-label">目标</span>{{ episode.objective }}</div>
              <div v-if="episode.previous_recap"><span class="project-bible-ep-label">承接</span>{{ episode.previous_recap }}</div>
              <div v-if="episode.hook"><span class="project-bible-ep-label">钩子</span>{{ episode.hook }}</div>
              <div v-if="episode.next_teaser"><span class="project-bible-ep-label">预告</span>{{ episode.next_teaser }}</div>
            </li>
          </ul>
        </div>
      </div>
    </template>

    <form v-else class="project-bible-form" @submit.prevent="save">
      <div class="project-bible-grid">
        <label v-for="field in editFields" :key="field.key" class="field">
          <span class="field-label">{{ field.label }}</span>
          <input v-if="field.type === 'input'" v-model="form[field.key]" class="input" :placeholder="field.placeholder" />
          <textarea v-else v-model="form[field.key]" class="textarea" rows="3" :placeholder="field.placeholder" />
        </label>
      </div>

      <div class="project-bible-block">
        <div class="project-bible-block-head">
          <h3>全剧阶段结构</h3>
          <button type="button" class="btn btn-sm" @click="addStage">添加阶段</button>
        </div>
        <div v-for="(stage, index) in form.stages" :key="`stage-${index}`" class="project-bible-row">
          <input v-model="stage.name" class="input" placeholder="阶段名称（如：开局）" />
          <input v-model="stage.episode_range" class="input" placeholder="集数范围（如：1-3）" />
          <input v-model="stage.goal" class="input" placeholder="阶段目标" />
          <button type="button" class="btn btn-sm" @click="removeStage(index)">删除</button>
        </div>
      </div>

      <div class="project-bible-columns">
        <label class="field">
          <span class="field-label">伏笔（每行一条）</span>
          <textarea v-model="form.foreshadowingText" class="textarea" rows="4" placeholder="如：体检报告上的异常指标" />
        </label>
        <label class="field">
          <span class="field-label">禁区 / 不可提前揭示（每行一条）</span>
          <textarea v-model="form.forbiddenText" class="textarea" rows="4" placeholder="如：不可提前揭示反派身份" />
        </label>
      </div>

      <div class="project-bible-block">
        <div class="project-bible-block-head">
          <h3>每集目标与承接</h3>
          <button type="button" class="btn btn-sm" @click="addEpisode">添加一集</button>
        </div>
        <div v-for="(episode, index) in form.episodes" :key="`ep-${index}`" class="project-bible-episode-edit">
          <div class="project-bible-episode-edit-head">
            <label class="field project-bible-ep-number">
              <span class="field-label">集号</span>
              <input v-model.number="episode.episode_number" class="input" type="number" min="1" />
            </label>
            <button type="button" class="btn btn-sm" @click="removeEpisode(index)">删除</button>
          </div>
          <label class="field">
            <span class="field-label">本集目标</span>
            <input v-model="episode.objective" class="input" placeholder="这一集要完成什么" />
          </label>
          <label class="field">
            <span class="field-label">上集承接</span>
            <input v-model="episode.previous_recap" class="input" placeholder="承接上一集的什么状态" />
          </label>
          <label class="field">
            <span class="field-label">结尾钩子</span>
            <input v-model="episode.hook" class="input" placeholder="结尾留下什么悬念" />
          </label>
          <label class="field">
            <span class="field-label">下集预告</span>
            <input v-model="episode.next_teaser" class="input" placeholder="为下一集埋什么线" />
          </label>
        </div>
      </div>

      <div v-if="conflict" class="project-bible-state is-error">
        <span>{{ conflict }}</span>
        <button type="button" class="btn btn-sm" @click="reloadAfterConflict">加载服务器最新版本</button>
      </div>

      <div class="project-bible-form-actions">
        <button type="button" class="btn" :disabled="saving" @click="cancelEdit">取消</button>
        <button type="submit" class="btn btn-primary" :disabled="saving">{{ saving ? '保存中…' : '保存并确认' }}</button>
      </div>
    </form>
  </section>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { toast } from 'vue-sonner'
import { bibleAPI } from '~/composables/useApi'

const props = defineProps({
  dramaId: { type: Number, required: true },
})

const loading = ref(false)
const loadError = ref('')
const view = ref(null)
const editing = ref(false)
const saving = ref(false)
const conflict = ref('')

const EDIT_FIELDS = [
  { key: 'logline', label: '一句话卖点', type: 'input', placeholder: '一句话说明这个故事' },
  { key: 'genre', label: '题材', type: 'input', placeholder: '如：都市职场' },
  { key: 'audience', label: '受众', type: 'input', placeholder: '如：25-35 岁上班族' },
  { key: 'tone', label: '情绪基调', type: 'input', placeholder: '如：现实、爽感、克制' },
  { key: 'visual_style', label: '画面风格', type: 'input', placeholder: '如：真人实拍' },
  { key: 'worldview', label: '世界观与现实规则', type: 'textarea', placeholder: '故事成立所依赖的世界规则' },
  { key: 'main_conflict', label: '主线冲突', type: 'textarea', placeholder: '贯穿全剧的核心冲突' },
  { key: 'core_suspense', label: '核心悬念', type: 'textarea', placeholder: '观众追下去想看什么' },
  { key: 'ending_promise', label: '结局承诺', type: 'textarea', placeholder: '最终给观众的交代' },
]
const READ_FIELDS = [
  { key: 'genre', label: '题材' },
  { key: 'audience', label: '受众' },
  { key: 'tone', label: '情绪基调' },
  { key: 'visual_style', label: '画面风格' },
  { key: 'worldview', label: '世界观与现实规则' },
  { key: 'main_conflict', label: '主线冲突' },
  { key: 'core_suspense', label: '核心悬念' },
  { key: 'ending_promise', label: '结局承诺' },
]
const editFields = EDIT_FIELDS
const readFields = READ_FIELDS

function emptyForm() {
  return {
    logline: '', genre: '', audience: '', tone: '', visual_style: '',
    worldview: '', main_conflict: '', core_suspense: '', ending_promise: '',
    stages: [],
    foreshadowingText: '',
    forbiddenText: '',
    episodes: [],
  }
}
const form = reactive(emptyForm())

const hasBible = computed(() => view.value?.has_data === true && !!view.value.bible)
const bible = computed(() => view.value?.bible || null)

function splitLines(value) {
  return String(value || '').split(/\r?\n/).map(item => item.trim()).filter(Boolean)
}

function fillForm(source) {
  const data = source || {}
  Object.assign(form, emptyForm(), {
    logline: data.logline || '',
    genre: data.genre || '',
    audience: data.audience || '',
    tone: data.tone || '',
    visual_style: data.visual_style || '',
    worldview: data.worldview || '',
    main_conflict: data.main_conflict || '',
    core_suspense: data.core_suspense || '',
    ending_promise: data.ending_promise || '',
    stages: (Array.isArray(data.stages) ? data.stages : []).map(stage => ({
      name: stage?.name || '',
      goal: stage?.goal || '',
      episode_range: stage?.episode_range || '',
    })),
    foreshadowingText: (Array.isArray(data.foreshadowing) ? data.foreshadowing : []).join('\n'),
    forbiddenText: (Array.isArray(data.forbidden) ? data.forbidden : []).join('\n'),
    episodes: (Array.isArray(data.episodes) ? data.episodes : []).map(episode => ({
      episode_number: Number(episode?.episode_number) || 1,
      objective: episode?.objective || '',
      hook: episode?.hook || '',
      previous_recap: episode?.previous_recap || '',
      next_teaser: episode?.next_teaser || '',
    })),
  })
}

async function load() {
  loading.value = true
  loadError.value = ''
  try {
    view.value = await bibleAPI.get(props.dramaId)
  } catch (error) {
    loadError.value = error?.message || '加载大纲失败'
  } finally {
    loading.value = false
  }
}

function startEdit() {
  fillForm(view.value?.bible)
  if (!form.episodes.length) addEpisode()
  conflict.value = ''
  editing.value = true
}

function cancelEdit() {
  editing.value = false
  conflict.value = ''
}

function addStage() {
  form.stages.push({ name: '', goal: '', episode_range: '' })
}

function removeStage(index) {
  form.stages.splice(index, 1)
}

function nextEpisodeNumber() {
  return form.episodes.reduce((max, episode) => Math.max(max, Number(episode.episode_number) || 0), 0) + 1
}

function addEpisode() {
  form.episodes.push({
    episode_number: nextEpisodeNumber(),
    objective: '',
    hook: '',
    previous_recap: '',
    next_teaser: '',
  })
}

function removeEpisode(index) {
  form.episodes.splice(index, 1)
}

function buildBible() {
  return {
    logline: form.logline,
    genre: form.genre,
    audience: form.audience,
    tone: form.tone,
    visual_style: form.visual_style,
    worldview: form.worldview,
    main_conflict: form.main_conflict,
    core_suspense: form.core_suspense,
    ending_promise: form.ending_promise,
    stages: form.stages.map(stage => ({ ...stage })),
    foreshadowing: splitLines(form.foreshadowingText),
    forbidden: splitLines(form.forbiddenText),
    episodes: form.episodes.map((episode, index) => ({
      episode_number: Number(episode.episode_number) || index + 1,
      objective: episode.objective,
      hook: episode.hook,
      previous_recap: episode.previous_recap,
      next_teaser: episode.next_teaser,
    })),
  }
}

function hasAnyBibleContent(bible) {
  const textKeys = ['logline', 'genre', 'audience', 'tone', 'visual_style', 'worldview', 'main_conflict', 'core_suspense', 'ending_promise']
  if (textKeys.some(key => String(bible[key] || '').trim())) return true
  if (bible.stages.some(stage => (
    String(stage.name || '').trim() || String(stage.goal || '').trim() || String(stage.episode_range || '').trim()
  ))) return true
  if (bible.foreshadowing.length || bible.forbidden.length) return true
  if (bible.episodes.some(episode => (
    String(episode.objective || '').trim()
    || String(episode.hook || '').trim()
    || String(episode.previous_recap || '').trim()
    || String(episode.next_teaser || '').trim()
  ))) return true
  return false
}

async function save() {
  const payload = buildBible()
  // 与服务端一致：拒绝「整版全空」，避免写入空版本导致空态提示永久消失
  if (!hasAnyBibleContent(payload)) {
    toast.error('请至少填写一项大纲内容后再保存')
    return
  }
  saving.value = true
  conflict.value = ''
  try {
    view.value = await bibleAPI.save(props.dramaId, {
      bible: payload,
      expected_version_id: view.value?.version_id ?? null,
    })
    editing.value = false
    toast.success('大纲已保存并生成新版本')
  } catch (error) {
    if (error?.status === 409) {
      conflict.value = error.message || '大纲已被其他窗口更新，请加载最新版本后重试'
    } else {
      toast.error(error?.message || '大纲保存失败')
    }
  } finally {
    saving.value = false
  }
}

async function reloadAfterConflict() {
  await load()
  startEdit()
}

onMounted(load)
defineExpose({ load })
</script>

<style scoped>
.project-bible-card {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.project-bible-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}
.project-bible-head h2 {
  margin: 4px 0 6px;
}
.project-bible-head p {
  margin: 0;
  color: var(--text-2);
}
.project-bible-head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.project-bible-state {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 0;
  color: var(--text-2);
}
.project-bible-state.is-error {
  color: var(--danger, inherit);
}
.project-bible-logline {
  font-weight: 600;
  margin-bottom: 8px;
}
.project-bible-fields {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px 20px;
  margin: 0;
}
.project-bible-field {
  display: flex;
  gap: 8px;
}
.project-bible-field dt {
  color: var(--text-2);
  flex-shrink: 0;
}
.project-bible-field dd {
  margin: 0;
  white-space: pre-wrap;
}
.project-bible-block {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.project-bible-block h3 {
  margin: 0;
}
.project-bible-block-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.project-bible-columns {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}
.project-bible-list {
  margin: 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.project-bible-list li {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.project-bible-episodes {
  margin: 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.project-bible-ep-label {
  display: inline-block;
  min-width: 40px;
  color: var(--text-2);
}
.project-bible-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px 16px;
}
.project-bible-row {
  display: grid;
  grid-template-columns: 1fr 120px 2fr auto;
  gap: 8px;
  align-items: center;
}
.project-bible-episode-edit {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.project-bible-episode-edit-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 12px;
}
.project-bible-ep-number {
  max-width: 120px;
}
.project-bible-form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
