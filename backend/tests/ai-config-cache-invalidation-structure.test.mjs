import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

/**
 * Issue #130 / 试跑 HB-20260912-04 §4.3 P2-12 的核实结论固化为回归测试。
 *
 * 试跑结论怀疑「在设置页改完 AI 配置后后端仍用旧值」。核实现状：
 * - `services/ai.ts` 只有一处模块级配置缓存（10 秒 TTL 的 `configCache`），并导出 `invalidateAIConfigCache()`；
 * - `routes/aiConfigs.ts` 的三个写入口（POST / PUT /:id / DELETE /:id）均已调用失效；
 * - 其它读配置的地方（`services/generation.ts`、`services/video-prompts.ts`）直连数据库，不经过缓存。
 *
 * 因此该结论在当前代码上不成立。以下测试用于锁住这个不变量，防止后续新增写入口时漏掉失效调用。
 */

// 把 routes/aiConfigs.ts 按路由声明切成块，便于逐个检查块内行为
function splitRouteBlocks(source) {
  const matches = [...source.matchAll(/app\.(get|post|put|patch|delete)\(\s*'([^']*)'/g)]
  return matches.map((match, index) => {
    const start = match.index
    const end = index + 1 < matches.length ? matches[index + 1].index : source.length
    return {
      method: match[1].toUpperCase(),
      path: match[2],
      body: source.slice(start, end),
    }
  })
}

test('AI 配置的每个写入口都会主动失效读取缓存', () => {
  const route = read('src/routes/aiConfigs.ts')
  const blocks = splitRouteBlocks(route)

  const mutating = blocks.filter((block) =>
    ['POST', 'PUT', 'PATCH', 'DELETE'].includes(block.method)
    && /db\.(insert|update|delete)\(\s*schema\.aiServiceConfigs/.test(block.body),
  )

  // 现状是 POST /（新增）、PUT /:id（编辑）、DELETE /:id（删除）三个写入口；
  // 若将来新增写入口，这里会随之增加，并同样要求调用失效。
  assert.ok(mutating.length >= 3, `期望至少 3 个写入口，实际 ${mutating.length}`)

  for (const block of mutating) {
    assert.match(
      block.body,
      /invalidateAIConfigCache\(\)/,
      `${block.method} ${block.path} 写库后未调用 invalidateAIConfigCache()，改完配置会继续命中旧缓存`,
    )
  }
})

test('读取端缓存带 TTL 且失效函数对外导出', () => {
  const ai = read('src/services/ai.ts')

  assert.match(ai, /export function invalidateAIConfigCache/)
  assert.match(ai, /const CONFIG_CACHE_TTL_MS = \d[\d_]*/)
  assert.match(ai, /Date\.now\(\) \+ CONFIG_CACHE_TTL_MS/)
  // 命中过期条目必须删除，避免过期值被继续复用
  assert.match(ai, /if \(Date\.now\(\) >= entry\.expiresAt\)/)
})

test('除 services/ai.ts 外没有第二处配置缓存（其它读取端直连数据库）', () => {
  const files = [
    'src/services/generation.ts',
    'src/services/video-prompts.ts',
  ]

  for (const file of files) {
    const source = read(file)
    assert.doesNotMatch(source, /invalidateAIConfigCache/, `${file} 不应自行维护配置缓存`)
    assert.doesNotMatch(source, /CONFIG_CACHE_TTL_MS/, `${file} 不应自行维护配置缓存`)
  }

  // 这两个文件确实是直连读表，用于支撑「不经缓存」的判断
  const generation = read('src/services/generation.ts')
  const videoPrompts = read('src/services/video-prompts.ts')
  assert.match(generation, /from\(schema\.aiServiceConfigs\)/)
  assert.match(videoPrompts, /from\(schema\.aiServiceConfigs\)/)
})
