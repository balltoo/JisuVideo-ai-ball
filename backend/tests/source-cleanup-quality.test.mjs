import assert from 'node:assert/strict'
import test from 'node:test'

const service = await import('../src/services/source-cleanup.ts')

const baseline = '第一章 起点\n这是一段需要保留的正文内容。\n关注公众号领取福利\n这是一段需要保留的正文内容。\n'
const hash = 'a'.repeat(64)

test('健康检查是纯规则：能分类问题，章节标题不当作删除噪声', () => {
  const result = service.inspectSourceHealth(baseline)
  assert.equal(result.status, 'issues')
  assert.equal(result.char_count, baseline.trim().length)
  assert.equal(result.issues.find(item => item.type === 'ad')?.count, 1)
  assert.equal(result.issues.find(item => item.type === 'duplicate')?.count, 1)
  assert.equal(result.issues.some(item => item.type === 'chapter_marker'), false)
})

test('质量门拒绝旧基线、越界、重叠、片段不一致和章节标题删除', () => {
  const content = baseline.trim()
  const start = content.indexOf('关注公众号')
  const valid = {
    input_version_id: 7,
    input_content_hash: hash,
    removals: [{ start, end: start + '关注公众号领取福利'.length, snippet: '关注公众号领取福利', category: 'ad' }],
  }
  assert.equal(service.applySourceRemovals(content, service.validateSourceCleanupProposal(content, 7, hash, valid)), '第一章 起点\n这是一段需要保留的正文内容。\n\n这是一段需要保留的正文内容。')
  assert.throws(() => service.validateSourceCleanupProposal(content, 8, hash, valid), /正文版本已变化/)
  assert.throws(() => service.validateSourceCleanupProposal(content, 7, hash, { ...valid, removals: [{ ...valid.removals[0], end: content.length + 1 }] }), /坐标越界/)
  assert.throws(() => service.validateSourceCleanupProposal(content, 7, hash, { ...valid, removals: [{ ...valid.removals[0], snippet: '不一致' }] }), /不一致/)
  assert.throws(() => service.validateSourceCleanupProposal(content, 7, hash, {
    ...valid,
    removals: [{ start: 0, end: '第一章 起点'.length, snippet: '第一章 起点', category: 'garbage' }],
  }), /章节标题/)
  assert.throws(() => service.validateSourceCleanupProposal(content, 7, hash, {
    ...valid,
    removals: [valid.removals[0], { start: start + 1, end: start + 3, snippet: content.slice(start + 1, start + 3), category: 'ad' }],
  }), /不得重叠/)
})

test('恢复分派、检查点和路由保持 source_cleanup 专用边界', async () => {
  const fs = await import('node:fs/promises')
  const [recovery, dramas, cleanup] = await Promise.all([
    fs.readFile(new URL('../src/services/recovery.ts', import.meta.url), 'utf8'),
    fs.readFile(new URL('../src/routes/dramas.ts', import.meta.url), 'utf8'),
    fs.readFile(new URL('../src/services/source-cleanup.ts', import.meta.url), 'utf8'),
  ])
  assert.match(recovery, /task\.type === SOURCE_CLEANUP_TYPE/)
  assert.match(recovery, /resumeSourceCleanupTask\(task\.id\)/)
  assert.match(dramas, /source\/health-check/)
  assert.match(dramas, /source\/clean\/estimate/)
  assert.match(dramas, /source\/clean/)
  assert.match(cleanup, /submission_state: 'submitting'/)
  assert.match(cleanup, /submission_state: 'not_submitted'/)
  assert.match(cleanup, /ADAPTER_UNAVAILABLE/)
})
