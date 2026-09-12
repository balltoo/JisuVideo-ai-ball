import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  auditShotReferenceImages,
  buildShotReferenceWarnings,
  formatRefAssetNames,
} from '../app/utils/shot-reference-audit.mjs'

// Issue #128 P1-3 行为测试：参考图审计纯函数。
// 业务背景（试跑 §4.2 P1-3）：`@名字` 在资产图缺失时被静默跳过、9 张参考图上限也静默丢弃，
// 用户只会看到「人物脸不一致」而无法归因。本测试锁死三件事：
//   ① 缺图素材必须被显式列出（missing）；
//   ② 因重复/超限未纳入的已绑定素材必须被列出（dropped）；
//   ③ included（= 实际送模型的参考图）与上述判定同源，顺序为 场景 → 角色 → 道具 → 手动上传。

const asset = (over = {}) => ({ key: 'k', type: '角色', name: '角色', imageUrl: '', ...over })

test('全部就绪且未超限：全部纳入，无 missing / dropped', () => {
  const audit = auditShotReferenceImages([
    asset({ key: 'scene-1', type: '场景', name: '咖啡厅', imageUrl: '/static/a.png' }),
    asset({ key: 'character-1', type: '角色', name: '小明', imageUrl: '/static/b.png' }),
    asset({ key: 'prop-1', type: '道具', name: '怀表', imageUrl: '/static/c.png' }),
  ])
  assert.equal(audit.used, 3)
  assert.deepEqual(audit.included.map(a => a.imageUrl), ['/static/a.png', '/static/b.png', '/static/c.png'])
  assert.deepEqual(audit.missing, [])
  assert.deepEqual(audit.dropped, [])
  assert.equal(audit.limit, 9)
})

test('已绑定但无图：进入 missing 并保留名字与类型（供 UI 指名告警）', () => {
  const audit = auditShotReferenceImages([
    asset({ key: 'character-1', type: '角色', name: '小明', imageUrl: '/static/b.png' }),
    asset({ key: 'character-2', type: '角色', name: '小红', imageUrl: '' }),
    asset({ key: 'scene-1', type: '场景', name: '天台', imageUrl: '   ' }),
  ])
  assert.deepEqual(audit.missing.map(a => [a.name, a.type]), [['小红', '角色'], ['天台', '场景']])
  // 缺图素材不进参考图，但不计入 dropped（它们是 missing，不是被上限挤掉）
  assert.deepEqual(audit.dropped, [])
  assert.deepEqual(audit.included.map(a => a.name), ['小明'])
})

test('同一图片 URL 去重：后者计入 dropped（不算 missing），提示口径为「重复或超限」', () => {
  const audit = auditShotReferenceImages([
    asset({ key: 'character-1', name: '小明', imageUrl: '/static/same.png' }),
    asset({ key: 'character-2', name: '小红', imageUrl: '/static/same.png' }),
  ])
  assert.deepEqual(audit.included.map(a => a.name), ['小明'])
  assert.deepEqual(audit.dropped.map(a => a.name), ['小红'])
  assert.deepEqual(audit.missing, [])
})

test('超过 9 张上限：溢出的已绑定素材全部计入 dropped 且顺序稳定', () => {
  const candidates = Array.from({ length: 11 }, (_, i) => asset({
    key: `character-${i + 1}`,
    name: `角色${i + 1}`,
    imageUrl: `/static/${i + 1}.png`,
  }))
  const audit = auditShotReferenceImages(candidates)
  assert.equal(audit.used, 9)
  assert.deepEqual(audit.dropped.map(a => a.name), ['角色10', '角色11'])
  assert.deepEqual(audit.missing, [])
})

test('自定义 limit 生效（默认 9）', () => {
  const candidates = [
    asset({ key: 'a', name: '甲', imageUrl: '/1.png' }),
    asset({ key: 'b', name: '乙', imageUrl: '/2.png' }),
    asset({ key: 'c', name: '丙', imageUrl: '/3.png' }),
  ]
  const audit = auditShotReferenceImages(candidates, { limit: 2 })
  assert.equal(audit.limit, 2)
  assert.equal(audit.used, 2)
  assert.deepEqual(audit.dropped.map(a => a.name), ['丙'])
})

test('手动上传不参与 missing/dropped 统计，但计入 used 与 included 顺序（排在绑定素材之后）', () => {
  const audit = auditShotReferenceImages([
    asset({ key: 'character-1', name: '小明', imageUrl: '/static/b.png' }),
    asset({ key: 'manual-/u1.png', type: '手动上传', name: '手动上传图片', imageUrl: '/u1.png', manual: true }),
    asset({ key: 'manual-/u2.png', type: '手动上传', name: '手动上传图片', imageUrl: '/u2.png', manual: true }),
  ])
  assert.equal(audit.used, 3)
  assert.deepEqual(audit.included.map(a => a.imageUrl), ['/static/b.png', '/u1.png', '/u2.png'])
  assert.deepEqual(audit.missing, [])
  assert.deepEqual(audit.dropped, [])
})

test('绑定素材已占满 9 张时，手动上传被挤掉但不报为 dropped（只提示已绑定素材）', () => {
  const candidates = Array.from({ length: 9 }, (_, i) => asset({
    key: `character-${i + 1}`, name: `角色${i + 1}`, imageUrl: `/static/${i + 1}.png`,
  }))
  candidates.push(asset({ key: 'manual-/u1.png', type: '手动上传', name: '手动上传图片', imageUrl: '/u1.png', manual: true }))
  const audit = auditShotReferenceImages(candidates)
  assert.equal(audit.used, 9)
  assert.deepEqual(audit.dropped, [])
})

test('非数组 / 空输入返回空审计，不抛错（容错参考面板未选中分镜）', () => {
  for (const input of [undefined, null, [], 'oops', 42]) {
    const audit = auditShotReferenceImages(input)
    assert.equal(audit.used, 0)
    assert.deepEqual(audit.included, [])
    assert.deepEqual(audit.missing, [])
    assert.deepEqual(audit.dropped, [])
    assert.equal(audit.limit, 9)
  }
})

test('formatRefAssetNames 输出「名字（类型）」并以顿号连接', () => {
  assert.equal(
    formatRefAssetNames([{ name: '小明', type: '角色' }, { name: '天台', type: '场景' }]),
    '小明（角色）、天台（场景）',
  )
  assert.equal(formatRefAssetNames([]), '')
  assert.equal(formatRefAssetNames(undefined), '')
})

test('buildShotReferenceWarnings：无问题返回空数组', () => {
  const warnings = buildShotReferenceWarnings(auditShotReferenceImages([
    asset({ name: '小明', imageUrl: '/static/b.png' }),
  ]))
  assert.deepEqual(warnings, [])
})

test('buildShotReferenceWarnings：缺图警告指名到具体素材，且说明一致性无法保证', () => {
  const warnings = buildShotReferenceWarnings(auditShotReferenceImages([
    asset({ key: 'character-2', type: '角色', name: '小红', imageUrl: '' }),
  ]))
  assert.equal(warnings.length, 1)
  assert.ok(warnings[0].includes('小红（角色）'), '警告应指名受影响的素材')
  assert.ok(warnings[0].includes('尚未生成参考图'))
  assert.ok(warnings[0].includes('视频一致性无法保证'))
})

test('buildShotReferenceWarnings：超限警告说明上限张数并列出被丢弃素材名', () => {
  const candidates = Array.from({ length: 10 }, (_, i) => asset({
    key: `character-${i + 1}`, name: `角色${i + 1}`, imageUrl: `/static/${i + 1}.png`,
  }))
  const warnings = buildShotReferenceWarnings(auditShotReferenceImages(candidates))
  assert.equal(warnings.length, 1)
  assert.ok(warnings[0].includes('参考图上限 9 张'))
  assert.ok(warnings[0].includes('角色10（角色）'))
})

test('buildShotReferenceWarnings：缺图与超限并存时给出两条独立警告', () => {
  const candidates = Array.from({ length: 10 }, (_, i) => asset({
    key: `character-${i + 1}`, name: `角色${i + 1}`, imageUrl: `/static/${i + 1}.png`,
  }))
  candidates.push(asset({ key: 'prop-1', type: '道具', name: '怀表', imageUrl: '' }))
  const warnings = buildShotReferenceWarnings(auditShotReferenceImages(candidates))
  assert.equal(warnings.length, 2)
  assert.ok(warnings.some(w => w.includes('怀表（道具）')))
  assert.ok(warnings.some(w => w.includes('角色10（角色）')))
})
