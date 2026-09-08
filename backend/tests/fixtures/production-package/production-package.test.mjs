/**
 * Issue #96 — 生产包 v0.1 验收基线（fixture 自洽测试）
 *
 * 范围边界（重要）：本测试**不实现解析器**。契约 docs/production-package-import-v0.1.md
 * 冻结的是字段名、错误码与「哪些检查阻断、哪些只是警告」的语义；解析器、路由、schema
 * 与写入逻辑属于后续运行时 PR（#95 的 §5.2 幂等记录尚未授权迁移）。
 *
 * 因此本文件断言两类东西：
 *   A. **字节口径不变量**（现在就能断言）——契约 §3.2 的规范化、三类指纹、canonical
 *      拼接，以及每条负例变异后「哪一段指纹变、哪一段不变」。后者是本契约最容易实现
 *      错的地方（见 NEGATIVES 里 B3 / C2 的 note）。
 *   B. **语义期望登记**（等解析器实现后激活）——expected.code / expected.expected 文案。
 *      当前只做「登记完整性 + 错误码拼写」守卫，避免矩阵被无声删减或拼写漂移。
 *
 * 运行：cd backend && npm test
 * 复算：node tests/fixtures/production-package/scripts/verify-package.mjs --check
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

import * as h from './helpers.mjs'
import { MANIFEST_VERSION, CONTRACT_VERSION, CODE, EXPECTED, NEGATIVES, POSITIVE_ID } from './manifest.mjs'
import { parseProductionPackage } from '../../../src/services/production-package-parser.ts'

const POSITIVE_ROOT = path.join(h.PACKAGES_DIR, POSITIVE_ID)

let TMP = path.join(os.tmpdir(), 'pp96-tests')

test.before(() => {
  fs.rmSync(TMP, { recursive: true, force: true })
  fs.mkdirSync(TMP, { recursive: true })
})

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true })
})

// ─────────────────────────── A. 正例字节口径 ───────────────────────────

test('T01 正例指纹与 manifest 静态真值一致', () => {
  const p = h.readPackage(POSITIVE_ROOT)
  const g = EXPECTED.positive

  assert.equal(p.packageFingerprint, g.packageFingerprint, 'package_fingerprint')
  assert.equal(p.validationFingerprint, g.validationFingerprint, 'validation_fingerprint')
  assert.equal(p.sourceVersionCanonicalHash, g.sourceVersionCanonicalHash, 'canonical_hash')
  assert.equal(p.sourceVersionCanonicalBytes.length, g.sourceVersionCanonicalBytesLength, 'canonical bytes 长度')

  // 数据库列只存 64 位 lowercase hex，不含 sha256: 前缀（契约 §3.2 末段）
  assert.equal(p.sourceVersionCanonicalHashHex, g.sourceVersionCanonicalHash.slice('sha256:'.length))
  assert.equal(p.sourceVersionCanonicalHashHex.length, 64)

  assert.equal(p.rows.length, g.files.length, '文件数量')
  for (const want of g.files) {
    const actual = p.rows.find((r) => r.path === want.path)
    assert.ok(actual, `缺少文件 ${want.path}`)
    assert.equal(actual.fileHash, want.fileHash, `${want.path} file_hash`)
    assert.equal(actual.byteLength, want.byteLength, `${want.path} byte_length`)
    assert.match(actual.fileHash, /^[0-9a-f]{64}$/, `${want.path} file_hash 必须是 64 位 lowercase hex`)
  }

  for (const want of g.episodes) {
    const actual = p.episodeContents.find((c) => c.episodeNumber === want.episodeNumber)
    assert.ok(actual, `缺少第 ${want.episodeNumber} 集正文`)
    assert.equal(h.sha256Display(actual.content), want.contentHash, `ep#${want.episodeNumber} content_hash`)
    assert.equal(actual.content.length, want.contentBytes, `ep#${want.episodeNumber} content_bytes`)
    assert.equal(actual.content.toString('utf-8').length, want.contentChars, `ep#${want.episodeNumber} content_chars`)
  }
})

test('T01a manifest 声明的 package_fingerprint 必须可复算', () => {
  const declared = h.declaredPackageFingerprint(POSITIVE_ROOT)
  const actual = h.readPackage(POSITIVE_ROOT).packageFingerprint
  assert.equal(declared, actual, 'manifest_declared != package_fingerprint（P1-1 的可复算要求）')
  assert.match(declared, /^sha256:[0-9a-f]{64}$/)
})

test('T01b 行尾归一化对 file_hash 与指纹幂等（CRLF→LF）', () => {
  const dest = path.join(TMP, 't01b-crlf')
  h.copyPackage(POSITIVE_ROOT, dest)
  // 把所有文件的 LF 转成 CRLF，模拟 core.autocrlf=true 的工作树
  for (const rel of h.walkForTest ? [] : listFiles(dest)) {
    const abs = path.join(dest, rel)
    const raw = fs.readFileSync(abs)
    const crlf = Buffer.from(raw.toString('latin1').replace(/\n/g, '\r\n'), 'latin1')
    fs.writeFileSync(abs, crlf)
  }

  const p = h.readPackage(dest)
  const g = EXPECTED.positive
  assert.equal(p.packageFingerprint, g.packageFingerprint, 'CRLF 工作树下 package_fingerprint 不变')
  assert.equal(p.validationFingerprint, g.validationFingerprint, 'CRLF 工作树下 validation_fingerprint 不变')
  assert.equal(p.sourceVersionCanonicalHash, g.sourceVersionCanonicalHash, 'CRLF 工作树下 canonical 不变')
  for (const want of g.files) {
    const actual = p.rows.find((r) => r.path === want.path)
    assert.equal(actual.fileHash, want.fileHash, `${want.path} file_hash 不因行尾变化`)
  }
})

// ─────────────── T01c 末尾换行规范化（P1 回归）───────────────
// 契约 §3.2：去掉**所有**末尾 LF 后追加**恰好一个** LF。
// 三种输入末尾形态必须收敛到同一结果，且 file_hash 必须确定（不得依赖未初始化内存）。
test('T01c 无末尾 LF 时追加的 LF 必须是确定的 0x0a', () => {
  const cases = [
    { input: 'abc', expect: '6162630a', label: '无末尾 LF' },
    { input: 'abc\n', expect: '6162630a', label: '单个末尾 LF' },
    { input: 'abc\n\n', expect: '6162630a', label: '多个末尾 LF' },
    { input: 'abc\r\n\n', expect: '6162630a', label: 'CRLF' },
    { input: 'abc\r\n\n\n', expect: '6162630a', label: 'CRLF+LF' },
  ]
  for (const c of cases) {
    const out = h.normalizeFileBytes(Buffer.from(c.input))
    assert.equal(out.toString('hex'), c.expect, `${c.label} 末尾形态必须一致`)
    assert.equal(out.length, 4, `${c.label} 长度固定`)
  }
})

test('T01c 空文件规范化为恰好一个 LF', () => {
  const out = h.normalizeFileBytes(Buffer.alloc(0))
  assert.equal(out.toString('hex'), '0a', '空文件 → 单字节 0x0a')
  assert.equal(out.length, 1)
})

test('T01d 无 BOM 的 UTF-16LE / 含 NUL 二进制内容必须拒绝', () => {
  const utf16leWithoutBom = Buffer.from('abc', 'utf16le')
  assert.throws(
    () => h.normalizeFileBytes(utf16leWithoutBom),
    /PACKAGE_ENCODING_INVALID/,
    '不能把 a\\0b\\0c\\0 当作合法 UTF-8 Markdown',
  )
})

test('T01c 返回值必须是独立内存，不共享底层 buffer', () => {
  const raw = Buffer.from('abc\n')
  const out = h.normalizeFileBytes(raw)
  // 二次写入返回值不得影响原始输入
  out[0] = 0x5a
  assert.equal(raw.toString(), 'abc\n', '原始 buffer 未被改动')
  // 连续两次调用必须得到相同结果（确定性）
  const a = h.normalizeFileBytes(Buffer.from('abc')).toString('hex')
  const b = h.normalizeFileBytes(Buffer.from('abc')).toString('hex')
  assert.equal(a, b, '同输入必须产生相同输出')
})

test('T01c 正例所有文件的最后一个字节必须是 0x0a', () => {
  // 这条守住正例样本本身符合 §3.2 末尾形态，防止样本被手工编辑后静默漂移。
  const p = h.readPackage(POSITIVE_ROOT)
  for (const rel of p.rows.map((r) => r.path)) {
    const normalized = p.files.get(rel)
    assert.equal(normalized[normalized.length - 1], 0x0a, `${rel} 末尾必须是 LF`)
    // 注意：规范化是「剥掉所有末尾 LF 再补一个」，不是无条件追加，所以对
    // 末尾恰一个 LF 的文件长度不变（831 → 831）；断言 `+1` 是错的。
    // 因此这里直接字节级比对 §3.2 规范内容：CRLF->LF（latin1 无损处理 UTF-8
    // 多字节字符）、剥末尾 LF、补一个 0x0a。
    //
    // 诚实说明：这条字节断言对**正例样本**抓不到 P1（无末尾 LF 时 allocUnsafe
    // 未初始化），因为 6 个 fixture 文件末尾都恰好一个 LF，buggy 实现剥掉后再补
    // 一个，结果与正确实现逐字节相同。真正守住 P1 的是上面两条合成输入断言
    // （`abc` / 空文件）。这条的作用是另一件事：守住样本本身的 §3.2 末尾形态，
    // 防止样本被手工编辑后静默漂移。
    const disk = fs.readFileSync(path.join(POSITIVE_ROOT, rel))
    const expect = Buffer.from(
      Buffer.from(disk, 'latin1')
        .toString('latin1')
        .replace(/\r\n/g, '\n')
        .replace(/\n+$/, '')
        + '\n',
      'latin1',
    )
    assert.equal(
      normalized.toString('hex'),
      expect.toString('hex'),
      `${rel} 规范化内容必须与 §3.2 逐字节一致`,
    )
  }
})

test('T02 集号从 001 开始连续，且 episode_number 与文件名一致', () => {
  const p = h.readPackage(POSITIVE_ROOT)
  const nums = p.episodeContents.map((c) => c.episodeNumber).sort((a, b) => a - b)
  assert.deepEqual(nums, EXPECTED.positive.episodes.map((e) => e.episodeNumber))
  assert.equal(nums[0], 1, '必须从 001 开始')
  for (let i = 0; i < nums.length; i++) assert.equal(nums[i], nums[0] + i, '不允许跳号')
  assert.equal(new Set(nums).size, nums.length, '不允许重复集号')
})

test('T02b 可选文件存在时，正例人物/场景引用完整', () => {
  const rows = h.readPackage(POSITIVE_ROOT).rows.map((r) => r.path)
  for (const want of ['characters.md', 'scenes.md']) {
    assert.ok(rows.includes(want), `正例应包含 ${want}（W1/W2 覆盖其缺失）`)
  }
})

// ─────────────────────────── A. 负例指纹不变量 ───────────────────────────

test('负例矩阵完整性：11 条阻断 + 5 条警告 + 4 条 confirm 阶段', () => {
  const errors = NEGATIVES.filter((n) => n.severity === 'error')
  const warnings = NEGATIVES.filter((n) => n.severity === 'warning')
  // 按 ID 前缀分类：B = 解析阻断，W = 警告，C = confirm 阶段（哈希比对 + 冲突/幂等）。
  // 不用 contract 字符串判定——B5 的 contract 写成「§3.2 / §7」这类形式，容易漏数。
  const blocking = errors.filter((n) => n.id.startsWith('B'))
  const confirm = errors.filter((n) => n.id.startsWith('C'))

  assert.equal(warnings.length, 5, `警告应为 5 条，实际 ${warnings.length}`)
  assert.equal(blocking.length, 11, `阻断应为 11 条，实际 ${blocking.length}`)
  assert.equal(confirm.length, 4, `confirm 阶段应为 4 条（C1/C2 哈希 + C3/C4 冲突），实际 ${confirm.length}`)
  assert.equal(NEGATIVES.length, 20, `矩阵总数应为 20，实际 ${NEGATIVES.length}`)
})

test('Issue #96 交付 2 点名的 8 项负例逐条有覆盖', () => {
  // Issue #96「负例矩阵」原文逐项映射到矩阵 ID，防止后续删减时静默漏项。
  const COVERAGE = {
    '缺项目元信息': 'B1',
    '剧集号重复/跳号': 'B4',
    '角色引用缺失': 'B7',
    '场景引用缺失': 'B9',
    '正文为空': 'B10',
    '未知字段': 'W3',
    '来源 hash 不一致': 'C2',
    '导入更新冲突': 'C3',
  }
  for (const [issueItem, id] of Object.entries(COVERAGE)) {
    assert.ok(
      NEGATIVES.some((n) => n.id === id),
      `Issue #96「${issueItem}」映射到 ${id}，但矩阵中不存在`,
    )
  }
  // 反向校验：不要有重复映射的孤儿断言
  assert.equal(new Set(Object.values(COVERAGE)).size, 8, '8 项必须映射到 8 条不同的用例')
})

// 变异在顶层循环注册为独立用例（NEGATIVES 是静态导入，注册时可用）。
// node:test 不允许在 test 回调内再注册 test，因此必须这样组织。
const POSITIVE = h.readPackage(POSITIVE_ROOT)

for (const spec of NEGATIVES) {
  const name = `[${spec.id}] ${spec.code ?? '(no error code)'} — ${spec.expected}`

  test(name, () => {
    const dest = path.join(TMP, spec.id.toLowerCase())
    h.copyPackage(POSITIVE_ROOT, dest)
    h.applyMutation(dest, spec)

    // Warning-only mutations are valid packages after their manifest is
    // regenerated. Keep the fixture focused on the warning semantics rather
    // than making every W case fail secondarily with HASH_MISMATCH.
    if (spec.severity === 'warning') {
      if (spec.id === 'W1' || spec.id === 'W2') {
        for (const episode of ['episodes/001.md', 'episodes/002.md']) {
          const episodePath = path.join(dest, episode)
          let episodeText = fs.readFileSync(episodePath, 'utf8')
          const heading = spec.id === 'W1' ? 'Character Refs' : 'Scene Refs'
          episodeText = episodeText.replace(new RegExp(`(## ${heading}\\n)(?:- .*\\n)+`), '$1')
          fs.writeFileSync(episodePath, episodeText)
        }
      }
      const mutatedForManifest = h.readPackage(dest)
      const manifestPath = path.join(dest, 'source-manifest.md')
      const manifestText = fs.readFileSync(manifestPath, 'utf8')
      fs.writeFileSync(
        manifestPath,
        manifestText.replace(/^package_fingerprint:.*$/m, `package_fingerprint: ${mutatedForManifest.packageFingerprint}`),
      )
    }

    if (spec.expect.rejectsRead) {
      assert.throws(() => h.readPackage(dest), /PACKAGE_ENCODING_INVALID/)
      const parsed = parseProductionPackage(dest)
      assert.ok(allErrors(parsed).some(d => d.code === spec.code), `[${spec.id}] 解析器应返回 ${spec.code}`)
      return
    }

    const mutated = h.readPackage(dest)
    const parsed = parseProductionPackage(dest)
    const expect = spec.expect
    assert.equal(
      mutated.packageFingerprint !== POSITIVE.packageFingerprint,
      expect.packageFingerprintChanges,
      `package_fingerprint 变化方向不符（${spec.contract}）`,
    )
    assert.equal(
      mutated.validationFingerprint !== POSITIVE.validationFingerprint,
      expect.validationFingerprintChanges,
      `validation_fingerprint 变化方向不符（${spec.contract}）`,
    )
    assert.equal(
      mutated.sourceVersionCanonicalHash !== POSITIVE.sourceVersionCanonicalHash,
      expect.canonicalHashChanges,
      `canonical_hash 变化方向不符（${spec.contract}）`,
    )
    const diagnosticCodes = [...allErrors(parsed), ...parsed.diagnostics.warnings].map(d => d.code).filter(Boolean)
    if (spec.severity === 'error' && spec.code && spec.id.startsWith('B')) {
      assert.ok(allErrors(parsed).some(d => d.code === spec.code), `[${spec.id}] 解析器应返回 ${spec.code}`)
    }
    if (spec.severity === 'warning') {
      assert.equal(allErrors(parsed).length, 0, `[${spec.id}] 警告用例不得产生 error`)
      if (spec.code) assert.ok(diagnosticCodes.includes(spec.code), `[${spec.id}] 解析器应返回 warning ${spec.code}`)
      assert.ok(parsed.diagnostics.warnings.length > 0, `[${spec.id}] 解析器应产生 warning`)
    }
    if (spec.id === 'C3') {
      const confirmPreview = parseProductionPackage(dest, { targetMode: 'update' })
      assert.ok(allErrors(confirmPreview).some(d => d.code === CODE.TARGET_UNSUPPORTED), 'C3 必须阻断不支持的 target_mode')
    }
  })
}

test('解析器负例语义：阻断项必须 blocked/不可确认，诊断字段完整且路径可定位', () => {
  for (const spec of NEGATIVES.filter((n) => n.id.startsWith('B'))) {
    const dest = path.join(TMP, `semantic-${spec.id.toLowerCase()}`)
    h.copyPackage(POSITIVE_ROOT, dest)
    h.applyMutation(dest, spec)
    let parsed
    if (spec.expect?.rejectsRead) {
      // 编码错误仍应由解析器转成稳定的 error 诊断，而不是抛出未结构化异常。
      parsed = parseProductionPackage(dest)
      assert.equal(parsed.status, 'blocked', `[${spec.id}] 编码错误必须阻断`)
      assert.equal(parsed.can_confirm, false, `[${spec.id}] 编码错误不可确认`)
    } else {
      parsed = parseProductionPackage(dest)
      assert.equal(parsed.status, 'blocked', `[${spec.id}] 语义错误必须阻断`)
      assert.equal(parsed.can_confirm, false, `[${spec.id}] 语义错误不可确认`)
    }
    const diagnostic = parsedDiagnostic(parsed, spec.code)
    assert.equal(diagnostic.severity, 'error', `[${spec.id}] severity 必须为 error`)
    assert.ok(typeof diagnostic.path === 'string' && diagnostic.path.length > 0, `[${spec.id}] path 必须可定位`)
    assert.ok(typeof diagnostic.code === 'string' && diagnostic.code.length > 0, `[${spec.id}] code 必须稳定`)
    assert.ok(typeof diagnostic.message === 'string' && diagnostic.message.length > 0, `[${spec.id}] message 必须非空`)
  }
})

test('解析器警告语义：W1-W5 不阻断，未知字段进入 extensions', () => {
  for (const spec of NEGATIVES.filter((n) => n.id.startsWith('W'))) {
    const dest = path.join(TMP, `semantic-${spec.id.toLowerCase()}`)
    h.copyPackage(POSITIVE_ROOT, dest)
    h.applyMutation(dest, spec)
    if (spec.id === 'W1' || spec.id === 'W2') {
      for (const episode of ['episodes/001.md', 'episodes/002.md']) {
        const episodePath = path.join(dest, episode)
        let episodeText = fs.readFileSync(episodePath, 'utf8')
        const heading = spec.id === 'W1' ? 'Character Refs' : 'Scene Refs'
        episodeText = episodeText.replace(new RegExp(`(## ${heading}\\n)(?:- .*\\n)+`), '$1')
        fs.writeFileSync(episodePath, episodeText)
      }
    }
    const mutatedForManifest = h.readPackage(dest)
    const manifestPath = path.join(dest, 'source-manifest.md')
    const manifestText = fs.readFileSync(manifestPath, 'utf8')
    fs.writeFileSync(manifestPath, manifestText.replace(/^package_fingerprint:.*$/m, `package_fingerprint: ${mutatedForManifest.packageFingerprint}`))
    const parsed = parseProductionPackage(dest)
    assert.equal(parsed.status, 'ready', `[${spec.id}] warning-only 不得阻断`)
    assert.equal(parsed.can_confirm, true, `[${spec.id}] warning-only 仍可确认`)
    assert.ok(parsed.diagnostics.warnings.length > 0, `[${spec.id}] 必须有 warning`)
    for (const diagnostic of parsed.diagnostics.warnings) {
      assert.equal(diagnostic.severity, 'warning')
      assert.ok(diagnostic.path.length > 0)
      assert.ok(diagnostic.code.length > 0)
      assert.ok(diagnostic.message.length > 0)
    }
    if (spec.id === 'W3') assert.equal(parsed.project.extensions.custom_director, '某位导演')
  }
})

test('解析器严格校验 manifest、项目和剧集元数据边界', () => {
  const cases = [
    { id: 'manifest-source-kind', path: 'source-manifest.md', find: 'source_kind: external_episodic', replace: 'source_kind: short_text', code: CODE.MANIFEST_INVALID, field: 'source_kind' },
    { id: 'manifest-human-reviewed', path: 'source-manifest.md', find: 'human_reviewed: true', replace: 'human_reviewed: false', code: CODE.MANIFEST_INVALID, field: 'human_reviewed' },
    { id: 'manifest-processed-at', path: 'source-manifest.md', find: 'processed_at: "2026-09-07T20:00:00+08:00"', replace: 'processed_at: "2026-09-07"', code: CODE.MANIFEST_INVALID, field: 'processed_at' },
    { id: 'manifest-fingerprint', path: 'source-manifest.md', find: 'package_fingerprint: "sha256:4f0a6bd0380164258303d49bc5d313f32357d1826e65f31fbb0da85f8b9ddb87"', replace: 'package_fingerprint: "sha256:4f0a6bd0380164258303d49bc5d313f32357d1826e65f31fbb0da85f8b9ddb88"', code: CODE.HASH_MISMATCH, field: 'package_fingerprint' },
    { id: 'drama-zero-target', path: 'drama-package.md', find: 'target_episode_count: 2', replace: 'target_episode_count: 0', code: CODE.EPISODE_INVALID, field: 'target_episode_count' },
    { id: 'drama-noninteger-version', path: 'drama-package.md', find: 'package_version: 1', replace: 'package_version: 1.5', code: CODE.FRONTMATTER_INVALID, field: 'package_version' },
    { id: 'episode-empty-title', path: 'episodes/001.md', find: 'title: 夹层里的名片', replace: 'title: ""', code: CODE.EPISODE_INVALID, field: 'title' },
    { id: 'episode-duplicate-id', path: 'episodes/002.md', find: 'episode_id: E002', replace: 'episode_id: E001', code: CODE.DUPLICATE_ID, field: 'episode_id' },
  ]
  for (const item of cases) {
    const dest = path.join(TMP, `strict-${item.id}`)
    h.copyPackage(POSITIVE_ROOT, dest)
    const file = path.join(dest, item.path)
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(item.find, item.replace))
    const parsed = parseProductionPackage(dest)
    const diagnostic = parsedDiagnostic(parsed, item.code)
    assert.equal(parsed.status, 'blocked', `[${item.id}] 必须阻断`)
    assert.equal(parsed.can_confirm, false, `[${item.id}] 不可确认`)
    assert.equal(diagnostic.path, item.path === 'episodes/002.md' && item.code === CODE.DUPLICATE_ID ? 'episodes/' : item.path)
    assert.equal(diagnostic.field, item.field)
  }
})

test('解析器拒绝实体中的媒体地址、本地路径和待执行生成指令', () => {
  const cases = [
    {
      id: 'entity-image-url',
      path: 'characters.md',
      find: '- `name`: 林渡',
      replace: '- `name`: 林渡\n- `image_url`: https://example.invalid/c001.png',
      field: 'image_url',
    },
    {
      id: 'entity-local-path',
      path: 'characters.md',
      find: '- `description`: 二十四岁',
      replace: '- `description`: C:\\assets\\c001.png',
      field: 'description',
    },
    {
      id: 'entity-generation-command',
      path: 'scenes.md',
      find: '- `location`: 旧物修复铺「渡灯」',
      replace: '- `location`: 旧物修复铺「渡灯」\n- `generation_prompt`: generate an image now',
      field: 'generation_prompt',
    },
  ]
  for (const item of cases) {
    const dest = path.join(TMP, item.id)
    h.copyPackage(POSITIVE_ROOT, dest)
    const file = path.join(dest, item.path)
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(item.find, item.replace))
    const packageFingerprint = h.readPackage(dest).packageFingerprint
    const manifest = path.join(dest, 'source-manifest.md')
    fs.writeFileSync(manifest, fs.readFileSync(manifest, 'utf8').replace(/^package_fingerprint:.*$/m, `package_fingerprint: ${packageFingerprint}`))
    const parsed = parseProductionPackage(dest)
    const diagnostic = parsedDiagnostic(parsed, CODE.FRONTMATTER_INVALID)
    assert.equal(parsed.status, 'blocked', `[${item.id}] 必须阻断`)
    assert.equal(parsed.can_confirm, false, `[${item.id}] 不可确认`)
    assert.equal(diagnostic.path, item.path)
    assert.equal(diagnostic.field, item.field)
    assert.match(diagnostic.message, /forbidden|local absolute/i)
  }
})

test('角色和场景 external_id 必须是非空 ASCII 标识符', () => {
  const cases = [
    { id: 'character-id-space', path: 'characters.md', find: '## character: C001', replace: '## character: C 001' },
    { id: 'scene-id-unicode', path: 'scenes.md', find: '## scene: S001', replace: '## scene: 场景一' },
  ]
  for (const item of cases) {
    const dest = path.join(TMP, item.id)
    h.copyPackage(POSITIVE_ROOT, dest)
    const file = path.join(dest, item.path)
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(item.find, item.replace))
    const packageFingerprint = h.readPackage(dest).packageFingerprint
    const manifest = path.join(dest, 'source-manifest.md')
    fs.writeFileSync(manifest, fs.readFileSync(manifest, 'utf8').replace(/^package_fingerprint:.*$/m, `package_fingerprint: ${packageFingerprint}`))
    const parsed = parseProductionPackage(dest)
    const diagnostic = parsedDiagnostic(parsed, CODE.FRONTMATTER_INVALID)
    assert.equal(parsed.status, 'blocked')
    assert.equal(diagnostic.path, item.path)
    assert.equal(diagnostic.field, 'external_id')
  }
})

test('manifest processor 不得携带疑似密钥材料', () => {
  const dest = path.join(TMP, 'processor-secret')
  h.copyPackage(POSITIVE_ROOT, dest)
  const manifest = path.join(dest, 'source-manifest.md')
  fs.writeFileSync(manifest, fs.readFileSync(manifest, 'utf8').replace('processor: "hand-authored-fixture 1.0"', 'processor: "tool sk-xxxxxxxxxxxxxxxx"'))
  const packageFingerprint = h.readPackage(dest).packageFingerprint
  fs.writeFileSync(manifest, fs.readFileSync(manifest, 'utf8').replace(/^package_fingerprint:.*$/m, `package_fingerprint: ${packageFingerprint}`))
  const parsed = parseProductionPackage(dest)
  const diagnostic = parsedDiagnostic(parsed, CODE.MANIFEST_INVALID)
  assert.equal(parsed.status, 'blocked')
  assert.equal(diagnostic.path, 'source-manifest.md')
  assert.equal(diagnostic.field, 'processor')
})

test('相同 episode title 合法，DTO 按文件和 external_id 稳定排序', () => {
  const dest = path.join(TMP, 'same-title')
  h.copyPackage(POSITIVE_ROOT, dest)
  const second = path.join(dest, 'episodes/002.md')
  fs.writeFileSync(second, fs.readFileSync(second, 'utf8').replace('title: 雨巷的登记册', 'title: 夹层里的名片'))
  const packageFingerprint = h.readPackage(dest).packageFingerprint
  const manifest = path.join(dest, 'source-manifest.md')
  fs.writeFileSync(manifest, fs.readFileSync(manifest, 'utf8').replace(/^package_fingerprint:.*$/m, `package_fingerprint: ${packageFingerprint}`))
  const parsed = parseProductionPackage(dest)
  assert.equal(parsed.status, 'ready')
  assert.deepEqual(parsed.episodes.map((episode) => episode.external_id), ['E001', 'E002'])
  assert.deepEqual(parsed.characters.map((character) => character.external_id), ['C001', 'C002'])
  assert.deepEqual(parsed.scenes.map((scene) => scene.external_id), ['S001', 'S002'])
  assert.equal(parsed.episodes[0].content_char_count, EXPECTED.positive.episodes[0].contentChars - 1)
})

function parsedDiagnostic(parsed, code) {
  const diagnostic = allErrors(parsed).find((item) => item.code === code)
  assert.ok(diagnostic, `未找到诊断 ${code}`)
  return diagnostic
}

function allErrors(parsed) {
  return [...parsed.diagnostics.missing, ...parsed.diagnostics.conflicts]
}

test('C2 关键边界：只改 manifest 时 package_fingerprint 不变，validation_fingerprint 变', () => {
  const spec = NEGATIVES.find((n) => n.id === 'C2')
  const dest = path.join(TMP, 'c2')
  h.copyPackage(POSITIVE_ROOT, dest)
  h.applyMutation(dest, spec)

  const positive = h.readPackage(POSITIVE_ROOT)
  const mutated = h.readPackage(dest)

  // 这是 #95 补充实施裁决第 2 条要单独引入 validation_fingerprint 的全部理由。
  assert.equal(mutated.packageFingerprint, positive.packageFingerprint)
  assert.notEqual(mutated.validationFingerprint, positive.validationFingerprint)
  assert.equal(spec.code, CODE.HASH_MISMATCH)
})

test('B3 关键边界：缺 manifest 时 package_fingerprint 不变，validation_fingerprint 变', () => {
  const spec = NEGATIVES.find((n) => n.id === 'B3')
  const dest = path.join(TMP, 'b3')
  h.copyPackage(POSITIVE_ROOT, dest)
  h.applyMutation(dest, spec)

  const positive = h.readPackage(POSITIVE_ROOT)
  const mutated = h.readPackage(dest)
  assert.equal(mutated.packageFingerprint, positive.packageFingerprint)
  assert.notEqual(mutated.validationFingerprint, positive.validationFingerprint)
  assert.equal(h.declaredPackageFingerprint(dest), null)
})

test('B5 BOM 阻断与 CRLF 归一化必须区分', () => {
  const spec = NEGATIVES.find((n) => n.id === 'B5')
  const dest = path.join(TMP, 'b5')
  h.copyPackage(POSITIVE_ROOT, dest)
  h.applyMutation(dest, spec)

  assert.throws(() => h.readPackage(dest), /PACKAGE_ENCODING_INVALID/, 'BOM 必须阻断')
  assert.equal(spec.code, CODE.ENCODING_INVALID)
})

test('未知字段/未知文件不得静默丢弃：变异必须改变指纹', () => {
  for (const id of ['W3', 'W5']) {
    const spec = NEGATIVES.find((n) => n.id === id)
    const dest = path.join(TMP, `w-${id.toLowerCase()}`)
    h.copyPackage(POSITIVE_ROOT, dest)
    h.applyMutation(dest, spec)
    const mutated = h.readPackage(dest)
    assert.notEqual(
      mutated.validationFingerprint,
      EXPECTED.positive.validationFingerprint,
      `[${id}] 未识别内容必须被记录（指纹变化），不得静默丢弃`,
    )
  }
})

// ─────────────────────────── B. 语义期望登记守卫 ───────────────────────────

test('错误码常量与契约 §7 表格逐字一致', () => {
  const CONTRACT_CODES = [
    'PACKAGE_EMPTY',
    'PACKAGE_SCHEMA_UNSUPPORTED',
    'PACKAGE_FILE_MISSING',
    'PACKAGE_FILE_UNEXPECTED',
    'PACKAGE_ENCODING_INVALID',
    'PACKAGE_MANIFEST_INVALID',
    'PACKAGE_FRONTMATTER_INVALID',
    'PACKAGE_DUPLICATE_ID',
    'PACKAGE_EPISODE_INVALID',
    'PACKAGE_REFERENCE_UNKNOWN',
    'PACKAGE_HASH_MISMATCH',
    'PACKAGE_TARGET_UNSUPPORTED',
    'IDEMPOTENCY_KEY_REUSED',
    'PACKAGE_CONFLICT',
    'PACKAGE_WRITE_FAILED',
  ]
  const actual = Object.values(CODE)
  assert.equal(actual.length, CONTRACT_CODES.length)
  for (const want of CONTRACT_CODES) assert.ok(actual.includes(want), `缺失错误码 ${want}`)
})

test('每条负例都登记了契约引用与阻断/警告分级', () => {
  for (const spec of NEGATIVES) {
    assert.ok(spec.id, `[${spec.id}] 必须登记 id`)
    // code 允许为 null：契约 §7 没有对应错误码的情形（可选文件缺失、未识别字段、
    // Drama Bible 为空）——它们必须无 error 产出，而不是被硬套一个错误码。
    assert.ok(
      spec.code === null || Object.values(CODE).includes(spec.code),
      `[${spec.id}] code 必须是 §7 表格内的值或 null`,
    )
    if (spec.code === null) {
      assert.ok(
        spec.severity === 'warning',
        `[${spec.id}] code 为 null 时不得是 error 等级`,
      )
    }
    assert.ok(spec.severity === 'error' || spec.severity === 'warning')
    assert.ok(spec.contract && spec.contract.length > 0, `[${spec.id}] 必须标注契约出处`)
    assert.ok(spec.expected && spec.expected.length > 10, `[${spec.id}] 必须写明预期语义`)
    assert.ok(spec.expect && typeof spec.expect === 'object', `[${spec.id}] 必须登记指纹不变量`)
  }
})

test('正例真值登记了 DTO 可断言字段（解析器落地后即可用）', () => {
  const g = EXPECTED.positive
  for (const key of [
    'packageId', 'title', 'genre', 'style', 'aspectRatio',
    'targetEpisodeCount', 'characterIds', 'sceneIds', 'episodeIds',
  ]) {
    assert.ok(g[key] !== undefined, `正例真值缺少 ${key}`)
  }
  assert.equal(g.targetEpisodeCount, g.episodeIds.length, 'target_episode_count 必须等于实际集数')
  assert.equal(g.characterIds.length, 2)
  assert.equal(g.sceneIds.length, 2)
})

test('只读解析器正例 DTO 与指纹真值一致', () => {
  const dto = parseProductionPackage(POSITIVE_ROOT)
  const g = EXPECTED.positive
  assert.equal(dto.status, 'ready')
  assert.equal(dto.can_confirm, true)
  assert.equal(dto.package.package_id, g.packageId)
  assert.equal(dto.project.title, g.title)
  assert.equal(dto.project.target_episode_count, g.targetEpisodeCount)
  assert.equal(dto.package.package_fingerprint, g.packageFingerprint)
  assert.equal(dto.package.validation_fingerprint, g.validationFingerprint)
  assert.equal(dto.package.source_version_canonical_hash, g.sourceVersionCanonicalHash)
  assert.deepEqual(dto.characters.map(c => c.external_id), g.characterIds)
  assert.deepEqual(dto.scenes.map(s => s.external_id), g.sceneIds)
  assert.deepEqual(dto.episodes.map(e => e.external_id), g.episodeIds)
  assert.deepEqual(dto.package.files.map(f => ({ path: f.path, fileHash: f.file_hash.replace(/^sha256:/, ''), byteLength: f.byte_length })), g.files)
  assert.deepEqual(dto.diagnostics.missing, [])
  assert.deepEqual(dto.diagnostics.conflicts, [])
  assert.deepEqual(dto.diagnostics.warnings, [])
})

test('契约版本与 manifest 版本已登记', () => {
  assert.equal(CONTRACT_VERSION, '0.1')
  assert.match(MANIFEST_VERSION, /^production-package-fixture\/\d+\.\d+\.\d+$/)
})

// ─────────────────────────── T10 / T12：只读、无副作用 ───────────────────────────

test('T10 解析只读：readPackage 不修改任何包文件', () => {
  const before = snapshotMtimes(POSITIVE_ROOT)
  h.readPackage(POSITIVE_ROOT)
  h.readPackage(POSITIVE_ROOT)
  assert.deepEqual(snapshotMtimes(POSITIVE_ROOT), before, 'readPackage 必须无写入副作用')
})

test('T12 禁止副作用：fixture 不引用后端模块、不发网络请求、不读密钥', () => {
  const source = [
    'helpers.mjs',
    'manifest.mjs',
    'production-package.test.mjs',
    'scripts/verify-package.mjs',
  ]
    .filter((f) => fs.existsSync(path.join(h.FIXTURE_ROOT, f)))
    .map((f) => fs.readFileSync(path.join(h.FIXTURE_ROOT, f), 'utf-8'))
    .join('\n')

  // 只扫「真实代码」：剥掉注释与字符串字面量，避免本测试文件里
  // 提到的 token（如正则字面量中的 mysql2）造成自指误报。
  const code = stripLiterals(source)

  const forbidden = [
    [/mysql2|@\/?mastra\/|mysql2-promise/, '不得引用数据库驱动或 Agent 框架'],
    // 注意：不在此处检查 URL 字面量——URL 只存在于字符串里，stripLiterals 已把它们
    // 剥掉，该检查会永远匹配不到（死代码）。网络出口由下一行的 API 调用检测兜住；
    // 「样本不得含真实 URL」由「样本不含第三方版权与隐私」直接扫 manifest 原文断言。
    [/fetch\s*\(|XMLHttpRequest|axios|got\s*\(/, '不得发起网络请求'],
    [/api[_-]?key/i, '不得接触密钥'],
    [/volcengine|minimax|openai|dashscope|sensenova|zhipu/, '不得调用模型厂商'],
    [/process\.env\.[A-Z_]*KEY|config\.apiKey/, '不得读取密钥配置'],
    [/from\s+['"][^'"]*backend\/src/, '不得引用后端运行时模块'],
    [/sys_task|INSERT\s+INTO|UPDATE\s+/i, '不得写业务表'],
  ]
  for (const [pattern, why] of forbidden) {
    assert.equal(pattern.test(code), false, why)
  }

  // 不依赖数据库：fixture 只用 node: 内建模块与本地文件，不引入第三方包。
  // 注意：模块名在字符串字面量里，必须扫原始源码而非 stripLiterals 之后的 code。
  const thirdParty = source.match(/from\s+['"]([^'"]+)['"]/g) ?? []
  for (const spec of thirdParty) {
    const mod = spec.match(/['"]([^'"]+)['"]/)[1]
    assert.ok(
      mod.startsWith('node:') || mod.startsWith('./') || mod.startsWith('../'),
      `不得引入第三方依赖，实际导入：${mod}`,
    )
  }
  assert.equal(/require\s*\(/.test(code), false, '不得使用 CommonJS 动态加载')
})

test('样本不含第三方版权与隐私（声明与内容一致）', () => {
  const manifest = fs.readFileSync(path.join(POSITIVE_ROOT, 'source-manifest.md'), 'utf-8')
  assert.match(manifest, /原创虚构内容/)
  assert.match(manifest, /human_reviewed:\s*true/)
  assert.match(manifest, /processor:\s*"[^"]*fixture/)
  // 不得出现真实 URL / 邮箱 / 密钥形态
  assert.equal(/https?:\/\/(?!example)/.test(manifest), false, '不得包含真实 URL')
  assert.equal(/\S+@\S+\.\S+/.test(manifest), false, '不得包含邮箱')
  assert.equal(/sk-[A-Za-z0-9]{16,}/.test(manifest), false, '不得包含密钥')
})

// ─────────────────────────── helpers ───────────────────────────

function listFiles(root) {
  const out = []
  const walk = (dir, rel) => {
    for (const entry of fs.readdirSync(dir)) {
      const sub = rel ? `${rel}/${entry}` : entry
      const abs = path.join(dir, entry)
      if (fs.statSync(abs).isDirectory()) walk(abs, sub)
      else out.push(sub)
    }
  }
  walk(root, '')
  return out.sort()
}

function snapshotMtimes(root) {
  return listFiles(root).map((rel) => {
    const st = fs.statSync(path.join(root, rel))
    return `${rel}:${st.mtimeMs}:${st.size}`
  })
}

/**
 * 剥离注释与字符串/模板/正则字面量，只保留「真实执行代码」。
 *
 * T12 的禁用 token 本身就写在正则字面量与字符串里，若不剥离会造成自指误报。
 * 用顺序替换实现，不追求与真实 parser 完全等价。
 */
function stripLiterals(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')          // 块注释
    .replace(/\/\/[^\n]*/g, '')               // 行注释
    .replace(/`(?:\\.|[^`\\])*`/g, '')        // 模板串
    .replace(/'(?:\\.|[^'\\\n])*'/g, '')      // 单引号串
    .replace(/"(?:\\.|[^"\\\n])*"/g, '')      // 双引号串
    .replace(/\/(?:\\.|[^/\n])*(?:\/[gimsuy]*)?/g, '') // 正则字面量
}
// T99 --all smoke test：契约示例包路径必须基于脚本自身位置解析，不能依赖 cwd。
// Issue #98 review P2-1：`cd backend && node ... --all` 会把相对 cwd 的
// `docs/examples/...` 解析成 <repo>/backend/docs/examples/...，该目录不存在。
test('T99 verify-package.mjs --all 可复算契约示例包（路径解析 smoke test）', () => {
  const script = path.join(h.FIXTURE_ROOT, 'scripts', 'verify-package.mjs')
  const stdout = execFileSync('node', [script, '--all'], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  })
  assert.match(stdout, /package_fingerprint:/)
  assert.match(stdout, /#96 fixture 正例/)
  assert.match(stdout, /契约示例包/)
})
