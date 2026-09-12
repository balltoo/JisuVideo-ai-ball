/**
 * Issue #121 批次 A：项目圣经（大纲与全局设定）数据模型与读路径
 *
 * 覆盖：
 *   - 纯函数：normalizeProjectBible 限长/集号规范化、projectBibleHash、serializeProjectBible、空态
 *   - 结构守卫：DDL 幂等、指针幂等 ALTER、三个端点、版本行不可变（无 UPDATE/DELETE）
 *   - 真实 MySQL：建表列类型、空态、首次保存、指针切换、历史倒序、乐观锁 409、跨项目隔离
 *
 * 真实 DB 段仅本地显式 SOURCE_DB_TEST=0 时 skip；CI 连接失败直接失败（与仓库「无 MySQL 两态」约定一致）。
 *
 * 运行：cd backend && npm test
 */
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import assert from 'node:assert/strict'

// 必须先设置这两个变量，再动态导入任何 ../src/** 模块（db/index.ts 顶层 initDb 会跳过建表）。
// node --test 会先求值静态 import，故本文件不得用静态 import 引入 src。
process.env.NODE_ENV = 'test'
process.env.MYSQL_NO_INIT = '1'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

const {
  normalizeProjectBible,
  projectBibleHash,
  isProjectBibleEmpty,
  serializeProjectBible,
  emptyProjectBible,
  getProjectBible,
  saveProjectBible,
  listProjectBibleVersions,
  ProjectBibleConflict,
  ProjectBibleNotFound,
  PROJECT_BIBLE_SOURCES,
} = await import('../src/services/project-bible.ts')

// ─── 1. 纯函数：规范化 ────────────────────────────────────────────────────
test('normalizeProjectBible：字段修剪、集号保留/补号/去重/升序、空串列表项剔除', () => {
  const bible = normalizeProjectBible({
    logline: '  一句话卖点  ',
    genre: '职场',
    stages: [{ name: ' 开局 ', goal: '建立冲突', episode_range: '1-3' }],
    foreshadowing: ['体检报告', '', '   '],
    forbidden: ['不可提前揭示反派身份'],
    episodes: [
      { episode_number: 2, objective: 'B', hook: 'h2', previous_recap: 'p2', next_teaser: 'n2' },
      { episode_number: 1, objective: 'A', hook: 'h1', previous_recap: 'p1', next_teaser: 'n1' },
      { episode_number: 2, objective: '重复集号应丢弃' },
      { objective: '无合法集号按位置补号' },
    ],
  })
  assert.equal(bible.logline, '一句话卖点')
  assert.equal(bible.genre, '职场')
  assert.deepEqual(bible.stages, [{ name: '开局', goal: '建立冲突', episode_range: '1-3' }])
  assert.deepEqual(bible.foreshadowing, ['体检报告'])
  assert.deepEqual(bible.forbidden, ['不可提前揭示反派身份'])
  assert.deepEqual(bible.episodes.map((item) => item.episode_number), [1, 2, 4])
  assert.equal(bible.episodes[0].objective, 'A')
  assert.equal(bible.episodes[1].hook, 'h2')
})

test('normalizeProjectBible：非对象输入降级为全空结构，不抛错', () => {
  const bible = normalizeProjectBible(null)
  assert.equal(bible.logline, '')
  assert.deepEqual(bible.stages, [])
  assert.deepEqual(bible.episodes, [])
})

test('normalizeProjectBible：超出上限抛错', () => {
  assert.throws(() => normalizeProjectBible({ logline: 'x'.repeat(501) }), /一句话卖点超过 500 字上限/)
  assert.throws(
    () => normalizeProjectBible({ stages: Array.from({ length: 21 }, () => ({ name: 'a' })) }),
    /阶段结构最多 20 条/,
  )
  assert.throws(
    () => normalizeProjectBible({ episodes: Array.from({ length: 201 }, () => ({})) }),
    /每集目标最多 200 条/,
  )
})

// ─── 2. 纯函数：哈希、序列化、空态 ────────────────────────────────────────
test('projectBibleHash：与规范化 JSON 的 sha256 一致，且对 trim 归一化', () => {
  const normalized = normalizeProjectBible({ logline: 'A' })
  assert.equal(projectBibleHash(normalized), createHash('sha256').update(JSON.stringify(normalized)).digest('hex'))
  assert.equal(projectBibleHash(normalized), projectBibleHash(normalizeProjectBible({ logline: '  A  ' })))
  assert.notEqual(projectBibleHash(normalized), projectBibleHash(normalizeProjectBible({ logline: 'B' })))
})

test('isProjectBibleEmpty：全空为 true，任一字段/条目非空为 false', () => {
  assert.equal(isProjectBibleEmpty(normalizeProjectBible({})), true)
  assert.equal(isProjectBibleEmpty(normalizeProjectBible({ logline: '   ' })), true)
  assert.equal(isProjectBibleEmpty(normalizeProjectBible({ logline: 'A' })), false)
  assert.equal(isProjectBibleEmpty(normalizeProjectBible({ stages: [{ name: '', goal: '', episode_range: '' }] })), true)
  assert.equal(isProjectBibleEmpty(normalizeProjectBible({ stages: [{ goal: '阶段目标' }] })), false)
  assert.equal(isProjectBibleEmpty(normalizeProjectBible({ foreshadowing: ['伏笔'] })), false)
  assert.equal(isProjectBibleEmpty(normalizeProjectBible({ forbidden: ['禁区'] })), false)
  assert.equal(isProjectBibleEmpty(normalizeProjectBible({ episodes: [{ episode_number: 1, hook: '钩子' }] })), false)
  // 只有空集号、无任何文字的条目不算内容
  assert.equal(isProjectBibleEmpty(normalizeProjectBible({ episodes: [{ episode_number: 2 }] })), true)
})

test('serializeProjectBible：整版全空视为无数据（has_data=false），空态不消失', () => {
  const view = serializeProjectBible({
    id: 9, source: 'manual', content_hash: 'h', created_at: 't', updated_at: 't', outline_json: JSON.stringify({}),
  })
  assert.equal(view.version_id, 9)
  assert.equal(view.has_data, false, '空版本不得显示为已确认')
})

test('serializeProjectBible / emptyProjectBible：读视图字段完整', () => {
  const empty = emptyProjectBible()
  assert.equal(empty.has_data, false)
  assert.equal(empty.bible, null)
  assert.equal(empty.version_id, null)

  const view = serializeProjectBible({
    id: 7,
    source: 'package-import',
    content_hash: 'abc',
    created_at: 't1',
    updated_at: 't2',
    outline_json: JSON.stringify({ logline: '导入大纲' }),
  })
  assert.equal(view.version_id, 7)
  assert.equal(view.source, 'package-import')
  assert.equal(view.content_hash, 'abc')
  assert.equal(view.has_data, true)
  assert.equal(view.bible.logline, '导入大纲')
})

test('来源白名单含 manual / package-import / system', () => {
  assert.deepEqual([...PROJECT_BIBLE_SOURCES], ['manual', 'package-import', 'system'])
})

// ─── 3. 结构守卫 ──────────────────────────────────────────────────────────
test('DDL：project_bible_versions 用 CREATE TABLE IF NOT EXISTS，指针列幂等 ALTER', () => {
  const schema = read('src/db/mysql-schema.ts')
  assert.match(schema, /CREATE TABLE IF NOT EXISTS project_bible_versions /)
  assert.match(schema, /ALTER TABLE dramas ADD COLUMN current_bible_version_id INT AFTER source_skip_at/)
  assert.match(schema, /information_schema\.COLUMNS[\s\S]{0,200}current_bible_version_id/)
})

test('DDL：outline_json 为 LONGTEXT、content_hash 为 VARCHAR(64)、source 有默认值', () => {
  const schema = read('src/db/mysql-schema.ts')
  const table = schema.slice(schema.indexOf('CREATE TABLE IF NOT EXISTS project_bible_versions'))
    .slice(0, schema.slice(schema.indexOf('CREATE TABLE IF NOT EXISTS project_bible_versions')).indexOf('ENGINE=InnoDB'))
  assert.match(table, /outline_json LONGTEXT NOT NULL/)
  assert.match(table, /content_hash VARCHAR\(64\) NOT NULL/)
  assert.match(table, /source VARCHAR\(32\) NOT NULL DEFAULT 'manual'/)
})

test('路由：GET/PUT /:id/bible 与 GET /:id/bible/versions，冲突 409、不存在 404', () => {
  const src = read('src/routes/dramas.ts')
  assert.match(src, /app\.get\('\/:id\/bible'/)
  assert.match(src, /app\.put\('\/:id\/bible'/)
  assert.match(src, /app\.get\('\/:id\/bible\/versions'/)
  assert.match(src, /err instanceof ProjectBibleConflict\) return conflict/)
  assert.match(src, /err instanceof ProjectBibleNotFound\) return notFound/)
  assert.match(src, /expected_version_id/)
})

test('版本行不可变：服务不存在 project_bible_versions 的 UPDATE / DELETE，只 INSERT + 切指针', () => {
  const src = read('src/services/project-bible.ts')
  assert.match(src, /INSERT INTO project_bible_versions/)
  assert.doesNotMatch(src, /UPDATE project_bible_versions/i)
  assert.doesNotMatch(src, /DELETE FROM project_bible_versions/i)
  assert.match(src, /UPDATE dramas SET current_bible_version_id = \?/)
  // 指针切换必须与版本行插入在同一事务（沿用 source_versions 骨架）
  assert.match(src, /beginTransaction|BEGIN/)
  assert.match(src, /FOR UPDATE/)
})

// ─── 4. 真实 MySQL：DDL、空态、版本不可变、乐观锁、跨项目隔离 ─────────────
test('真实 MySQL：项目圣经版本行不可变、指针切换、历史倒序与乐观锁 409', async (t) => {
  if (process.env.SOURCE_DB_TEST === '0' && !process.env.CI) {
    t.skip('显式无 MySQL 模式 SOURCE_DB_TEST=0')
    return
  }
  const { prepareIsolatedMySql } = await import('./fixtures/production-package/mysql-isolate.mjs')
  const isolated = await prepareIsolatedMySql('bible_test')
  if (!isolated.changed) {
    t.skip('未配置 MYSQL_HOST / DATABASE_URL，无法创建隔离库')
    return
  }
  const { pool } = await import('../src/db/index.ts')
  const { initMySqlSchema } = await import('../src/db/mysql-schema.ts')
  // prepareIsolatedMySql 已建表一次；再执行一次验证幂等（不重复补列）
  await initMySqlSchema(pool)

  try {
    // 4.1 列定义
    const [columns] = await pool.query(
      "SELECT COLUMN_NAME, COLUMN_TYPE, DATA_TYPE, IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'project_bible_versions'",
    )
    const colNames = new Map(columns.map((row) => [row.COLUMN_NAME, row]))
    for (const name of ['id', 'drama_id', 'source', 'outline_json', 'content_hash', 'created_at', 'updated_at']) {
      assert.ok(colNames.has(name), `project_bible_versions 缺少列 ${name}`)
    }
    assert.equal(colNames.get('outline_json').DATA_TYPE, 'longtext')
    assert.equal(colNames.get('content_hash').COLUMN_TYPE, 'varchar(64)')
    assert.equal(colNames.get('source').COLUMN_TYPE, 'varchar(32)')
    assert.equal(colNames.get('outline_json').IS_NULLABLE, 'NO')

    const [dramaCols] = await pool.query(
      "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dramas' AND COLUMN_NAME = 'current_bible_version_id'",
    )
    assert.equal(dramaCols.length, 1, 'dramas 缺少 current_bible_version_id 指针列')

    // 4.2 建两个项目（dramas 的 NOT NULL 列必须提供）
    const ts = new Date().toISOString()
    const insertDrama = async (title) => {
      const [result] = await pool.execute(
        'INSERT INTO dramas (title, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        [title, '正文', 'draft', ts, ts],
      )
      return Number(result.insertId)
    }
    const dramaId = await insertDrama('大纲测试项目')
    const otherDramaId = await insertDrama('另一个项目')

    // 4.3 空态：指针为 NULL
    const empty = await getProjectBible(dramaId, pool)
    assert.equal(empty.has_data, false)
    assert.equal(empty.bible, null)
    assert.equal(empty.version_id, null)

    // 4.4 首次保存（expected_version_id = null）
    const first = await saveProjectBible({
      dramaId,
      bible: { logline: '第一版', episodes: [{ episode_number: 1, objective: '目标一', hook: '钩子一' }] },
      expectedVersionId: null,
      connectionPool: pool,
    })
    assert.equal(first.has_data, true)
    assert.equal(first.bible.logline, '第一版')
    assert.equal(first.source, 'manual')
    const firstId = first.version_id
    assert.ok(Number.isInteger(firstId) && firstId > 0)

    const [pointerAfterFirst] = await pool.query('SELECT current_bible_version_id FROM dramas WHERE id = ?', [dramaId])
    assert.equal(Number(pointerAfterFirst[0].current_bible_version_id), firstId)

    // 4.5 第二次保存：新版本行 + 指针前移，第一行内容不变（不可变）
    const second = await saveProjectBible({
      dramaId,
      bible: { logline: '第二版' },
      expectedVersionId: firstId,
      connectionPool: pool,
    })
    assert.ok(second.version_id > firstId, '新版本 id 必须递增')
    assert.equal(second.bible.logline, '第二版')

    const [firstRow] = await pool.query('SELECT outline_json, content_hash FROM project_bible_versions WHERE id = ?', [firstId])
    assert.equal(JSON.parse(firstRow[0].outline_json).logline, '第一版', '旧版本行不得被覆盖')
    assert.equal(firstRow[0].content_hash, projectBibleHash(normalizeProjectBible({ logline: '第一版', episodes: [{ episode_number: 1, objective: '目标一', hook: '钩子一' }] })))

    // 4.6 历史倒序 + is_current
    const history = await listProjectBibleVersions(dramaId, pool)
    assert.equal(history.current_version_id, second.version_id)
    assert.equal(history.versions.length, 2)
    assert.equal(history.versions[0].version_id, second.version_id)
    assert.equal(history.versions[0].is_current, true)
    assert.equal(history.versions[1].version_id, firstId)
    assert.equal(history.versions[1].is_current, false)

    // 4.7 乐观锁：用过期的 expected_version_id 保存 → 冲突，且不产生新行
    await assert.rejects(
      () => saveProjectBible({
        dramaId,
        bible: { logline: '过期写入' },
        expectedVersionId: firstId,
        connectionPool: pool,
      }),
      (err) => err instanceof ProjectBibleConflict,
    )
    const [countRows] = await pool.query('SELECT COUNT(*) AS count FROM project_bible_versions WHERE drama_id = ?', [dramaId])
    assert.equal(Number(countRows[0].count), 2, '冲突写入不得留下版本行')

    // 4.7b 整版全空：拒绝且不产生版本行（避免「已确认但每项都是 —」且空态永久消失）
    await assert.rejects(
      () => saveProjectBible({ dramaId, bible: {}, expectedVersionId: second.version_id, connectionPool: pool }),
      /大纲内容不能全部为空/,
    )
    const [countAfterEmpty] = await pool.query('SELECT COUNT(*) AS count FROM project_bible_versions WHERE drama_id = ?', [dramaId])
    assert.equal(Number(countAfterEmpty[0].count), 2, '空版本不得落库')

    // 4.8 跨项目隔离：另一项目独立空态与历史
    const other = await saveProjectBible({
      dramaId: otherDramaId,
      bible: { logline: '另一个项目的大纲' },
      expectedVersionId: null,
      connectionPool: pool,
    })
    assert.equal(other.bible.logline, '另一个项目的大纲')
    const otherHistory = await listProjectBibleVersions(otherDramaId, pool)
    assert.equal(otherHistory.versions.length, 1)
    assert.equal(otherHistory.versions[0].version_id, other.version_id)

    // 4.9 不存在项目 → NotFound（读取与保存语义一致）
    await assert.rejects(() => getProjectBible(999_999_999, pool), (err) => err instanceof ProjectBibleNotFound)
    await assert.rejects(
      () => saveProjectBible({ dramaId: 999_999_999, bible: {}, expectedVersionId: null, connectionPool: pool }),
      (err) => err instanceof ProjectBibleNotFound,
    )
  } finally {
    await isolated.cleanup()
  }
})
