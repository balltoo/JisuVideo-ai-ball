import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

// Issue #128 P1-1 回归守卫：script_rewriter 的两条硬约束必须常驻 SKILL.md，
// 且该 Skill 必须确实经 agents/skills.ts 注入到 script_rewriter 的提示词里——
// 否则「约束写进文档」只是摆设（试跑 §4.2 P1-1：EP01「上个月入职」被改写为「去年入职」、
// 「做了七年后台运营」整句消失）。
const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')
const skill = read('workspace/skills/script-rewriter/SKILL.md')
const agentSkills = read('src/agents/skills.ts')

test('SKILL.md 声明「硬约束」段落，并明确两条约束的标题语义', () => {
  assert.match(skill, /##\s*硬约束/)
  // 约束 1：相对时间原样保留 / 禁止换算或归一化
  assert.match(skill, /相对时间/)
  assert.match(skill, /原样保留/)
  assert.match(skill, /禁止/)
  // 约束 2：事实性数字 100% 保留 / 不得省略
  assert.match(skill, /事实性数字/)
  assert.match(skill, /100%\s*保留/)
  assert.match(skill, /不得省略/)
})

test('约束 1 覆盖相对时间词清单、四类禁止行为与正反例（含试跑原始失败样本）', () => {
  // 相对时间词清单：至少覆盖短剧高频锚点
  for (const word of ['上个月', '去年', '昨天', '刚才', '下周', '三年前']) {
    assert.ok(skill.includes(word), `相对时间词清单缺少「${word}」`)
  }
  // 四类禁止行为（换算绝对时间 / 归一化笼统说法 / 自行推断 / 同义替换）
  assert.match(skill, /换算为绝对时间或年龄/)
  assert.match(skill, /归一化为更笼统的说法/)
  assert.match(skill, /自行推断并改写时间关系/)
  assert.match(skill, /同义替换时间词/)
  // 正反例：必须同时出现正确输出与试跑观察到的错误输出（锁死「上个月 -> 去年」这一具体退化）
  assert.ok(skill.includes('她上个月才入职，二十六岁。'), '缺少正确例：上个月原样保留')
  assert.ok(skill.includes('她二十六岁，去年才入职。'), '缺少反例：上个月被换算为去年')
  assert.match(skill, /✅/)
  assert.match(skill, /❌/)
})

test('约束 2 覆盖事实数字类别与正反例（含试跑观察到的整句删除样本）', () => {
  for (const kind of ['年限', '工龄', '年龄', '金额', '数量', '比例', '名次']) {
    assert.ok(skill.includes(kind), `事实数字类别缺少「${kind}」`)
  }
  assert.match(skill, /禁止省略、合并、四舍五入、单位改写或替换为模糊表述/)
  assert.ok(skill.includes('他在这家公司做了七年后台运营。'), '缺少正确例：七年后台运营')
  assert.ok(skill.includes('他在公司做了很久后台运营。'), '缺少反例：七年工龄被模糊化')
  // 明确「整句删除事实句」同样违规——试跑里该句是完全消失，而不是被改写
  assert.match(skill, /整句删除事实句/)
})

test('改写后自检清单存在且覆盖时间词 / 数字 / 删除事实句三项', () => {
  assert.match(skill, /改写后自检/)
  assert.match(skill, /相对时间词/)
  assert.match(skill, /事实性数字/)
  assert.match(skill, /被整句删除的事实句/)
  // 缺项时不得提交（与 save_script 步骤绑定）
  assert.match(skill, /save_script/)
})

test('script_rewriter 确实加载 script-rewriter Skill（约束可到达模型，而非仅存文档）', () => {
  assert.match(agentSkills, /script_rewriter:\s*\['script-rewriter'\]/)
  assert.match(agentSkills, /export async function loadAgentSkills/)
})
