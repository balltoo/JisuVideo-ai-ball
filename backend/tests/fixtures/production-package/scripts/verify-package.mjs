#!/usr/bin/env node
/**
 * Issue #96 — 生产包 v0.1 复算命令
 *
 * 用法（从 backend/ 运行）：
 *   node tests/fixtures/production-package/scripts/verify-package.mjs              # 复算 fixture 正例
 *   node tests/fixtures/production-package/scripts/verify-package.mjs --check     # 与 manifest.mjs 真值比对
 *   node tests/fixtures/production-package/scripts/verify-package.mjs --all       # 含契约示例包对照
 *
 * 只读：不写业务数据、不创建临时包、不调用模型、不触达数据库。
 * 输出契约 §3.2 要求的三类指纹与逐文件 hash/字节数。
 */
import * as h from '../helpers.mjs'

const POSITIVE_ID = 'fixture-rain-lantern'
const CONTRACT_EXAMPLE = 'docs/examples/production-package-v0.1'

const args = new Set(process.argv.slice(2))
const doCheck = args.has('--check')
const doAll = args.has('--all')

const targets = [
  { label: '#96 fixture 正例', id: POSITIVE_ID, root: `${h.PACKAGES_DIR}/${POSITIVE_ID}` },
]
if (doAll) {
  targets.push({ label: '契约示例包（docs/examples）', id: 'contract-example', root: CONTRACT_EXAMPLE })
}

if (doCheck) {
  const { MANIFEST, SAMPLES } = await import('../manifest.mjs')
  const sample = SAMPLES[POSITIVE_ID]
  let exitCode = 0
  console.log(`manifest version: ${MANIFEST_VERSION()}  sample: ${POSITIVE_ID}`)
  for (const t of targets) {
    if (t.id !== POSITIVE_ID) {
      console.log(`\n=== ${t.label}（仅复算，无真值比对）===`)
      printPackage(t.root)
      continue
    }
    exitCode = runCheck(t, sample)
  }
  process.exit(exitCode)
}

for (const t of targets) {
  console.log(`\n=== ${t.label} ===`)
  printPackage(t.root)
}

function MANIFEST_VERSION() {
  return 'production-package-fixture/1.0.0'
}

function printPackage(root) {
  const p = h.readPackage(root)
  const declared = h.declaredPackageFingerprint(root)
  console.log(`package_fingerprint:            ${p.packageFingerprint}`)
  console.log(`validation_fingerprint:         ${p.validationFingerprint}`)
  console.log(`source_version_canonical_hash:  ${p.sourceVersionCanonicalHash}`)
  console.log(`source_version_canonical_hash_hex: ${p.sourceVersionCanonicalHashHex}`)
  console.log(`source_version_canonical_bytes:  ${p.sourceVersionCanonicalBytes.length} bytes`)
  console.log(`manifest_declared_package_fingerprint: ${declared ?? '<missing or invalid>'}`)
  console.log(`episodes: ${p.episodeContents.map((c) => `#${c.episodeNumber}`).join(', ')}`)
  for (const r of p.rows) {
    console.log(`${r.path.padEnd(22)} ${r.fileHash}  ${String(r.byteLength).padStart(5)} bytes`)
  }
}

function runCheck(target, expected) {
  const p = h.readPackage(target.root)
  const declared = h.declaredPackageFingerprint(target.root)
  let failures = 0

  const assertEq = (name, actual, want) => {
    const ok = actual === want
    if (!ok) failures += 1
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`)
    if (!ok) console.log(`      actual: ${actual}\n      want  : ${want}`)
  }

  assertEq('package_fingerprint', p.packageFingerprint, expected.packageFingerprint)
  assertEq('validation_fingerprint', p.validationFingerprint, expected.validationFingerprint)
  assertEq(
    'source_version_canonical_hash',
    p.sourceVersionCanonicalHash,
    expected.sourceVersionCanonicalHash,
  )
  assertEq(
    'source_version_canonical_bytes',
    p.sourceVersionCanonicalBytes.length,
    expected.sourceVersionCanonicalBytesLength,
  )
  assertEq('manifest 声明值 = package_fingerprint', declared, expected.packageFingerprint)

  for (const row of expected.files) {
    assertEq(`file_hash ${row.path}`, p.rows.find((r) => r.path === row.path)?.fileHash, row.fileHash)
    assertEq(
      `byte_length ${row.path}`,
      p.rows.find((r) => r.path === row.path)?.byteLength,
      row.byteLength,
    )
  }
  assertEq('文件数量', p.rows.length, expected.files.length)

  for (const c of expected.episodes) {
    const actual = p.episodeContents.find((x) => x.episodeNumber === c.episodeNumber)
    assertEq(`episode #${c.episodeNumber} content_hash`, h.sha256Display(actual?.content ?? Buffer.alloc(0)), c.contentHash)
    assertEq(`episode #${c.episodeNumber} content_bytes`, actual?.content.length, c.contentBytes)
    assertEq(`episode #${c.episodeNumber} content_chars`, actual?.content.toString('utf-8').length, c.contentChars)
  }

  console.log(failures === 0 ? '\nOK: 正例指纹与 manifest 真值一致' : `\n${failures} 项不一致`)
  return failures === 0 ? 0 : 1
}
