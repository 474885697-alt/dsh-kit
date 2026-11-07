/**
 * dsh-prose-polish - host half.
 *
 * Bridges DSH's configured default model to a small, loopback-only polish
 * service.  The browser panel and the Agent tool both use the same prompt and
 * the same streaming path, so the result does not depend on which surface was
 * used.
 */
import { appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  MODES,
  STRENGTHS,
  buildPolishSystem,
  buildPolishUser,
  normalizePolishOutput,
  validatePolishRequest,
} from './craft.js'

export const name = 'prose-polish'
export const inject = ['webServer']

const API = '/api/dsh-prose-polish'
const MAX_BODY = 2 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 120000

function isLoopback(req) {
  const address = req.socket?.remoteAddress
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  })
  res.end(payload)
}

function sendError(res, status, message, code = 'error') {
  sendJson(res, status, { ok: false, code, message })
}

async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
}

async function resolveModel(ctx) {
  const settings = ctx.get?.('settings')
  if (!settings || typeof settings.describe !== 'function') {
    throw new Error('DSH 设置服务不可用')
  }
  let descriptors = []
  try {
    descriptors = await settings.describe({ redactSecrets: true })
  } catch {
    descriptors = []
  }
  if (!Array.isArray(descriptors)) descriptors = []
  const descriptor = descriptors.find((candidate) => String(candidate?.ns) === 'agent-default-model')
  const value = descriptor?.value && typeof descriptor.value === 'object' ? descriptor.value : {}
  const provider = typeof value.provider === 'string' ? value.provider.trim() : ''
  const model = typeof value.model === 'string' ? value.model.trim() : ''
  if (!provider || !model) {
    throw new Error('尚未配置默认模型；请先在 DSH「设置 → 模型」中选择一个模型')
  }
  return { provider, model }
}

function outputLimit(text, requested) {
  const wanted = Number.isFinite(Number(requested)) ? Number(requested) : Math.ceil(String(text).length * 1.15)
  return Math.min(8000, Math.max(900, Math.round(wanted)))
}

function chunkText(record) {
  if (!record || typeof record !== 'object') return ''
  if (record.type === 'text-delta' && typeof record.text === 'string') return record.text
  if (record.type === 'text-delta' && typeof record.delta === 'string') return record.delta
  return ''
}

async function streamPolish(ctx, options, onDelta, signal) {
  const { text, mode, strength, style, instruction } = validatePolishRequest(options)
  const { provider, model } = await resolveModel(ctx)
  const llm = ctx.get?.('llm')
  if (!llm || typeof llm.stream !== 'function') {
    throw new Error('宿主 LLM 服务不可用（ctx.llm 未注册）')
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS)
  const abortFromOutside = () => controller.abort()
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', abortFromOutside, { once: true })
  }

  let full = ''
  let sawDelta = false
  try {
    const stream = llm.stream({
      provider,
      model,
      messages: [{ role: 'user', content: [{ type: 'text', text: buildPolishUser({ text }) }] }],
      system: buildPolishSystem({ mode, strength, style, instruction }),
      temperature: mode === 'expand' ? 0.72 : 0.55,
      maxTokens: outputLimit(text, options.maxTokens),
      signal: controller.signal,
    })

    for await (const record of stream) {
      const delta = chunkText(record)
      if (delta) {
        sawDelta = true
        full += delta
        onDelta?.(delta)
        continue
      }
      if (record?.type === 'block-end' && record.block?.type === 'text' && !sawDelta) {
        const blockText = typeof record.block.text === 'string' ? record.block.text : ''
        if (blockText) {
          full += blockText
          onDelta?.(blockText)
        }
        continue
      }
      if (record?.type === 'finish') {
        const kind = record.reason?.kind
        if (kind && kind !== 'stop') {
          const failure = record.reason?.failure || {}
          throw new Error(failure.message || failure.code || `模型生成中断（${kind}）`)
        }
      }
      if (record?.type === 'error') {
        throw new Error(record.message || record.error?.message || '模型流式调用失败')
      }
    }
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', abortFromOutside)
  }

  const polished = normalizePolishOutput(full)
  if (!polished) throw new Error('模型没有返回内容')
  return { text: polished, provider, model }
}

function sseWrite(res, event, data) {
  if (res.writableEnded || res.destroyed) return
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

async function handleOptimize(ctx, req, res) {
  let body
  try {
    body = await readJson(req)
  } catch (error) {
    sendError(res, 400, error.message, 'bad-body')
    return
  }

  let options
  try {
    options = validatePolishRequest(body)
  } catch (error) {
    sendError(res, 400, error.message, 'bad-input')
    return
  }

  if (body.stream !== true) {
    try {
      const result = await streamPolish(ctx, options, null, null)
      sendJson(res, 200, { ok: true, ...result, mode: options.mode })
    } catch (error) {
      sendJson(res, 200, { ok: false, code: 'polish-failed', message: error.message })
    }
    return
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  res.flushHeaders?.()

  const controller = new AbortController()
  res.on('close', () => {
    if (!res.writableEnded) controller.abort()
  })

  sseWrite(res, 'start', { ok: true, mode: options.mode })
  try {
    const result = await streamPolish(ctx, options, (delta) => {
      sseWrite(res, 'delta', { text: delta })
    }, controller.signal)
    sseWrite(res, 'done', { ok: true, ...result, mode: options.mode })
  } catch (error) {
    sseWrite(res, 'error', { ok: false, message: error.message })
  } finally {
    if (!res.writableEnded) res.end()
  }
}

function makeRoutes(ctx) {
  return [
    {
      kind: 'exact',
      path: `${API}/config`,
      handler: async (req, res) => {
        if (!isLoopback(req)) return sendError(res, 403, '仅允许本机访问', 'forbidden')
        if (req.method !== 'GET') return sendError(res, 405, '不支持的请求方法', 'method')
        let model = null
        try {
          model = await resolveModel(ctx)
        } catch {
          // The panel still opens; the actual optimize call reports the fix.
        }
        sendJson(res, 200, {
          ok: true,
          provider: model?.provider || '',
          model: model?.model || '',
          maxChars: 32000,
          modes: Object.entries(MODES).map(([value, item]) => ({ value, label: item.label })),
          strengths: Object.entries(STRENGTHS).map(([value, item]) => ({ value, label: item.label })),
        })
      },
    },
    {
      kind: 'exact',
      path: `${API}/optimize`,
      handler: async (req, res) => {
        if (!isLoopback(req)) return sendError(res, 403, '仅允许本机访问', 'forbidden')
        if (req.method !== 'POST') return sendError(res, 405, '不支持的请求方法', 'method')
        await handleOptimize(ctx, req, res)
      },
    },
    {
      kind: 'exact',
      path: `${API}/diag`,
      handler: (req, res) => {
        if (!isLoopback(req)) return sendError(res, 403, '仅允许本机访问', 'forbidden')
        let body = ''
        req.on('data', (chunk) => {
          body += chunk
          if (body.length > 4096) req.destroy()
        })
        req.on('end', () => {
          try {
            const line = `${new Date().toISOString()} ${body.slice(0, 2000)}\n`
            appendFileSync(join(homedir(), '.dsh', 'prose-boot.log'), line, 'utf8')
          } catch {
            // diagnostics must never break the request
          }
          sendJson(res, 200, { ok: true })
        })
        req.on('error', () => {
          try {
            res.end()
          } catch {
            // ignore
          }
        })
      },
    },
    {
      kind: 'exact',
      path: `${API}/health`,
      handler: async (req, res) => {
        if (!isLoopback(req)) return sendError(res, 403, '仅允许本机访问', 'forbidden')
        let model = null
        try {
          model = await resolveModel(ctx)
        } catch {
          // health is still useful without a configured model
        }
        sendJson(res, 200, { ok: true, provider: model?.provider || '', model: model?.model || '' })
      },
    },
  ]
}

const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: { type: 'string' },
    provider: { type: 'string' },
    model: { type: 'string' },
    mode: { type: 'string' },
  },
  required: ['text', 'provider', 'model', 'mode'],
}

const TOOL_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: { type: 'string', description: '要润色的原文。保留原文事实和人物，只改表达。' },
    mode: {
      type: 'string',
      enum: Object.keys(MODES),
      description: '润色模式：novel 小说、tighten 收紧、expand 扩写、hook 开头与钩子、copy 通用文案。',
    },
    strength: {
      type: 'string',
      enum: Object.keys(STRENGTHS),
      description: '改写力度：light 轻、medium 中、deep 深。',
    },
    style: { type: 'string', description: '可选：文体/题材，例如“黑暗奇幻、第三人称限知”。' },
    instruction: { type: 'string', description: '可选：这次额外的修改要求。' },
    max_tokens: { type: 'integer', description: '可选：输出 token 上限，默认按原文长度估算。' },
  },
  required: ['text'],
}

function registerTool(ctx) {
  return ctx.tools.register({
    name: 'polish_text',
    description: '润色一段中文小说或文案。保留事实、人物和视角，按“具体动作/五感、长短句交替、对话潜台词、章末钩子”的规则改写；可指定收紧、扩写、强化开头或通用文案模式。只改表达，不新增剧情。',
    parameters: TOOL_PARAMETERS,
    output: {
      schema: RESULT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      const options = validatePolishRequest(args)
      const result = await streamPolish(ctx, options, null, null)
      return { ...result, mode: options.mode }
    },
  })
}

export function apply(ctx) {
  const routes = makeRoutes(ctx)
  const disposers = routes.map((route) => ctx.webServer.register(route))
  ctx.effect(() => () => {
    for (const dispose of disposers) dispose()
  }, 'dsh-prose-polish: routes')

  ctx.inject(['tools'], (tctx) => {
    tctx.effect(() => {
      const disposeTool = registerTool(tctx)
      return () => disposeTool()
    }, 'dsh-prose-polish: agent tool')
  })
}
