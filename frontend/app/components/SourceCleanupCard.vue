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
const sourceVersionPreviewId = ref(null)

function sourceVersionKindLabel(kind) {
  return ({ source: '原始正文', cleaned: '整理候选', confirmed: '已确认正文', 'user-edited': '人工编辑' })[kind] || kind
}

function toggleSourceVersionPreview(version) {
  sourceVersionPreviewId.value = sourceVersionPreviewId.value === version.id ? null : version.id
}

async function loadSourceVersions() {
  sourceVersionsLoading.value = true
  try {
    const result = await dramaAPI.sourceVersions(props.dramaId)
    sourceVersions.value = result?.versions || []
    sourceVersionCurrentId.value = result?.current?.id || null
  } catch (e) {
    sourceCleanupError.value = e.message || '版本历史读取失败'
  } finally {
    sourceVersionsLoading.value = false
  }
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
      </div>
    </div>
    <div v-if="sourceCleanupError" class="source-cleanup-error">{{ sourceCleanupError }}</div>
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
    <div class="source-version-list">
      <div class="source-version-list-head"><span>版本历史</span><button type="button" class="link-btn" @click="loadSourceVersions">刷新</button></div>
      <div v-if="sourceVersionsLoading" class="source-version-empty">正在读取版本历史…</div>
      <div v-else-if="!sourceVersions.length" class="source-version-empty">尚无版本记录。完成首次分集或发起整理后会自动建立原文版本。</div>
      <article v-for="version in sourceVersions" :key="version.id" :class="['source-version-row', { current: sourceVersionCurrentId === version.id, candidate: version.kind === 'cleaned' }]">
        <div><strong>{{ sourceVersionKindLabel(version.kind) }}</strong><small>V{{ version.id }} · {{ Number(version.content?.length || 0).toLocaleString() }} 字</small></div>
        <span v-if="sourceVersionCurrentId === version.id" class="source-current-badge">当前生效</span>
        <span v-else-if="version.kind === 'cleaned'" class="source-candidate-badge">待确认候选</span>
        <button type="button" class="link-btn" @click="toggleSourceVersionPreview(version)">{{ sourceVersionPreviewId === version.id ? '收起' : '预览' }}</button>
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
.source-cleanup-actions { display: flex; gap: 8px; flex-shrink: 0; }
.source-cleanup-error { margin-top: 14px; padding: 9px 11px; border: 1px solid color-mix(in srgb, var(--danger) 35%, var(--border)); border-radius: 8px; background: color-mix(in srgb, var(--danger) 7%, var(--surface-raised)); color: var(--danger); font-size: 11px; }
.source-health-summary, .source-task-strip { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; margin-top: 14px; padding: 10px 12px; border: 1px solid var(--border); border-radius: 9px; background: var(--bg-1); color: var(--text-2); font-size: 10.5px; }
.source-health-summary strong { color: var(--text-0); }
.source-task-strip { color: var(--accent-text); background: var(--accent-bg); }
.source-task-strip small { color: var(--text-2); }
.source-task-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 16%, transparent); }
.source-version-list { margin-top: 16px; border-top: 1px solid var(--border); }
.source-version-list-head { display: flex; justify-content: space-between; padding: 12px 2px 7px; color: var(--text-2); font-size: 10px; font-weight: 750; letter-spacing: .08em; text-transform: uppercase; }
.link-btn { padding: 0; border: 0; background: none; color: var(--accent); font-size: 10px; font-weight: 700; cursor: pointer; }
.source-version-empty { padding: 13px 2px; color: var(--text-3); font-size: 11px; }
.source-version-row { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 10px; align-items: center; padding: 10px 11px; border-top: 1px solid var(--border); }
.source-version-row.current { background: color-mix(in srgb, var(--success) 5%, var(--surface-raised)); }
.source-version-row.candidate { background: color-mix(in srgb, var(--warning) 5%, var(--surface-raised)); }
.source-version-row strong { display: block; color: var(--text-1); font-size: 11px; }
.source-version-row small { display: block; margin-top: 2px; color: var(--text-3); font-family: var(--font-mono); font-size: 9px; }
.source-current-badge, .source-candidate-badge { padding: 3px 7px; border-radius: 99px; font-size: 9px; font-weight: 700; }
.source-current-badge { background: var(--success-bg); color: var(--success); }
.source-candidate-badge { background: color-mix(in srgb, var(--warning) 16%, var(--surface-raised)); color: var(--warning); }
.source-version-preview { grid-column: 1 / -1; max-height: 220px; overflow: auto; margin: 0; padding: 11px; border-radius: 7px; background: var(--surface-paper-warm); color: var(--text-2); font-family: "Noto Serif SC", "Songti SC", serif; font-size: 11px; line-height: 1.7; white-space: pre-wrap; }
</style>
