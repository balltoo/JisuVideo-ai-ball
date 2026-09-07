<script setup>
import { toast } from 'vue-sonner'
import { dramaAPI } from '~/composables/useApi'

const props = defineProps({
  dramaId: { type: Number, required: true },
})

const sourceHealth = ref(null)
const sourceHealthLoading = ref(false)
const sourceCleanupStarting = ref(false)
const sourceCleanupTask = ref(null)
const sourceCleanupError = ref('')
const sourceVersions = ref([])
const sourceVersionsLoading = ref(false)
const sourceVersionCurrentId = ref(null)
const sourceVersionCurrentKind = ref(null)
const sourceSkippedAt = ref(null)
const sourceVersionPreviewId = ref(null)
// 写路径状态：进行中的动作 key（禁用按钮防重复提交）与 409 冲突提示（与通用错误分开）
const sourceActionPending = ref(null)
const sourceConflict = ref('')

function sourceVersionKindLabel(kind) {
  return ({ source: '原始正文', cleaned: '整理候选', confirmed: '已确认正文', 'user-edited': '人工编辑' })[kind] || kind
}

// 只有"基于当前正文的同基线最新 cleaned 候选"才允许确认，与后端 confirmCleanedVersion 的三重校验对齐，
// 避免给注定 409/400 的陈旧候选渲染可点按钮。
const confirmableVersionId = computed(() => {
  const currentId = sourceVersionCurrentId.value ?? null
  const candidates = sourceVersions.value.filter(v => v.kind === 'cleaned' && (v.parent_version_id ?? null) === currentId)
  if (!candidates.length) return null
  return candidates.reduce((max, v) => Math.max(max, Number(v.id)), 0) || null
})

// 跳过整理：仅当前是原文（source）或尚无当前指针、且未跳过时可用（对齐 skipSourceCleanup 的 base_kind 校验）
const canSkip = computed(() => {
  if (sourceSkippedAt.value) return false
  return sourceVersionCurrentKind.value === 'source' || sourceVersionCurrentId.value === null
})

function isSwitchable(version) {
  return ['source', 'confirmed', 'user-edited'].includes(version.kind) && version.id !== sourceVersionCurrentId.value
}

function toggleSourceVersionPreview(version) {
  sourceVersionPreviewId.value = sourceVersionPreviewId.value === version.id ? null : version.id
}

async function loadSourceVersions() {
  sourceVersionsLoading.value = true
  try {
    const result = await dramaAPI.sourceVersions(props.dramaId)
    sourceVersions.value = result?.versions || []
    sourceVersionCurrentId.value = result?.current?.id ?? null
    sourceVersionCurrentKind.value = result?.current?.kind ?? null
    sourceSkippedAt.value = result?.skipped_at ?? null
  } catch (e) {
    sourceCleanupError.value = e.message || '版本历史读取失败'
  } finally {
    sourceVersionsLoading.value = false
  }
}

// 手动刷新：清掉冲突横幅再重读（409 后用户点"刷新复核"走这里）
function refreshVersions() {
  sourceConflict.value = ''
  return loadSourceVersions()
}

async function inspectSourceHealth() {
  sourceHealthLoading.value = true
  sourceCleanupError.value = ''
  try {
    sourceHealth.value = await dramaAPI.sourceHealthCheck(props.dramaId)
  } catch (e) {
    sourceCleanupError.value = e.message || '健康检查失败'
  } finally {
    sourceHealthLoading.value = false
  }
}

async function startSourceCleanup() {
  sourceCleanupStarting.value = true
  sourceCleanupError.value = ''
  try {
    sourceCleanupTask.value = await dramaAPI.startSourceCleanup(props.dramaId)
    toast.success('已提交原文整理任务，候选稿生成后请在这里复核')
  } catch (e) {
    sourceCleanupError.value = e.message || '整理任务提交失败'
  } finally {
    sourceCleanupStarting.value = false
  }
}

// 写路径统一执行器：进行中禁用、成功刷新列表、409 只刷新视图并提示复核（绝不自动重提覆盖他人结果）
async function runVersionAction(key, request, successMessage) {
  sourceActionPending.value = key
  sourceCleanupError.value = ''
  sourceConflict.value = ''
  try {
    await request()
    toast.success(successMessage)
    await loadSourceVersions()
  } catch (e) {
    if (e?.status === 409) {
      await loadSourceVersions()
      sourceConflict.value = e.message || '当前正文已变化，请刷新后重试'
    } else {
      sourceCleanupError.value = e.message || '操作失败'
    }
  } finally {
    sourceActionPending.value = null
  }
}

function confirmVersion(version) {
  return runVersionAction(
    `confirm-${version.id}`,
    () => dramaAPI.confirmSource(props.dramaId, { target_version_id: version.id, expected_current_version_id: sourceVersionCurrentId.value }),
    '已确认整理稿，当前正文已更新',
  )
}

function switchVersion(version) {
  return runVersionAction(
    `switch-${version.id}`,
    () => dramaAPI.switchSourceVersion(props.dramaId, { target_version_id: version.id, expected_current_version_id: sourceVersionCurrentId.value }),
    '已切换当前正文版本',
  )
}

function skipCleanup() {
  return runVersionAction('skip', () => dramaAPI.skipSource(props.dramaId), '已跳过整理，保留原文')
}

defineExpose({ loadSourceVersions })
</script>

<template>
  <section class="card source-cleanup-card">
    <div class="source-cleanup-head">
      <div>
        <span class="source-eyebrow">SOURCE REVIEW</span>
        <h2>原文整理与版本</h2>
        <p>先检查噪声与重复内容；整理稿在你确认前始终只是候选，不会替换当前正文。</p>
      </div>
      <div class="source-cleanup-actions">
        <button type="button" class="btn btn-sm" :disabled="sourceHealthLoading" @click="inspectSourceHealth">
          {{ sourceHealthLoading ? '检查中…' : '健康检查' }}
        </button>
        <button type="button" class="btn btn-primary btn-sm" :disabled="sourceCleanupStarting" @click="startSourceCleanup">
          {{ sourceCleanupStarting ? '正在提交…' : '开始整理' }}
        </button>
        <button v-if="canSkip" type="button" class="btn btn-sm" :disabled="sourceActionPending !== null" @click="skipCleanup">
          {{ sourceActionPending === 'skip' ? '处理中…' : '跳过整理' }}
        </button>
      </div>
    </div>
    <div v-if="sourceCleanupError" class="source-cleanup-error">{{ sourceCleanupError }}</div>
    <div v-if="sourceConflict" class="source-conflict">
      <strong>版本冲突</strong>
      <span>{{ sourceConflict }}</span>
      <button type="button" class="link-btn" @click="refreshVersions">刷新复核</button>
    </div>
    <div v-if="sourceHealth" class="source-health-summary">
      <strong>检查结果</strong>
      <span v-if="sourceHealth.issue_count">发现 {{ sourceHealth.issue_count }} 项可整理内容</span>
      <span v-else>未发现需要自动整理的内容</span>
      <span v-if="sourceHealth.char_count">当前 {{ Number(sourceHealth.char_count).toLocaleString() }} 字</span>
    </div>
    <div v-if="sourceCleanupTask" class="source-task-strip">
      <span class="source-task-dot"></span>
      <span>整理任务 {{ sourceCleanupTask.status === 'running' ? '处理中' : sourceCleanupTask.status }}</span>
      <small v-if="sourceCleanupTask.message">{{ sourceCleanupTask.message }}</small>
    </div>
    <div v-if="sourceSkippedAt" class="source-skipped-strip">已跳过自动整理 · {{ new Date(sourceSkippedAt).toLocaleString() }}，当前保留原文</div>
    <div class="source-version-list">
      <div class="source-version-list-head"><span>版本历史</span><button type="button" class="link-btn" @click="refreshVersions">刷新</button></div>
      <div v-if="sourceVersionsLoading" class="source-version-empty">正在读取版本历史…</div>
      <div v-else-if="!sourceVersions.length" class="source-version-empty">尚无版本记录。完成首次分集或发起整理后会自动建立原文版本。</div>
      <article v-for="version in sourceVersions" :key="version.id" :class="['source-version-row', { current: sourceVersionCurrentId === version.id, candidate: version.kind === 'cleaned' }]">
        <div><strong>{{ sourceVersionKindLabel(version.kind) }}</strong><small>V{{ version.id }} · {{ Number(version.content?.length || 0).toLocaleString() }} 字</small></div>
        <span v-if="sourceVersionCurrentId === version.id" class="source-current-badge">当前生效</span>
        <span v-else-if="version.kind === 'cleaned'" class="source-candidate-badge">待确认候选</span>
        <div class="source-version-actions">
          <button
            v-if="version.id === confirmableVersionId"
            type="button"
            class="btn btn-primary btn-sm"
            :disabled="sourceActionPending !== null"
            @click="confirmVersion(version)"
          >{{ sourceActionPending === `confirm-${version.id}` ? '确认中…' : '确认' }}</button>
          <button
            v-else-if="isSwitchable(version)"
            type="button"
            class="btn btn-sm"
            :disabled="sourceActionPending !== null"
            @click="switchVersion(version)"
          >{{ sourceActionPending === `switch-${version.id}` ? '切换中…' : '切换' }}</button>
          <button type="button" class="link-btn" @click="toggleSourceVersionPreview(version)">{{ sourceVersionPreviewId === version.id ? '收起' : '预览' }}</button>
        </div>
        <pre v-if="sourceVersionPreviewId === version.id" class="source-version-preview">{{ version.content }}</pre>
      </article>
    </div>
  </section>
</template>

<style scoped>
.source-eyebrow { color: var(--accent); font-family: var(--font-mono); font-size: 9px; font-weight: 800; letter-spacing: 0.14em; }
.source-cleanup-card { padding: 20px; }
.source-cleanup-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.source-cleanup-head h2 { margin: 2px 0 4px; color: var(--text-0); font-size: 17px; letter-spacing: -0.02em; }
.source-cleanup-head p { margin: 0; color: var(--text-3); font-size: 11.5px; line-height: 1.55; }
.source-cleanup-actions { display: flex; gap: 8px; flex-shrink: 0; flex-wrap: wrap; justify-content: flex-end; }
.source-cleanup-error { margin-top: 14px; padding: 9px 11px; border: 1px solid color-mix(in srgb, var(--danger) 35%, var(--border)); border-radius: 8px; background: color-mix(in srgb, var(--danger) 7%, var(--surface-raised)); color: var(--danger); font-size: 11px; }
.source-conflict { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 14px; padding: 10px 12px; border: 1px solid color-mix(in srgb, var(--warning) 40%, var(--border)); border-radius: 9px; background: color-mix(in srgb, var(--warning) 8%, var(--surface-raised)); }
.source-conflict strong { flex-shrink: 0; color: var(--warning); font-size: 11px; }
.source-conflict span { color: var(--text-2); font-size: 10.5px; line-height: 1.45; }
.source-health-summary, .source-task-strip { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; margin-top: 14px; padding: 10px 12px; border: 1px solid var(--border); border-radius: 9px; background: var(--bg-1); color: var(--text-2); font-size: 10.5px; }
.source-health-summary strong { color: var(--text-0); }
.source-task-strip { color: var(--accent-text); background: var(--accent-bg); }
.source-task-strip small { color: var(--text-2); }
.source-task-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 16%, transparent); }
.source-skipped-strip { margin-top: 14px; padding: 9px 12px; border: 1px solid var(--border); border-radius: 9px; background: var(--bg-1); color: var(--text-3); font-size: 10.5px; }
.source-version-list { margin-top: 16px; border-top: 1px solid var(--border); }
.source-version-list-head { display: flex; justify-content: space-between; padding: 12px 2px 7px; color: var(--text-2); font-size: 10px; font-weight: 750; letter-spacing: .08em; text-transform: uppercase; }
.link-btn { padding: 0; border: 0; background: none; color: var(--accent); font-size: 10px; font-weight: 700; cursor: pointer; }
.source-version-empty { padding: 13px 2px; color: var(--text-3); font-size: 11px; }
.source-version-row { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 10px; align-items: center; padding: 10px 11px; border-top: 1px solid var(--border); }
.source-version-row.current { background: color-mix(in srgb, var(--success) 5%, var(--surface-raised)); }
.source-version-row.candidate { background: color-mix(in srgb, var(--warning) 5%, var(--surface-raised)); }
.source-version-row strong { display: block; color: var(--text-1); font-size: 11px; }
.source-version-row small { display: block; margin-top: 2px; color: var(--text-3); font-family: var(--font-mono); font-size: 9px; }
.source-version-actions { display: flex; align-items: center; gap: 8px; }
.source-current-badge, .source-candidate-badge { padding: 3px 7px; border-radius: 99px; font-size: 9px; font-weight: 700; }
.source-current-badge { background: var(--success-bg); color: var(--success); }
.source-candidate-badge { background: color-mix(in srgb, var(--warning) 16%, var(--surface-raised)); color: var(--warning); }
.source-version-preview { grid-column: 1 / -1; max-height: 220px; overflow: auto; margin: 0; padding: 11px; border-radius: 7px; background: var(--surface-paper-warm); color: var(--text-2); font-family: "Noto Serif SC", "Songti SC", serif; font-size: 11px; line-height: 1.7; white-space: pre-wrap; }
</style>
