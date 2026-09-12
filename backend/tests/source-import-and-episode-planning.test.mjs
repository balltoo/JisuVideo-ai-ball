import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractReadableText } from '../src/services/source-import.ts'
import {
  defaultEpisodeCount,
  splitSourceIntoEpisodes,
  stripEpisodeNumberPrefix,
} from '../src/services/episode-planning.ts'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

test('HTML novel import removes executable and navigation content', () => {
  const result = extractReadableText(`<!doctype html><html><head><title>测试小说</title><style>.x{}</style></head><body><nav>目录</nav><article><h1>第一章</h1><p>夜里十点，他重新打开电脑。</p><p>屏幕上的光照亮了桌面。</p></article><script>alert('x')</script></body></html>`, 'text/html; charset=utf-8')
  assert.equal(result.title, '测试小说')
  assert.match(result.content, /第一章/)
  assert.match(result.content, /夜里十点/)
  assert.doesNotMatch(result.content, /目录|alert|\.x/)
})

test('episode splitting keeps source order and creates reviewable content for every episode', () => {
  const paragraphs = Array.from({ length: 12 }, (_, index) => `第${index + 1}段：这是按顺序保留的原文内容。`)
  const source = paragraphs.join('\n\n')
  const result = splitSourceIntoEpisodes(source, 4, [
    { title: '起点' }, { title: '推进' }, { title: '转折' }, { title: '收束' },
  ])
  assert.equal(result.length, 4)
  assert.deepEqual(result.map(item => item.title), ['起点', '推进', '转折', '收束'])
  assert.equal(result.map(item => item.content).join(''), source)
  assert.ok(result.every(item => item.content && item.character_count > 0))
})

test('episode splitting never drops a long unpunctuated prefix before punctuation', () => {
  const source = `${'甲'.repeat(1317)}。${'乙'.repeat(2300)}！结尾`
  const result = splitSourceIntoEpisodes(source, 4)
  assert.equal(result.map(item => item.content).join(''), source)
  assert.equal(result.reduce((sum, item) => sum + item.character_count, 0), source.length)
})

test('oversized source is rejected explicitly instead of being silently truncated', () => {
  assert.throws(
    () => extractReadableText('字'.repeat(200_001), 'text/plain'),
    /超过20万字.*未保存任何截断内容/,
  )
})

test('兜底集数按短剧节奏估算，不再把 2600 字原文算成 1 集', () => {
  // 实测样本：2635 字原文最终选定 3 集，旧的 3500 除数会算出 1 集
  assert.equal(defaultEpisodeCount(2635), 3)
  assert.equal(defaultEpisodeCount(886), 1)
  assert.equal(defaultEpisodeCount(3000), 3)
  // 仍然限制在 1-30 集
  assert.equal(defaultEpisodeCount(400), 1)
  assert.equal(defaultEpisodeCount(0), 1)
  assert.equal(defaultEpisodeCount(60_000), 30)
})

test('标题的「第N集：」前缀会被剥离，避免与前端 EP 0N 重复', () => {
  // 全角/半角冒号、空格、中文数字、其它集次量词
  assert.equal(stripEpisodeNumberPrefix('第1集：沉默的周一'), '沉默的周一')
  assert.equal(stripEpisodeNumberPrefix('第 2 集: 三行的答案'), '三行的答案')
  assert.equal(stripEpisodeNumberPrefix('第3集 打印机旁的人'), '打印机旁的人')
  assert.equal(stripEpisodeNumberPrefix('第十二回、收束'), '收束')
  assert.equal(stripEpisodeNumberPrefix('第4话·加班'), '加班')
  // 仅前缀、无正文时保持原样，不能把标题剥成空串
  assert.equal(stripEpisodeNumberPrefix('第1集'), '第1集')
  assert.equal(stripEpisodeNumberPrefix('第1集：   '), '第1集：')
  // 前缀后直接接正文（无分隔符）属于正常标题，不能误伤
  assert.equal(stripEpisodeNumberPrefix('第三集的反转'), '第三集的反转')
  assert.equal(stripEpisodeNumberPrefix('沉默的周一'), '沉默的周一')
  assert.equal(stripEpisodeNumberPrefix(''), '')
})

test('分集切片产出的标题已不含集数前缀', () => {
  const source = `第一段正文。第二段正文。第三段正文。第四段正文。`
  const result = splitSourceIntoEpisodes(source, 2, [
    { title: '第1集：起点' },
    { title: '第2集：收束' },
  ])
  assert.deepEqual(result.map(item => item.title), ['起点', '收束'])
  assert.equal(result.map(item => item.content).join(''), source)
})

test('drama routes expose safe link import, AI episode planning and controlled draft sync', () => {
  const route = read('src/routes/dramas.ts')
  const importer = read('src/services/source-import.ts')
  const agents = read('src/agents/index.ts')

  assert.match(route, /app\.post\('\/import-source'/)
  assert.match(route, /app\.post\('\/:id\/analyze-episodes'/)
  assert.match(route, /app\.get\('\/:id\/episode-plan'/)
  assert.match(route, /app\.put\('\/:id\/episode-plan'/)
  assert.match(route, /app\.post\('\/:id\/episodes\/from-plan'/)
  assert.match(route, /generated_episode_ids/)
  assert.match(route, /VERSION_CONFLICT/)
  assert.match(route, /FOR UPDATE/)
  // #79：分集草稿与最终生成必须以当前有效正文校验，不能固定回读初始 description。
  assert.match(route, /effectiveSourceText/)
  assert.match(route, /sourceHash\(effectiveSourceText\)/)
  assert.match(route, /已经进入剧本、分镜或制作阶段/)
  assert.match(route, /getActiveConfigId\('image'\)/)
  assert.match(route, /review_notes/)
  assert.match(route, /请先综合所有意见，再重新判断集数和分集边界/)
  assert.match(importer, /不能读取本机或局域网链接/)
  assert.match(importer, /MAX_SOURCE_BYTES/)
  assert.match(importer, /requestPinnedPage/)
  assert.match(agents, /episode_planner/)
})
