import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db, getInsertId, schema } from '../db/index.js'
import { success, notFound, created, badRequest, now } from '../utils/response.js'
import { toSnakeCase } from '../utils/transform.js'
import { joinProviderUrl } from '../services/adapters/url.js'
import { invalidateAIConfigCache, isOfficialProvider, parseConfigTemperature } from '../services/ai.js'
import { redactUrl, logTaskError, logTaskProgress, logTaskSuccess } from '../utils/task-logger.js'
import { UnsafeEndpointError, safeFetch } from '../utils/endpoint-guard.js'

const app = new Hono()

/** 单次拉取最多返回的模型数（防超大列表拖垮设置页渲染） */
const MAX_MODELS = 200

/** 归一化 temperature 入参：null=未设置；合法值 0~2；非法抛错 */
function normalizeTemperature(v: any): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0 || n > 2) throw new Error('invalid temperature')
  return n
}

/** 密钥掩码占位符（保持 ASCII，避免前端与日志出现编码差异） */
const API_KEY_MASK = '********'

/**
 * 出参脱敏（Issue #127）：密钥一旦下发到浏览器，就会经 DevTools、截图、日志外泄。
 * 阈值取 20：更短的密钥即使只保留头尾，暴露比例也过高（13 位时 77%、20 位时 50%）。
 * 超过阈值后只保留前 6 位做粗辨认，不再保留尾号（同 provider 多 key 由 `name` 区分）；
 * 空密钥返回空串，前端据此判断"无密钥"。
 */
export function maskApiKey(key: unknown): string {
  const value = typeof key === 'string' ? key : ''
  if (!value) return ''
  if (value.length <= 20) return API_KEY_MASK
  return `${value.slice(0, 6)}${API_KEY_MASK}`
}

/** 响应中的掩码被原样回传时，不得当作新密钥写库（防御纵深，Issue #127 复核 P2-2）。 */
export function isMaskedApiKey(value: unknown): boolean {
  return typeof value === 'string' && value.includes(API_KEY_MASK)
}

/** 探针密钥解析：请求未携带明文（出参脱敏后前端拿不到）时回退库中已存密钥。 */
export function resolveProbeApiKey(provided: unknown, stored: unknown): string {
  const value = typeof provided === 'string' ? provided : ''
  if (value) return value
  return typeof stored === 'string' ? stored : ''
}

export type ProbeTarget = {
  serviceType: string
  provider: string
  baseUrl: string
  apiKey: string
  fromStoredConfig: boolean
}

/**
 * 解析探针 / 模型拉取的目标（Issue #127 复核 P0）。
 *
 * - 未传 `id`：完全使用请求参数（与既有行为一致）；
 * - 传了 `id`：密钥回退库中已存值，并且 **`base_url` / `provider` / `service_type` 一律取库中值**，
 *   忽略请求体。否则任何未鉴权调用方（`/ai-configs/*` 当前没有鉴权中间件）都能让服务端
 *   拿库中密钥去请求自己指定的地址，形成"不知道密钥也能取用密钥"的外泄原语。
 */
export async function resolveProbeTarget(body: any): Promise<ProbeTarget | null> {
  const probeId = Number(body.id)
  if (!Number.isFinite(probeId) || probeId <= 0) {
    return {
      serviceType: body.service_type,
      provider: body.provider,
      baseUrl: body.base_url,
      apiKey: typeof body.api_key === 'string' ? body.api_key : '',
      fromStoredConfig: false,
    }
  }
  const [row] = await db.select().from(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, probeId))
  if (!row) return null
  const rawProvided = typeof body.api_key === 'string' ? body.api_key : ''
  // 掩码被回传时视为"未提供"，避免把掩码当密钥去请求上游。
  const providedKey = isMaskedApiKey(rawProvided) ? '' : rawProvided
  return {
    serviceType: row.serviceType,
    provider: row.provider ?? '',
    baseUrl: row.baseUrl,
    apiKey: resolveProbeApiKey(providedKey, row.apiKey),
    fromStoredConfig: true,
  }
}

/** 响应预览 / 提示里若出现本次使用的密钥，一律替换为掩码（防御上游原样回显）。 */
function redactPreview(text: string, apiKey: string): string {
  const preview = text.slice(0, 240)
  return apiKey ? preview.replaceAll(apiKey, API_KEY_MASK) : preview
}

/** 把 settings JSON 中的 temperature 透出为顶层字段，便于前端直接读写；密钥一律脱敏。 */
function withParsedFields(r: any) {
  return {
    ...toSnakeCase(r),
    api_key: maskApiKey(r.apiKey),
    model: r.model ? JSON.parse(r.model) : [],
    temperature: parseConfigTemperature(r.settings),
  }
}

function bearerHeaders(apiKey?: string, withJson = false) {
  const headers: Record<string, string> = {}
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  if (withJson) headers['Content-Type'] = 'application/json'
  return headers
}

function geminiHeaders(apiKey?: string, withJson = false) {
  const headers: Record<string, string> = {}
  if (apiKey) {
    headers['x-goog-api-key'] = apiKey
  }
  if (withJson) headers['Content-Type'] = 'application/json'
  return headers
}

function buildProbe(serviceType: string, provider: string, baseUrl: string, model?: string, apiKey?: string) {
  const p = provider.toLowerCase()
  const m = model || ''

  if (p === 'gemini') {
    // 探针统一走 generateContent:文本运行时(AI SDK)走的就是它,官方与中转站都支持;
    // interactions 端点很多中转站未配置,探它会误报 500。
    // 用最小合法请求体而非空体——空体在部分中转站会触发上游认证失败的误报
    const modelName = m || 'gemini-3.1-pro-preview'
    const url = new URL(joinProviderUrl(baseUrl, '/v1beta', `/models/${modelName}:generateContent`))
    if (apiKey) url.searchParams.set('key', apiKey)
    return {
      method: 'POST',
      url: url.toString(),
      headers: geminiHeaders(apiKey, true),
      body: { contents: [{ parts: [{ text: 'hi' }] }] },
    }
  }

  if (p === 'openai') {
    return {
      method: 'GET',
      url: joinProviderUrl(baseUrl, '/v1', '/models'),
      headers: bearerHeaders(apiKey),
      body: undefined,
    }
  }

  if (p === 'volcengine') {
    const path = serviceType === 'video'
      ? '/contents/generations/tasks'
      : serviceType === 'text'
        ? '/chat/completions'
        : '/images/generations'
    return {
      method: 'POST',
      url: joinProviderUrl(baseUrl, '/api/v3', path),
      headers: bearerHeaders(apiKey, true),
      body: {},
    }
  }

  if (p === 'minimax') {
    // MiniMax 仅提供视频服务，空请求体探测鉴权/端点连通性
    return {
      method: 'POST',
      url: joinProviderUrl(baseUrl, '/v2', '/video_generation'),
      headers: bearerHeaders(apiKey, true),
      body: {},
    }
  }

  if (p === 'autodl') {
    // 用不存在的任务 ID 做无扣费鉴权探针：有效 Token 会到达任务查询层，
    // 缺失或无效 Token 返回 401；Authorization 不加 Bearer。
    return {
      method: 'GET',
      url: joinProviderUrl(baseUrl, '', '/api/v1/comfyui/comfyui_workflow/result/huobao-connection-probe'),
      headers: apiKey ? { Authorization: apiKey } : {},
      body: undefined,
    }
  }

  return {
    method: 'GET',
    url: joinProviderUrl(baseUrl, '', m ? `/${m}` : '/'),
    headers: bearerHeaders(apiKey),
    body: undefined,
  }
}

/** 模型拉取候选端点序列：按 provider 优先官方格式，中转站(openai 兼容)格式兜底 */
function buildModelProbes(provider: string, baseUrl: string, apiKey?: string) {
  const p = provider.toLowerCase()
  const probes: Array<{ method: string; url: string; headers: Record<string, string> }> = []
  const push = (requiredPrefix: string, path: string, headers: Record<string, string>) => {
    probes.push({ method: 'GET', url: joinProviderUrl(baseUrl, requiredPrefix, path), headers })
  }

  if (p === 'gemini') {
    // 官方：v1beta/models?key=；new-api 中转：/v1/models Bearer 兜底
    const url = new URL(joinProviderUrl(baseUrl, '/v1beta', '/models'))
    if (apiKey) url.searchParams.set('key', apiKey)
    probes.push({ method: 'GET', url: url.toString(), headers: {} })
    push('/v1', '/models', bearerHeaders(apiKey))
  } else if (p === 'volcengine') {
    // ark 官方：/api/v3/models；中转站：/v1/models 兜底
    push('/api/v3', '/models', bearerHeaders(apiKey))
    push('/v1', '/models', bearerHeaders(apiKey))
  } else if (p === 'minimax') {
    // MiniMax 官方：/v2/models；兜底 /v1/models
    push('/v2', '/models', bearerHeaders(apiKey))
    push('/v1', '/models', bearerHeaders(apiKey))
  } else {
    // openai 系（官方与 openai 兼容中转站）
    push('/v1', '/models', bearerHeaders(apiKey))
  }
  return probes
}

/** 兼容 openai(data[].id) 与 gemini(models[].name) 两种列表格式，name 去掉 models/ 前缀 */
function parseModelIds(text: string): string[] | null {
  try {
    const json = JSON.parse(text)
    const arr = Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : null
    if (!arr) return null
    const ids = arr
      .map((item: any) => String(item?.id ?? item?.name ?? '').replace(/^models\//, ''))
      .filter(Boolean)
    return ids.length ? ids : null
  } catch {
    return null
  }
}

// POST /ai-configs/models — 拉取该 Base URL 下可用的模型列表
app.post('/models', async (c) => {
  const body = await c.req.json()
  if (!body.service_type || !body.provider || !body.base_url) {
    return badRequest(c, 'service_type, provider and base_url are required')
  }
  // 同 /test：带 id 时地址/厂商/密钥取库中值，避免密钥被转发到请求方指定的地址（复核 P0）。
  const target = await resolveProbeTarget(body)
  if (!target) return notFound(c)
  if (!isOfficialProvider(target.serviceType, target.provider)) {
    return badRequest(c, 'Unsupported service_type/provider')
  }

  const provider = target.provider.toLowerCase()
  if (provider === 'autodl') {
    return success(c, { ok: true, models: [], source: 'fixed', message: 'AutoDL 为固定 ComfyUI 工作流模型，无需拉取' })
  }

  const probes = buildModelProbes(provider, target.baseUrl, target.apiKey)
  let lastError: string | null = null
  for (const probe of probes) {
    const probeUrl = redactUrl(probe.url)
    logTaskProgress('AIConfig', 'models-fetch-start', { provider, url: probeUrl })
    try {
      const { resp, body: text } = await safeFetch(probe.url, {
        method: probe.method,
        headers: probe.headers,
        signal: AbortSignal.timeout(10000),
      })
      if (resp.status === 401 || resp.status === 403) {
        logTaskError('AIConfig', 'models-fetch-unauthorized', { provider, status: resp.status, url: probeUrl })
        return success(c, { ok: false, models: [], source: probeUrl, message: 'API Key 无效或未填写' })
      }
      if (!resp.ok) {
        lastError = `HTTP ${resp.status}`
        continue
      }
      const parsed = parseModelIds(text)
      if (!parsed) {
        lastError = 'response format unexpected'
        continue
      }
      // 去重 + 数量上限
      const models = [...new Set(parsed)].slice(0, MAX_MODELS)
      if (!models.length) {
        lastError = 'empty model list'
        continue
      }
      logTaskSuccess('AIConfig', 'models-fetch-done', { provider, count: models.length, url: probeUrl })
      return success(c, { ok: true, models, source: probeUrl })
    } catch (error: any) {
      if (error instanceof UnsafeEndpointError) {
        logTaskError('AIConfig', 'models-fetch-blocked', { provider, url: probeUrl, reason: error.message })
        return success(c, { ok: false, models: [], source: probeUrl, message: '该地址被安全策略拒绝（不支持私网/本机地址）；如确需本地 AI 网关，请在后端设置 ALLOW_PRIVATE_AI_ENDPOINTS=true' })
      }
      lastError = error.message
      logTaskError('AIConfig', 'models-fetch-failed', { provider, url: probeUrl, error: error.message })
    }
  }
  logTaskError('AIConfig', 'models-fetch-none', { provider, error: lastError })
  return success(c, {
    ok: false,
    models: [],
    source: '',
    message: `无法从该 Base URL 拉取模型：${lastError || '未知错误'}`,
  })
})

// GET /ai-configs?service_type=text
app.get('/', async (c) => {
  const serviceType = c.req.query('service_type')
  let rows = await db.select().from(schema.aiServiceConfigs)
  if (serviceType) rows = rows.filter(r => r.serviceType === serviceType)

  const parsed = rows.map(withParsedFields)
  return success(c, parsed)
})

// POST /ai-configs
app.post('/', async (c) => {
  const body = await c.req.json()
  const ts = now()

  // 验证必填字段
  if (!body.service_type || !body.provider) {
    return badRequest(c, 'service_type and provider are required')
  }
  if (!isOfficialProvider(body.service_type, body.provider)) {
    return badRequest(c, 'Unsupported service_type/provider')
  }

  let temperature: number | null = null
  if ('temperature' in body) {
    try {
      temperature = normalizeTemperature(body.temperature)
    } catch {
      return badRequest(c, 'temperature must be a number between 0 and 2')
    }
  }

  const res = await db.insert(schema.aiServiceConfigs).values({
    serviceType: body.service_type,
    provider: body.provider,
    name: body.name || `${body.provider}-${body.service_type}`,
    baseUrl: body.base_url || '',
    apiKey: body.api_key || '',
    model: JSON.stringify(body.model || []),
    priority: body.priority || 0,
    isActive: true,
    settings: temperature !== null ? JSON.stringify({ temperature }) : null,
    createdAt: ts,
    updatedAt: ts,
  })

  const [row] = await db.select().from(schema.aiServiceConfigs)
    .where(eq(schema.aiServiceConfigs.id, getInsertId(res)))

  invalidateAIConfigCache()
  return created(c, withParsedFields(row))
})

// POST /ai-configs/test
app.post('/test', async (c) => {
  const body = await c.req.json()
  if (!body.service_type || !body.provider || !body.base_url) {
    return badRequest(c, 'service_type, provider and base_url are required')
  }
  if (!isOfficialProvider(body.service_type, body.provider)) {
    return badRequest(c, 'Unsupported service_type/provider')
  }

  // 出参已脱敏（Issue #127）：带 id 时地址/厂商/密钥一律取库中值，
  // 避免"未鉴权调用方让服务端拿库中密钥去请求任意地址"（复核 P0）。
  const target = await resolveProbeTarget(body)
  if (!target) return notFound(c)
  if (!isOfficialProvider(target.serviceType, target.provider)) {
    return badRequest(c, 'Unsupported service_type/provider')
  }

  const model = Array.isArray(body.model) ? body.model[0] : body.model
  const probe = buildProbe(target.serviceType, target.provider, target.baseUrl, model, target.apiKey)
  const probeUrl = redactUrl(probe.url)

  logTaskProgress('AIConfig', 'probe-start', {
    serviceType: body.service_type,
    provider: body.provider,
    method: probe.method,
    url: probeUrl,
  })

  try {
    const { resp, body: text } = await safeFetch(probe.url, {
      method: probe.method,
      headers: probe.headers,
      body: probe.body ? JSON.stringify(probe.body) : undefined,
    })
    const isAutoDL = body.provider.toLowerCase() === 'autodl'
    const reachable = [200, 204, 400, 401, 403, 404].includes(resp.status)
    const authenticated = !isAutoDL || ![401, 403].includes(resp.status)
    const verified = isAutoDL ? reachable && authenticated : resp.ok
    const payload = {
      ok: verified,
      reachable,
      status: resp.status,
      status_text: resp.statusText,
      method: probe.method,
      url: probeUrl,
      message: reachable
        ? (!authenticated
            ? 'AutoDL 端点可达，但 Token 无效或未填写'
            : (verified ? '端点可访问，认证与路径基本正常' : '端点已响应，请根据状态码判断认证或路径是否正确'))
        : '端点未按预期响应，请检查 Base URL 和代理前缀',
      response_preview: redactPreview(text, target.apiKey),
    }
    if (reachable) {
      logTaskSuccess('AIConfig', 'probe-done', {
        provider: body.provider,
        status: resp.status,
        url: probeUrl,
      })
    } else {
      logTaskError('AIConfig', 'probe-unexpected', {
        provider: body.provider,
        status: resp.status,
        url: probeUrl,
      })
    }
    return success(c, payload)
  } catch (error: any) {
    const message = error instanceof UnsafeEndpointError
      ? '该地址被安全策略拒绝（不支持私网/本机地址）；如确需本地 AI 网关，请在后端设置 ALLOW_PRIVATE_AI_ENDPOINTS=true'
      : (error.message || '请求失败')
    logTaskError('AIConfig', 'probe-failed', {
      provider: body.provider,
      url: probeUrl,
      error: error.message,
    })
    return success(c, {
      ok: false,
      reachable: false,
      method: probe.method,
      url: probeUrl,
      message,
      response_preview: '',
    })
  }
})

// GET /ai-configs/:id
app.get('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const [row] = await db.select().from(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, id))
  if (!row) return notFound(c)
  return success(c, withParsedFields(row))
})

// PUT /ai-configs/:id
app.put('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const [existing] = await db.select().from(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, id))
  if (!existing) return notFound(c)

  const serviceType = 'service_type' in body ? body.service_type : existing.serviceType
  const provider = 'provider' in body ? body.provider : existing.provider
  if (!isOfficialProvider(serviceType, provider)) {
    return badRequest(c, 'Unsupported service_type/provider')
  }

  const updates: Record<string, any> = { updatedAt: now() }

  if ('service_type' in body) updates.serviceType = body.service_type
  if ('provider' in body) updates.provider = body.provider
  if ('name' in body) updates.name = body.name
  if ('base_url' in body) updates.baseUrl = body.base_url
  if ('api_key' in body) {
    // 出参已脱敏（Issue #127），前端无法回填明文：空串/未提供 = 不修改；
    // 显式 null = 清空；把响应里的掩码原样回传也视为不修改（防御纵深）。
    const nextKey = body.api_key
    if (nextKey === null) updates.apiKey = ''
    else if (typeof nextKey === 'string' && nextKey !== '' && !isMaskedApiKey(nextKey)) updates.apiKey = nextKey
  }
  if ('model' in body) updates.model = JSON.stringify(body.model)
  if ('priority' in body) updates.priority = body.priority
  if ('is_active' in body) updates.isActive = body.is_active
  if ('temperature' in body) {
    let temperature: number | null
    try {
      temperature = normalizeTemperature(body.temperature)
    } catch {
      return badRequest(c, 'temperature must be a number between 0 and 2')
    }
    // 与已有 settings 合并，清空的 temperature 从 JSON 中移除
    let settings: Record<string, any> = {}
    try { settings = existing.settings ? JSON.parse(existing.settings) : {} } catch { settings = {} }
    if (temperature === null) delete settings.temperature
    else settings.temperature = temperature
    updates.settings = Object.keys(settings).length ? JSON.stringify(settings) : null
  }

  await db.update(schema.aiServiceConfigs).set(updates).where(eq(schema.aiServiceConfigs.id, id))
  invalidateAIConfigCache()
  return success(c)
})

// DELETE /ai-configs/:id
app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  await db.delete(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, id))
  invalidateAIConfigCache()
  return success(c)
})

// GET /ai-providers
export const aiProviders = new Hono()
aiProviders.get('/', async (c) => {
  const rows = await db.select().from(schema.aiServiceProviders)
  const parsed = rows.map(r => ({
    ...toSnakeCase(r),
    preset_models: r.presetModels ? JSON.parse(r.presetModels) : [],
  }))
  return success(c, parsed)
})

export default app
