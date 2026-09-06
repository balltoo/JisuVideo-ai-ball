import assert from 'node:assert/strict'
import test from 'node:test'

const { buildSourceAnchors } = await import('../src/services/source-anchors.ts')

test('锚点按版本独立生成：重复段落保留各自 occurrence 与坐标', () => {
  const text = '第一章 开始\n相同的正文段落内容\n相同的正文段落内容\n尾声。'
  const anchors = buildSourceAnchors(9, 21, text)
  assert.equal(anchors.length, 4)
  assert.equal(anchors[1].versionId, 21)
  assert.match(anchors[1].paraId, /^PARA-[a-f0-9]{8}:1$/)
  assert.match(anchors[2].paraId, /^PARA-[a-f0-9]{8}:2$/)
  assert.equal(anchors[1].hash, anchors[2].hash)
  assert.notEqual(anchors[1].start, anchors[2].start)
  assert.equal(text.slice(anchors[2].start, anchors[2].end), '相同的正文段落内容')
  assert.equal(anchors[0].anchorText, '第一章 开始')
})

test('锚点 hash、段首短锚与序号在相同输入下完全确定', () => {
  const text = '一段超过十二个字符的正文内容ABC\n第二段内容'
  const first = buildSourceAnchors(1, 2, text)
  const second = buildSourceAnchors(1, 2, text)
  assert.deepEqual(first, second)
  assert.equal(first[0].anchorText, '一段超过十二个字符的正文')
  assert.equal(first[0].sortOrder, 0)
  assert.equal(first[1].sortOrder, 1)
})

test('source_cleaner 注册后会接通 #72 的统一适配器，而不是绕过质量门直写正文', async () => {
  const cleanup = await import('../src/services/source-cleanup.ts')
  assert.equal(cleanup.isSourceCleanupAdapterReady(), false)
  await import('../src/agents/index.ts')
  assert.equal(cleanup.isSourceCleanupAdapterReady(), true)
})
