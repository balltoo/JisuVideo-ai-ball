import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

// Issue #128 P1-2 / P1-3 回归守卫：Step1 显式保存入口与资产缺图/超限警告的父子接线。
// P1-2 试跑现象：Step1 只有「跳过改写 / 重新改写」，真正的保存藏在 goNextStep() 里
//   （点底部「资产」才触发）；localScript 是纯内存 ref，刷新即丢，试跑者以为改动已丢失。
// P1-3 试跑现象：资产图缺失时 `@名字` 被静默跳过、9 张上限静默丢弃，用户只会看到
//   「人物脸不一致」而无法归因。
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8')
const episode = read('../app/views/drama/episode.vue')
const panel = read('../app/components/EpisodeScriptPanel.vue')

test('P1-2 组件：Step1 工具栏存在显式「保存」入口并 emit save-script', () => {
  // Step1 分支（<template v-else>）内必须出现保存按钮与其事件
  assert.match(panel, /<template v-else>[\s\S]*?emit\('save-script'\)/)
  assert.match(panel, /emit\('save-script'\)/)
  // 保存状态提示（未保存 / 已保存 / 自动保存提示）
  assert.match(panel, /:class="\['save-state', dirty \? 'is-dirty' : 'is-saved'\]"/)
  assert.match(panel, /saveStateText/)
  assert.match(panel, /if \(props\.saveNotice\) return props\.saveNotice/)
  assert.match(panel, /if \(props\.dirty\) return '未保存'/)
  assert.match(panel, /return hasLocal \? '已保存' : ''/)
  assert.match(panel, /saveNotice/)
  // 样式 token 化（不引入硬编码色值回退）
  assert.match(panel, /\.save-state\.is-dirty \{ color: var\(--warning-strong\); \}/)
  assert.match(panel, /\.save-state\.is-saved \{ color: var\(--text-3\); \}/)
})

test('P1-2 组件：既有 Step0 保存入口与脱管事件未被破坏', () => {
  assert.match(panel, /emit\('save-raw'\)/)
  assert.match(panel, /emit\('rewrite'\)/)
  assert.match(panel, /emit\('skip-rewrite'\)/)
  assert.match(panel, /emit\('update:raw'/)
  assert.match(panel, /emit\('update:script'/)
})

test('P1-2 主壳：受控下发 dirty/saveNotice，并接住 save-script', () => {
  assert.match(episode, /:dirty="stepDirty"/)
  assert.match(episode, /:save-notice="saveNotice"/)
  assert.match(episode, /@save-script="saveScript"/)
  // saveScript 复用既有 saveScr，反馈与 Step0 保存一致
  assert.match(episode, /function saveScript\(\) \{ saveScr\(\); toast\.success\('已保存'\) \}/)
})

test('P1-2 主壳：脏标记按 step 切换（raw/script 各自独立）', () => {
  assert.match(episode, /const rawDirty = computed\(\(\) => localRaw\.value !== rawContent\.value\)/)
  assert.match(episode, /const scriptDirty = computed\(\(\) => localScript\.value !== scriptContent\.value\)/)
  assert.match(episode, /const stepDirty = computed\(\(\) => \(scriptStep\.value === 0 \? rawDirty\.value : scriptDirty\.value\)\)/)
})

test('P1-2 主壳：2s debounce 自动保存，且不打扰改写进行中的 Agent 回写', () => {
  assert.match(episode, /const SCRIPT_AUTOSAVE_DELAY_MS = 2000/)
  assert.match(episode, /watch\(localScript, \(\) => \{/)
  // 改写进行中（rn && rt === 'script_rewriter'）直接返回，避免与 Agent 保存抢跑
  assert.match(episode, /if \(rn\.value && rt\.value === 'script_rewriter'\) return/)
  assert.match(episode, /window\.setTimeout\(\(\) => \{ scriptAutosaveTimer = null; autosaveScript\(\) \}, SCRIPT_AUTOSAVE_DELAY_MS\)/)
  // 自动保存与显式保存共用 saveScr
  assert.match(episode, /function autosaveScript\(\) \{[\s\S]*?saveScr\(\)/)
})

test('P1-2 主壳：beforeunload 未保存提示 + 卸载时清理计时器', () => {
  assert.match(episode, /function handleBeforeUnload\(e\) \{/)
  assert.match(episode, /if \(!rawDirty\.value && !scriptDirty\.value\) return/)
  assert.match(episode, /e\.preventDefault\(\)/)
  assert.match(episode, /onMounted\(\(\) => window\.addEventListener\('beforeunload', handleBeforeUnload\)\)/)
  assert.match(episode, /window\.removeEventListener\('beforeunload', handleBeforeUnload\)/)
  // 卸载清理两个计时器（自动保存 / 保存提示）
  assert.match(episode, /window\.clearTimeout\(scriptAutosaveTimer\)/)
  assert.match(episode, /window\.clearTimeout\(saveNoticeTimer\)/)
})

test('P1-3 主壳：参考图审计接入且为实际取值单一来源', () => {
  assert.match(episode, /import \{ auditShotReferenceImages, buildShotReferenceWarnings \} from '~\/utils\/shot-reference-audit\.mjs'/)
  assert.match(episode, /function shotRefCandidates\(sb\) \{/)
  // 候选顺序：场景 → 角色 → 道具 → 手动上传（与既有实现一致）
  assert.match(episode, /const scene = getStoryboardScene\(sb\)[\s\S]*?for \(const char of getStoryboardCharacters\(sb\)\)[\s\S]*?for \(const prop of getStoryboardProps\(sb\)\)[\s\S]*?for \(const url of videoRefImageUrls\.value\)/)
  // 审计结果与警告
  assert.match(episode, /const shotRefAudit = computed\(\(\) => \(/)
  assert.match(episode, /auditShotReferenceImages\(shotRefCandidates\(selectedSb\.value\)\)/)
  assert.match(episode, /const shotRefWarnings = computed\(\(\) => buildShotReferenceWarnings\(shotRefAudit\.value\)\)/)
  // 实际取值（参考图列表 / @索引映射）均改为消费审计结果 —— 警告与送模型内容不分叉
  assert.match(episode, /function getShotReferenceImages\(sb\) \{\s*\n\s*return auditShotReferenceImages\(shotRefCandidates\(sb\)\)\.included\.map\(asset => asset\.imageUrl\)/)
  assert.match(episode, /const included = auditShotReferenceImages\(shotRefCandidates\(sb\)\)\.included\.filter\(asset => !asset\.manual\)/)
})

test('P1-3 主壳：分镜参考面板与视频检查器均渲染警告，且带样式类', () => {
  const occurrences = episode.match(/v-if="shotRefWarnings\.length"/g) || []
  assert.ok(occurrences.length >= 2, `警告应同时出现在分镜与视频面板，实际 ${occurrences.length} 处`)
  assert.match(episode, /class="storyboard-ref-warnings"/)
  assert.match(episode, /class="video-inspector-warnings"/)
  // 文案经插槽渲染（指名到具体素材由纯函数负责，见 shot-reference-audit-behavior.test.mjs）
  assert.match(episode, /\{\{ warning \}\}/)
  // 新增样式的配色全部走 token（episode.vue 禁止带硬编码回退的 var）
  assert.match(episode, /\.storyboard-ref-warnings \{[\s\S]*?border-bottom: 1px solid var\(--warning-border-strong\)[\s\S]*?background: var\(--warning-bg\)/)
  assert.match(episode, /\.video-inspector-warning \{[\s\S]*?border: 1px solid var\(--warning-border-strong\)[\s\S]*?background: var\(--warning-bg\)/)
  assert.match(episode, /\.storyboard-ref-warning \{[\s\S]*?color: var\(--warning-strong\)/)
  assert.match(episode, /\.storyboard-ref-warning-icon \{[\s\S]*?background: var\(--warning-strong\)[\s\S]*?color: var\(--text-invert\)/)
})
