import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

test('SourceCleanupCard component owns the read-path UI and state', () => {
  const card = read('app/components/SourceCleanupCard.vue')

  // props / expose contract
  assert.match(card, /dramaId:\s*\{\s*type:\s*Number,\s*required:\s*true\s*\}/)
  assert.match(card, /defineExpose\(\{\s*loadSourceVersions\s*\}\)/)

  // dependencies moved out of detail.vue
  assert.match(card, /import \{ toast \} from 'vue-sonner'/)
  assert.match(card, /import \{ dramaAPI \} from '~\/composables\/useApi'/)

  // action buttons
  assert.match(card, /健康检查/)
  assert.match(card, /开始整理/)
  assert.match(card, /@click="inspectSourceHealth"/)
  assert.match(card, /@click="startSourceCleanup"/)

  // health summary + task strip
  assert.match(card, /source-health-summary/)
  assert.match(card, /source-task-strip/)
  assert.match(card, /sourceCleanupTask\.status === 'running' \? '处理中'/)

  // version history list with badges + preview
  assert.match(card, /source-version-list/)
  assert.match(card, /sourceVersionKindLabel/)
  assert.match(card, /source-current-badge/)
  assert.match(card, /source-candidate-badge/)
  assert.match(card, /toggleSourceVersionPreview/)
  assert.match(card, /source-version-preview/)

  // the three API calls hit the merged backend endpoints
  assert.match(card, /dramaAPI\.sourceVersions\(props\.dramaId\)/)
  assert.match(card, /dramaAPI\.sourceHealthCheck\(props\.dramaId\)/)
  assert.match(card, /dramaAPI\.startSourceCleanup\(props\.dramaId\)/)
})

test('detail.vue mounts SourceCleanupCard and drives its refresh through a template ref', () => {
  const detail = read('app/views/drama/detail.vue')

  assert.match(detail, /import SourceCleanupCard from '~\/components\/SourceCleanupCard\.vue'/)
  assert.match(detail, /<SourceCleanupCard ref="sourceCleanupRef" :drama-id="dramaId" \/>/)
  assert.match(detail, /const sourceCleanupRef = ref\(null\)/)
  assert.match(detail, /await sourceCleanupRef\.value\?\.loadSourceVersions\(\)/)

  // the inline implementation must be fully removed (no duplicate state/handlers left behind)
  assert.doesNotMatch(detail, /const sourceHealth = ref/)
  assert.doesNotMatch(detail, /const sourceVersions = ref/)
  assert.doesNotMatch(detail, /async function loadSourceVersions/)
  assert.doesNotMatch(detail, /async function inspectSourceHealth/)
  assert.doesNotMatch(detail, /async function startSourceCleanup/)
  assert.doesNotMatch(detail, /class="card source-cleanup-card"/)
})

test('useApi exposes the three source-cleanup read-path methods on the merged endpoints', () => {
  const api = read('app/composables/useApi.ts')

  assert.match(api, /sourceHealthCheck: \(id: number\) => api\.post\(`\/dramas\/\$\{id\}\/source\/health-check`, \{\}\)/)
  assert.match(api, /startSourceCleanup: \(id: number\) => api\.post\(`\/dramas\/\$\{id\}\/source\/clean`, \{\}\)/)
  assert.match(api, /sourceVersions: \(id: number\) => api\.get\(`\/dramas\/\$\{id\}\/source\/versions`\)/)
})
