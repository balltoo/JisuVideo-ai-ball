import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

test('useApi exposes the source-version write-path methods incl edit-current on the merged endpoints', () => {
  const api = read('app/composables/useApi.ts')

  assert.match(api, /confirmSource: \(id: number, data: \{ target_version_id: number; expected_current_version_id: number \| null \}\) => api\.post\(`\/dramas\/\$\{id\}\/source\/confirm`, data\)/)
  assert.match(api, /skipSource: \(id: number, note\?: string\) => api\.post\(`\/dramas\/\$\{id\}\/source\/skip`, \{ note \}\)/)
  assert.match(api, /switchSourceVersion: \(id: number, data: \{ target_version_id: number; expected_current_version_id: number \| null \}\) => api\.post\(`\/dramas\/\$\{id\}\/source\/switch`, data\)/)
  // 74-B-2: editing the current text maps to PUT /source/current with a non-nullable CAS pointer
  assert.match(api, /updateCurrentSource: \(id: number, data: \{ expected_current_version_id: number; content: string; note\?: string \}\) => api\.put\(`\/dramas\/\$\{id\}\/source\/current`, data\)/)
})

test('SourceCleanupCard renders confirm/skip/switch actions guarded by backend semantics', () => {
  const card = read('app/components/SourceCleanupCard.vue')

  // confirm only on the latest cleaned candidate under the current baseline
  assert.match(card, /confirmableVersionId/)
  assert.match(card, /v\.kind === 'cleaned' && \(v\.parent_version_id \?\? null\) === currentId/)
  assert.match(card, /v-if="version\.id === confirmableVersionId"/)
  assert.match(card, /@click="confirmVersion\(version\)"/)

  // switch only on effective (non-cleaned) versions that are not current
  assert.match(card, /function isSwitchable\(version\)/)
  assert.match(card, /\['source', 'confirmed', 'user-edited'\]\.includes\(version\.kind\) && version\.id !== sourceVersionCurrentId\.value/)
  assert.match(card, /@click="switchVersion\(version\)"/)

  // skip only when current is source (or no pointer) and not already skipped
  assert.match(card, /const canSkip = computed/)
  assert.match(card, /sourceVersionCurrentKind\.value === 'source' \|\| sourceVersionCurrentId\.value === null/)
  assert.match(card, /v-if="canSkip"/)
  assert.match(card, /@click="skipCleanup"/)

  // cleaned candidates must never be switchable directly (no switch button on cleaned rows)
  assert.doesNotMatch(card, /isSwitchable[\s\S]{0,120}'cleaned'[\s\S]{0,40}includes/)
})

test('SourceCleanupCard handles 409 VERSION_CONFLICT by refreshing for review, never auto-retrying', () => {
  const card = read('app/components/SourceCleanupCard.vue')

  // dedicated conflict state, separate from generic error
  assert.match(card, /const sourceConflict = ref\(''\)/)
  assert.match(card, /const sourceActionPending = ref\(null\)/)

  // the unified action runner branches on e.status === 409
  assert.match(card, /async function runVersionAction\(key, request, successMessage\)/)
  assert.match(card, /if \(e\?\.status === 409\)/)

  // 409 path reloads the version list (read) and surfaces the conflict, but does NOT re-issue the write
  const conflictBlock = card.slice(card.indexOf('if (e?.status === 409)'))
  const reloadIdx = conflictBlock.indexOf('await loadSourceVersions()')
  const conflictSetIdx = conflictBlock.indexOf('sourceConflict.value =')
  assert.ok(reloadIdx > -1, '409 branch must refresh the version list')
  assert.ok(conflictSetIdx > -1, '409 branch must set the conflict message')
  assert.ok(!/confirmSource|switchSourceVersion|skipSource/.test(conflictBlock.slice(0, conflictSetIdx + 40)), '409 branch must not auto-retry the write')

  // visible conflict banner with an explicit refresh-for-review action
  assert.match(card, /v-if="sourceConflict" class="source-conflict"/)
  assert.match(card, /刷新复核/)
  assert.match(card, /function refreshVersions\(\)/)

  // success path passes the CAS expected pointer (null allowed)
  assert.match(card, /expected_current_version_id: sourceVersionCurrentId\.value/)
})

test('SourceCleanupCard surfaces skipped state and keeps preview/read path intact', () => {
  const card = read('app/components/SourceCleanupCard.vue')

  assert.match(card, /const sourceSkippedAt = ref\(null\)/)
  assert.match(card, /sourceSkippedAt\.value = result\?\.skipped_at \?\? null/)
  assert.match(card, /v-if="sourceSkippedAt" class="source-skipped-strip"/)

  // read path from 74-A is preserved
  assert.match(card, /defineExpose\(\{ loadSourceVersions \}\)/)
  assert.match(card, /健康检查/)
  assert.match(card, /开始整理/)
  assert.match(card, /source-version-preview/)
})

test('SourceCleanupCard edit entry only on confirmed/user-edited current, prefilled with full text, saves via PUT current', () => {
  const card = read('app/components/SourceCleanupCard.vue')

  // edit is offered only when the effective version is confirmed or user-edited (backend base_kind rule)
  assert.match(card, /const canEditCurrent = computed/)
  assert.match(card, /\['confirmed', 'user-edited'\]\.includes\(sourceVersionCurrentKind\.value\)/)
  assert.match(card, /v-if="canEditCurrent && !sourceEditing"/)
  assert.match(card, /@click="beginEditCurrent"/)

  // prefill = the FULL content of the current version row (text must never be truncated before edit)
  assert.match(card, /const currentEditableContent = computed/)
  assert.match(card, /sourceVersions\.value\.find\(v => Number\(v\.id\) === Number\(id\)\)/)
  assert.match(card, /:maxlength="200000"/)
  assert.match(card, /编辑当前正文/)

  // saving issues PUT /source/current with the non-nullable expected pointer, full content and optional note
  assert.match(card, /async function saveEditCurrent\(\)/)
  assert.match(card, /updateCurrentSource\(props\.dramaId/)
  assert.match(card, /expected_current_version_id: currentId/)
  assert.match(card, /note: sourceEditNote\.value\?\.trim\(\) \|\| undefined/)
  assert.match(card, /正文不能为空/)

  // 409 conflict keeps the editor open (no silent overwrite); success path closes it
  assert.match(card, /if \(!sourceConflict\.value\)/)
  assert.match(card, /cancelEditCurrent\(\)/)
})
