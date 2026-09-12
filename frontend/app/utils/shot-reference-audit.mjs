// 分镜参考图审计（Issue #128 P1-3）：把「参考图缺失」与「9 张上限丢弃」从隐式行为提为可断言纯函数。
//
// 背景：原 getShotReferenceIndexMap / getShotReferenceImages 直接以「有图才入表 + 前 9 张」筛素材，
// 一张素材图都没有时映射表为空，@名字 原样送进视频模型；超限素材被静默丢弃。UI 无任何提示，
// 用户只会看到「人物脸不一致」而无法归因。本模块把筛选结果显式化，供 UI 渲染警告，并作为
// 参考图实际取值的单一来源——episode.vue 的 getShotReferenceImages / getShotReferenceIndexMap
// 均改为消费本结果，保证「警告所指」与「实际送模型」永不分叉。
//
// 候选顺序（与既有实现一致）：场景 → 角色 → 道具 → 手动上传。
// 筛选规则（与既有实现一致）：按出现顺序去重（同 URL 只取一次）、总数不超过 limit（默认 9）。
//
// 输出：
//   included —— 实际进入参考图的素材（含手动上传），保持候选顺序；
//   used     —— 实际进入参考图的数量；
//   missing  —— 已绑定但没有图片的素材（视频一致性无法保证）；
//   dropped  —— 已绑定且有图片、但未进入参考图的素材（图片重复，或超出 limit）。
export function auditShotReferenceImages(candidates, options = {}) {
  const limit = Number(options?.limit) > 0 ? Math.floor(Number(options.limit)) : 9
  const list = (Array.isArray(candidates) ? candidates : []).map((asset, index) => ({
    key: asset?.key != null ? String(asset.key) : `#${index}`,
    type: asset?.type || '',
    name: asset?.name || '',
    // 空白 URL 视为无图（调用方通常已归一化，此处再兜一层，避免纯函数被脏输入绕过）
    imageUrl: String(asset?.imageUrl || '').trim(),
    manual: !!asset?.manual,
  }))

  const seen = new Set()
  const includedKeys = new Set()
  const included = []
  for (const asset of list) {
    if (!asset.imageUrl || seen.has(asset.imageUrl) || included.length >= limit) continue
    seen.add(asset.imageUrl)
    includedKeys.add(asset.key)
    included.push(asset)
  }

  const bound = list.filter(asset => !asset.manual)
  return {
    limit,
    used: included.length,
    included,
    missing: bound.filter(asset => !asset.imageUrl),
    dropped: bound.filter(asset => asset.imageUrl && !includedKeys.has(asset.key)),
  }
}

/** 素材名列表格式化：`名字（类型）`，供警告文案拼接 */
export function formatRefAssetNames(assets, separator = '、') {
  return (Array.isArray(assets) ? assets : [])
    .map(asset => `${asset?.name || '未命名'}（${asset?.type || '素材'}）`)
    .join(separator)
}

/**
 * 生成参考图警告文案（无问题时返回空数组）。
 * 分镜参考面板与视频检查器共用同一文案，避免两处提示口径不一致。
 */
export function buildShotReferenceWarnings(audit) {
  const missing = Array.isArray(audit?.missing) ? audit.missing : []
  const dropped = Array.isArray(audit?.dropped) ? audit.dropped : []
  const limit = Number(audit?.limit) > 0 ? Number(audit.limit) : 9
  const warnings = []
  if (missing.length) {
    warnings.push(`该分镜引用的以下素材尚未生成参考图：${formatRefAssetNames(missing)}。视频一致性无法保证，建议先在「资产」生成图片后再提交。`)
  }
  if (dropped.length) {
    warnings.push(`参考图上限 ${limit} 张（或图片重复）：以下已绑定素材未被纳入本次参考：${formatRefAssetNames(dropped)}。`)
  }
  return warnings
}
