/**
 * Issue #80 / S1 baseline：S02 噪声网文 与 S03 长文 样本的确定性生成器
 *
 * 设计目标：
 * - 完全确定性：固定 seed（SYNTH_SEED = 20260907），任意次运行产生逐字节相同的文本文件与 ground-truth JSON。
 * - 人工预期与文本同源：噪声模块（章节水印 / 作者话 / 广告 / 垃圾行 / 连续重复段 / 分离重复段 /
 *   重复章节标题块 / 孤立同标题行）由本脚本显式插入，并在 ground-truth JSON 中按段落登记
 *   { kind, text }，供 #72 健康检查 / #73 clean / #75 分集一致性 直接定位断言。
 * - 文本自写与合成：首段为手写"种子正文"（保证语义可读），其余正文由词库模板确定性合成；
 *   全文不含任何第三方版权内容、隐私或密钥。
 *
 * S02 特征覆盖（对应契约 §7.3 S2）：
 *   章节号（第N章）、作者话、广告、水印、重复段（连续 ×2、分离 ×2、块级 ×1）、
 *   相同章节标题（第2章 标题重复：块级重复开头；第3章 孤立同题标题行一次）、
 *   首尾空白 / 段间空行 / 行尾空格（首部 2 空行、尾部 1 空行 + 纯空格行 + 1 空行）、垃圾行。
 *
 * 输出（相对本脚本目录）：
 *   ../sample-02-noise-webnovel.txt
 *   ../sample-03-long-form.txt
 *   ../ground-truth-sample-02.json
 *   ../ground-truth-sample-03.json
 *
 * 运行：cd backend/tests/fixtures/source-baseline/scripts && node generate-samples.mjs
 * 测试隔离：设置 SOURCE_BASELINE_OUT_DIR=<临时目录> 时只写入该目录，
 * 用于确定性校验，避免 npm test 改写受版本控制的 fixture。
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const SYNTH_SEED = 20260907
const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT = process.env.SOURCE_BASELINE_OUT_DIR
  ? resolve(process.env.SOURCE_BASELINE_OUT_DIR)
  : join(__dirname, '..')
mkdirSync(OUT, { recursive: true })

// ─── 确定性 PRNG（mulberry32） ──────────────────────────────────────────
function mulberry32(seed) {
  let a = seed >>> 0
  return function next() {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)]
}

// ─── 合成正文：词库 + 句型模板（每句固定消耗 rng 次数，保证确定性） ──────
const A = ['风', '潮', '雾', '雨', '霜', '浪', '光', '影']
const B = ['堤岸', '栈桥', '石阶', '巷口', '山道', '渡口', '屋脊', '灯塔', '桅杆', '码头']
const C = ['水珠', '灯影', '凉意', '尘屑', '绳结', '锈迹', '回音', '余温']
const D = ['漫', '涌', '漫开', '褪去', '聚拢', '下沉', '铺展', '散去']
const E = ['忽然', '依旧', '慢慢', '静静', '缓缓', '骤然', '始终', '恍惚']
const F = ['被揉皱的旧信纸', '一层薄薄的纱', '谁的叹息落在水面', '被卷起一角的夜色', '隔着一层毛玻璃的灯', '一扇许久无人敲的门']
const G = ['船', '灯', '钟', '网', '锚', '帆', '螺', '钥匙']
const H = ['远方的汽笛', '塔顶的光', '海面的褶皱', '檐下的风铃', '潮水的低语', '雾里的轮廓']

const SENTENCE = [
  (r) => `${pick(r, A)}顺着${pick(r, B)}${pick(r, D)}，${pick(r, B)}上的${pick(r, C)}被轻轻摇动。`,
  (r) => `${pick(r, E)}，${pick(r, H)}${pick(r, D)}，${pick(r, G)}碰撞出细碎的响。`,
  (r) => `${pick(r, H)}在远处若隐若现，${pick(r, B)}尽头像${pick(r, F)}。`,
  (r) => `他停下脚步，把${pick(r, G)}放回原处，${pick(r, B)}边的${pick(r, C)}仍带着${pick(r, A)}气。`,
  (r) => `天光${pick(r, D)}时，${pick(r, B)}上的${pick(r, H)}终于${pick(r, D)}了。`,
  (r) => `这一夜没有人说话，只有${pick(r, B)}间的${pick(r, C)}一颗一颗往下落。`,
  (r) => `${pick(r, E)}，${pick(r, H)}重新亮起来，像${pick(r, F)}，他几乎以为自己做了一场梦。`,
  (r) => `多年以后他才想起，那天${pick(r, B)}上的${pick(r, A)}与今天的并无不同，${pick(r, B)}却早已不是原来的样子。`,
  (r) => `${pick(r, E)}有${pick(r, G)}的声音传来，${pick(r, H)}被惊得${pick(r, D)}，露出${pick(r, B)}的轮廓。`,
  (r) => `老人没有回答，只是把视线落在${pick(r, B)}尽头，那里的${pick(r, H)}像${pick(r, F)}。`,
  (r) => `${pick(r, A)}停了，${pick(r, B)}上的${pick(r, C)}沿着${pick(r, D)}的痕迹聚成一小洼，映出塔顶的光。`,
  (r) => `他把那枚${pick(r, G)}收进衣袋，朝${pick(r, B)}走去；${pick(r, H)}在身后${pick(r, D)}，没人再提起。`,
]

/** 合成一段正文（5~7 句，约 90~140 字）。rng 调用次数与句数绑定，保证确定性。 */
function makeBody(rng) {
  const n = 5 + Math.floor(rng() * 3)
  const start = Math.floor(rng() * SENTENCE.length)
  const out = []
  for (let i = 0; i < n; i++) {
    out.push(SENTENCE[(start + i) % SENTENCE.length](rng))
  }
  return out.join('')
}

// ─── 段落 kind 约定 ──────────────────────────────────────────────────────
// heading 章节标题 | body 合成正文 | intro-hand 手写种子正文 | body-dup 块级重复正文
// watermark 水印 | author-note 作者话 | ad 广告 | garbage 垃圾行 | duplicate 重复段（非首次出现）
// 说明：duplicate/body-dup 的 text 与同文首次出现段逐字符一致，用于"保留首次 / 删除重复"断言。

// ─── S02 噪声模块与手写种子（常量，保证逐字符稳定） ──────────────────────
const W1 = '本站声明：本文由雾港文学网采集整理发布，仅供学习交流使用，禁止任何形式的转载与二次上传。'
const W2 = '雾港文学网 · 海量网文免费阅读，章节实时同步更新。'
const AD1 = '【小广告】追更《雾港的灯塔》的朋友不要错过作者新书《我把整座灯塔搬回了家》，站内连载中，求收藏求月票！'
const AD2 = '【推荐位】点击下方链接，畅读《老周守塔记》全集，VIP 会员首月免费。'
const AU1 = '作者的话：今天两更，求推荐票，大家的支持是我码字的动力，爱你们！'
const AU2 = '作者的话：最近身体不适更新慢了，抱歉。恢复之后尽量三更补上。'
const GB1 = '"#$%^&*()_+"'
const GB2 = '??????????……'

const INTRO = [
  '雾又起了。站在栈桥上往下看，水面的倒影像被揉皱的旧信纸，半天也平整不下来。我把背上的箱子换到另一只肩膀，朝码头上唯一亮着灯的那间屋子走去。',
  '屋里坐着一个穿深灰旧棉袄的老人，正对着一盏煤油灯擦一副圆框眼镜。见我来，他并不起身，只抬了抬眼皮：你就是新来的守塔人？我点点头。他把眼镜架上鼻梁，上下打量了我半天，说：比我预想的年轻。',
  '海上传来汽笛，隔着雾闷闷的，像有什么东西在很远的地方捶门。老人侧耳听了一会儿，忽然笑了：船进港了。今晚你睡我那屋，明天起，塔顶归你。',
]

// 连续重复段（搬运站复制粘贴造成；第 2 章末连续两段 + 第 4 章再出现一次）
const DUP_C = '老周说过，灯塔不是为了船而亮的，是为了人。这句话我记了很多年。后来我站在塔顶才明白，船有罗盘，可人心里的路没有；那盏灯照着的，从来不是海面，而是每一个在深夜里还醒着的人回家的方向。'
// 分离重复段（同一段落在文本中两处各出现一次）
const DUP_S = '值班室的墙上挂着一本泛黄的登记簿，最近一页写着三个字：风要变。字迹是新添的，墨还没干透。'

// ─── S03 章节骨架（长文 3~4 万字） ───────────────────────────────────────
const S03_HEADINGS = [
  '第1章 晨雾码头',
  '第2章 铁锚与藤壶',
  '第3章 涨潮之前',
  '第4章 半张海图',
  '第5章 雾中汽笛',
  '第6章 旧灯塔的灯',
  '尾声',
]
const S03_BODY_PER_CHAPTER = [34, 34, 36, 36, 38, 38, 12]

// ─── 生成主流程 ──────────────────────────────────────────────────────────
function buildSample02(seed) {
  const rng = mulberry32(seed)
  const paras = []
  const push = (kind, text) => paras.push({ kind, text })
  const bodyN = (n, sink) => {
    for (let i = 0; i < n; i++) {
      const t = makeBody(rng)
      push('body', t)
      if (sink) sink.push(t)
    }
  }
  // 第 2 章首次出现块的前两段，供块级重复复制
  const ch2Lead = []

  push('heading', '第1章 雾起')
  push('watermark', W1)
  INTRO.forEach((t) => push('intro-hand', t))
  bodyN(40)
  push('heading', '第2章 雨夜来客')
  bodyN(12, ch2Lead)
  push('author-note', AU1)
  // 块级重复：标题 + 前两段正文整体再粘贴一次
  push('heading', '第2章 雨夜来客')
  push('body-dup', ch2Lead[0])
  push('body-dup', ch2Lead[1])
  bodyN(26)
  push('author-note', AU2)
  // 连续重复段（两段完全同文）
  push('duplicate', DUP_C)
  push('duplicate', DUP_C)
  push('garbage', GB1)
  push('heading', '第3章 灯塔旧事')
  push('watermark', W2)
  bodyN(20)
  // 孤立同标题行：同章名二次出现、后续接不同正文（标题去重须按上下文区分）
  push('heading', '第3章 灯塔旧事')
  bodyN(10)
  // 分离重复：与第 1 章手写种子 intro[2] 同文
  push('duplicate', INTRO[2])
  push('ad', AD1)
  bodyN(10)
  push('heading', '第4章 潮声')
  bodyN(16)
  // 分离重复：与第 2 章末 DUP_C 同文（相隔远）
  push('duplicate', DUP_C)
  bodyN(18)
  push('author-note', AU1)
  push('heading', '尾声')
  bodyN(20)
  push('duplicate', DUP_S)
  push('duplicate', DUP_S)
  push('ad', AD2)
  push('garbage', GB2)

  // 段落一律以单个空行分隔（join('\n\n')）
  const text = paras.map((p) => p.text).join('\n\n')
  // 首部 2 空行；尾部「1 空行 + 纯空格行 + 1 空行」（首尾空白 / 行尾空白样本）
  const raw = '\n\n' + text + '\n\n   \n\n'
  return { paras, raw }
}

function buildSample03(seed) {
  const rng = mulberry32(seed)
  const paras = []
  const push = (kind, text) => paras.push({ kind, text })
  for (let c = 0; c < S03_HEADINGS.length; c++) {
    push('heading', S03_HEADINGS[c])
    for (let i = 0; i < S03_BODY_PER_CHAPTER[c]; i++) {
      push('body', makeBody(rng))
    }
  }
  const raw = paras.map((p) => p.text).join('\n\n') + '\n'
  return { paras, raw }
}

function blockHash(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function write(rel, content) {
  writeFileSync(join(OUT, rel), content, { encoding: 'utf8' })
}

function summarize(name, relRaw, paras, extra = {}) {
  const rawBuf = readFileSync(join(OUT, relRaw))
  const raw = rawBuf.toString('utf8')
  const fileSha256 = blockHash(rawBuf)
  const contentHash = blockHash(Buffer.from(String(raw || '').trim(), 'utf8'))
  const rawCharCount = raw.length
  const normalizedCharCount = String(raw).trim().length
  const line = { sample: name, fileSha256, contentHash, rawCharCount, normalizedCharCount, paraCount: paras.length, ...extra }
  console.log(JSON.stringify(line, null, 2))
  return line
}

// ─── 运行 ────────────────────────────────────────────────────────────────
const s02 = buildSample02(SYNTH_SEED)
write('sample-02-noise-webnovel.txt', s02.raw)
write('ground-truth-sample-02.json', JSON.stringify(s02.paras.map((p, i) => ({ index: i, ...p })), null, 1) + '\n')
const gt02 = readFileSync(join(OUT, 'ground-truth-sample-02.json'), 'utf8')

const s03 = buildSample03(SYNTH_SEED)
write('sample-03-long-form.txt', s03.raw)
write('ground-truth-sample-03.json', JSON.stringify(s03.paras.map((p, i) => ({ index: i, ...p })), null, 1) + '\n')

console.log('=== sample-02 ===')
summarize('s02-noise-webnovel', 'sample-02-noise-webnovel.txt', s02.paras, { gtSha256: blockHash(Buffer.from(gt02, 'utf8')) })
console.log('=== sample-03 ===')
summarize('s03-long-form', 'sample-03-long-form.txt', s03.paras)
console.log('OK: samples 02/03 generated deterministically from seed', SYNTH_SEED)
