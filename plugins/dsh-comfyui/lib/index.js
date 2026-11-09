/**
 * dsh-comfyui - host half.
 *
 * Bridges the local ComfyUI HTTP API to the DSH web GUI.  Everything stays on
 * this machine: the browser half only talks to /api/dsh-comfyui routes, and
 * those routes refuse non-loopback callers.
 */
import { mkdir, readFile, writeFile, readdir, stat, access } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, extname, join, basename, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

export const name = 'comfyui'
export const inject = ['webServer']

const API = '/api/dsh-comfyui'
const MAX_BODY = 1024 * 1024
const DEFAULT_TIMEOUT_MS = 1000 * 60 * 10

const LORA_LABELS = {
  'wolrang_env_v1.safetensors': '寻神者地层lora（env）',
  'wolrang_ink_v1.safetensors': '寻神者墨线风角色lora（ink）',
}

const DEFAULTS = {
  baseUrl: 'http://127.0.0.1:8188',
  outputDir: join(homedir(), 'Pictures', 'DSH-ComfyUI'),
  checkpoint: 'Juggernaut-XL_v9_RunDiffusionPhoto_v2.safetensors',
  lora: '',
  loraStrength: 0.8,
  width: 1344,
  height: 768,
  steps: 28,
  cfg: 5.5,
  batch: 1,
  sampler: 'euler',
  scheduler: 'normal',
  autoStart: true,
  comfyDir: 'D:\\ComfyUI\\ComfyUI',
  pythonPath: 'D:\\ComfyUI\\Python312\\python.exe',
}

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

function configPath() {
  return join(dshHome(), 'dsh-comfyui', 'config.json')
}

function normalizeConfig(raw) {
  const out = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) }
  const baseUrl = typeof out.baseUrl === 'string' ? out.baseUrl.trim().replace(/\/+$/, '') : ''
  out.baseUrl = /^https?:\/\//i.test(baseUrl) ? baseUrl : DEFAULTS.baseUrl
  out.outputDir = typeof out.outputDir === 'string' && isAbsolute(out.outputDir.trim())
    ? out.outputDir.trim()
    : DEFAULTS.outputDir
  out.checkpoint = typeof out.checkpoint === 'string' ? out.checkpoint.trim() : DEFAULTS.checkpoint
  out.lora = typeof out.lora === 'string' ? out.lora.trim() : ''
  out.loraStrength = clampNumber(out.loraStrength, 0, 1.5, DEFAULTS.loraStrength)
  out.width = clampInt(out.width, 256, 2048, DEFAULTS.width)
  out.height = clampInt(out.height, 256, 2048, DEFAULTS.height)
  out.steps = clampInt(out.steps, 1, 80, DEFAULTS.steps)
  out.cfg = clampNumber(out.cfg, 0, 20, DEFAULTS.cfg)
  out.batch = clampInt(out.batch, 1, 4, DEFAULTS.batch)
  out.sampler = typeof out.sampler === 'string' && out.sampler.trim() !== '' ? out.sampler.trim() : DEFAULTS.sampler
  out.scheduler = typeof out.scheduler === 'string' && out.scheduler.trim() !== '' ? out.scheduler.trim() : DEFAULTS.scheduler
  out.autoStart = out.autoStart !== false
  out.comfyDir = typeof out.comfyDir === 'string' && isAbsolute(out.comfyDir.trim())
    ? out.comfyDir.trim()
    : DEFAULTS.comfyDir
  out.pythonPath = typeof out.pythonPath === 'string' && isAbsolute(out.pythonPath.trim())
    ? out.pythonPath.trim()
    : DEFAULTS.pythonPath
  return out
}

function clampInt(value, min, max, fallback) {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : fallback
}

function clampNumber(value, min, max, fallback) {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback
}

async function loadConfig() {
  try {
    return normalizeConfig(JSON.parse(await readFile(configPath(), 'utf8')))
  } catch {
    return { ...DEFAULTS }
  }
}

async function saveConfig(next) {
  const cfg = normalizeConfig(next)
  await mkdir(dirname(configPath()), { recursive: true })
  await mkdir(cfg.outputDir, { recursive: true })
  await writeFile(configPath(), JSON.stringify(cfg, null, 2), 'utf8')
  return cfg
}

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

async function fetchJson(url, options = {}, timeoutMs = 12000) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await response.text()
  let body
  try { body = text === '' ? {} : JSON.parse(text) } catch { body = { raw: text.slice(0, 2000) } }
  if (!response.ok) {
    const detail = body?.error?.message || body?.error || body?.message || text.slice(0, 400)
    throw new Error(`ComfyUI ${response.status}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
  }
  return body
}

async function comfyStatus(baseUrl) {
  const started = Date.now()
  const version = await fetchJson(`${baseUrl}/system_stats`, {}, 8000)
  let queue = null
  try { queue = await fetchJson(`${baseUrl}/queue`, {}, 8000) } catch { queue = null }
  return {
    online: true,
    baseUrl,
    version: version?.system?.comfyui_version || version?.system?.python_version || 'unknown',
    queue: queue === null ? null : {
      running: Array.isArray(queue.queue_running) ? queue.queue_running.length : 0,
      pending: Array.isArray(queue.queue_pending) ? queue.queue_pending.length : 0,
    },
    latencyMs: Date.now() - started,
  }
}

let comfyStartPromise = null

async function isComfyOnline(baseUrl) {
  try {
    await fetchJson(`${baseUrl}/system_stats`, {}, 2500)
    return true
  } catch {
    return false
  }
}

async function ensureComfyUI(cfg) {
  if (await isComfyOnline(cfg.baseUrl)) return
  if (cfg.autoStart === false) {
    throw new Error(`ComfyUI 未运行，且自动启动已关闭。请先启动 ${cfg.baseUrl}。`)
  }
  if (comfyStartPromise === null) {
    comfyStartPromise = (async () => {
      await access(cfg.pythonPath).catch(() => {
        throw new Error(`找不到 ComfyUI 的 Python：${cfg.pythonPath}。请在插件设置里修改 pythonPath。`)
      })
      await access(join(cfg.comfyDir, 'main.py')).catch(() => {
        throw new Error(`找不到 ComfyUI 主程序：${join(cfg.comfyDir, 'main.py')}。请在插件设置里修改 comfyDir。`)
      })
      const port = Number(new URL(cfg.baseUrl).port || 8188)
      const child = spawn(cfg.pythonPath, ['main.py', '--listen', '127.0.0.1', '--port', String(port)], {
        cwd: cfg.comfyDir,
        detached: true,
        windowsHide: true,
        stdio: 'ignore',
      })
      child.unref()
      const deadline = Date.now() + 90000
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 1000))
        if (await isComfyOnline(cfg.baseUrl)) return
      }
      throw new Error(`已尝试启动 ComfyUI（${cfg.comfyDir}），但 90 秒内未就绪。请查看终端输出或手动启动。`)
    })()
  }
  try {
    await comfyStartPromise
  } finally {
    comfyStartPromise = null
  }
}

function sizeOf(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(4096, Math.round(n / 8) * 8))
}

function buildWorkflow(cfg, request) {
  const checkpoint = String(request.checkpoint || cfg.checkpoint || '').trim()
  const lora = String(request.lora || cfg.lora || '').trim()
  const loraStrength = clampNumber(request.loraStrength ?? request.lora_strength ?? cfg.loraStrength, 0, 1.5, 0.8)
  if (checkpoint === '') throw new Error('还没有选择 checkpoint')
  const prompt = String(request.prompt || '').trim()
  if (prompt === '') throw new Error('提示词不能为空')
  const negative = String(request.negative || '').trim()
  const width = sizeOf(request.width || cfg.width)
  const height = sizeOf(request.height || cfg.height)
  const steps = clampInt(request.steps || cfg.steps, 1, 80, cfg.steps)
  const cfgScale = clampNumber(request.cfg || cfg.cfg, 0, 20, cfg.cfg)
  const batch = clampInt(request.batch || cfg.batch, 1, 4, cfg.batch)
  const seed = Number.isFinite(Number(request.seed)) && Number(request.seed) >= 0
    ? Math.floor(Number(request.seed))
    : Math.floor(Math.random() * 2147483647)
  const prefix = `DSH/${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`
  return {
    seed,
    width,
    height,
    batch,
    steps,
    cfg: cfgScale,
    checkpoint,
    lora,
    loraStrength,
    prompt: {
      '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: checkpoint } },
      '2': { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: lora ? ['8', 1] : ['1', 1] } },
      '3': { class_type: 'CLIPTextEncode', inputs: { text: negative, clip: lora ? ['8', 1] : ['1', 1] } },
      '4': { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: batch } },
      '5': {
        class_type: 'KSampler',
        inputs: {
          seed,
          steps,
          cfg: cfgScale,
          sampler_name: cfg.sampler,
          scheduler: cfg.scheduler,
          denoise: 1,
          model: lora ? ['8', 0] : ['1', 0],
          positive: ['2', 0],
          negative: ['3', 0],
          latent_image: ['4', 0],
        },
      },
      '6': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
      '7': { class_type: 'SaveImage', inputs: { filename_prefix: prefix, images: ['6', 0] } },
      ...(lora ? { '8': { class_type: 'LoraLoader', inputs: { model: ['1', 0], clip: ['1', 1], lora_name: lora, strength_model: loraStrength, strength_clip: loraStrength } } } : {}),
    },
  }
}

async function downloadImage(cfg, image) {
  const query = new URLSearchParams({
    filename: image.filename,
    subfolder: image.subfolder || '',
    type: image.type || 'output',
  })
  const response = await fetch(`${cfg.baseUrl}/view?${query.toString()}`, { signal: AbortSignal.timeout(60000) })
  if (!response.ok) throw new Error(`下载生成图失败：${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  const ext = ['.png', '.jpg', '.jpeg', '.webp'].includes(extname(image.filename).toLowerCase())
    ? extname(image.filename).toLowerCase()
    : '.png'
  const file = `comfy-${Date.now()}-${randomUUID().slice(0, 8)}${ext}`
  await mkdir(cfg.outputDir, { recursive: true })
  await writeFile(join(cfg.outputDir, file), bytes)
  return {
    name: file,
    url: `${API}/file/${encodeURIComponent(file)}`,
    bytes: bytes.length,
  }
}

async function runPrompt(cfg, request, timeoutMs) {
  const built = buildWorkflow(cfg, request)
  const clientId = randomUUID()
  const queued = await fetchJson(`${cfg.baseUrl}/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: built.prompt, client_id: clientId }),
  }, 15000)
  const promptId = queued?.prompt_id
  if (!promptId) throw new Error('ComfyUI 没有返回 prompt_id，可能工作流被拒绝')
  const started = Date.now()
  for (;;) {
    if (Date.now() - started > timeoutMs) throw new Error('生成超时，请检查 ComfyUI 队列')
    await new Promise(resolve => setTimeout(resolve, 1200))
    const history = await fetchJson(`${cfg.baseUrl}/history/${encodeURIComponent(promptId)}`, {}, 15000)
    const entry = history?.[promptId]
    if (!entry) continue
    if (entry.status?.status_str === 'error') {
      const messages = entry.status?.messages
      throw new Error(`ComfyUI 生成失败：${JSON.stringify(messages || entry.status).slice(0, 800)}`)
    }
    const outputs = entry.outputs && typeof entry.outputs === 'object' ? entry.outputs : {}
    const images = []
    for (const output of Object.values(outputs)) {
      for (const image of Array.isArray(output?.images) ? output.images : []) {
        if (typeof image?.filename !== 'string') continue
        images.push(await downloadImage(cfg, image))
      }
    }
    if (images.length === 0) throw new Error('ComfyUI 完成了任务，但没有返回图片')
    return {
      promptId,
      elapsedMs: Date.now() - started,
      images,
      seed: built.seed,
      width: built.width,
      height: built.height,
      batch: built.batch,
      checkpoint: built.checkpoint,
    lora: built.lora,
    }
  }
}

async function listLoras(baseUrl) {
  try {
    const info = await fetchJson(`${baseUrl}/object_info/LoraLoader`, {}, 12000)
    const required = info?.LoraLoader?.input?.required?.lora_name
    const list = Array.isArray(required?.[0]) ? required[0] : Array.isArray(required) ? required : []
    return list.filter(item => typeof item === 'string')
  } catch {
    return []
  }
}

async function listModels(baseUrl) {
  const info = await fetchJson(`${baseUrl}/object_info/CheckpointLoaderSimple`, {}, 12000)
  const required = info?.CheckpointLoaderSimple?.input?.required?.ckpt_name
  const list = Array.isArray(required?.[0]) ? required[0] : Array.isArray(required) ? required : []
  return list.filter(item => typeof item === 'string')
}

async function gallery(cfg, limit = 24) {
  await mkdir(cfg.outputDir, { recursive: true })
  const entries = await readdir(cfg.outputDir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (!/\.(png|jpe?g|webp)$/i.test(entry.name)) continue
    const info = await stat(join(cfg.outputDir, entry.name))
    files.push({ name: entry.name, mtime: info.mtimeMs, bytes: info.size })
  }
  files.sort((a, b) => b.mtime - a.mtime)
  return files.slice(0, Math.max(1, Math.min(100, limit))).map(file => ({
    name: file.name,
    mtime: file.mtime,
    bytes: file.bytes,
    url: `${API}/file/${encodeURIComponent(file.name)}`,
  }))
}

function contentType(file) {
  const ext = extname(file).toLowerCase()
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.webp') return 'image/webp'
  return 'image/png'
}

async function serveFile(res, outputDir, name) {
  const safe = basename(decodeURIComponent(name || ''))
  if (!/\.(png|jpe?g|webp)$/i.test(safe)) return sendError(res, 400, '只允许图片文件')
  const file = join(outputDir, safe)
  try {
    const info = await stat(file)
    if (!info.isFile()) throw new Error('not a file')
  } catch {
    return sendError(res, 404, '图片不存在')
  }
  res.writeHead(200, {
    'content-type': contentType(safe),
    'content-length': String((await stat(file)).size),
    'cache-control': 'public, max-age=31536000, immutable',
  })
  createReadStream(file).pipe(res)
}

async function openFolder(dir) {
  await mkdir(dir, { recursive: true })
  if (process.platform === 'win32') {
    spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref()
  } else if (process.platform === 'darwin') {
    spawn('open', [dir], { detached: true, stdio: 'ignore' }).unref()
  } else {
    spawn('xdg-open', [dir], { detached: true, stdio: 'ignore' }).unref()
  }
}

export function makeRoutes() {
  const guard = (req, res) => {
    if (isLoopback(req)) return true
    sendError(res, 403, '本地生图接口只接受本机访问', 'loopback-only')
    return false
  }

  return [
    {
      kind: 'exact',
      path: `${API}/config`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        if (req.method === 'GET') return sendJson(res, 200, { ok: true, config: await loadConfig() })
        if (req.method !== 'POST') return sendError(res, 405, '只支持 GET/POST')
        try {
          const body = await readJson(req)
          const cfg = await saveConfig({ ...(await loadConfig()), ...body })
          sendJson(res, 200, { ok: true, config: cfg })
        } catch (error) {
          sendError(res, 400, error instanceof Error ? error.message : String(error))
        }
      },
    },
    {
      kind: 'exact',
      path: `${API}/status`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        if (req.method !== 'GET') return sendError(res, 405, '只支持 GET')
        let baseUrl = 'ComfyUI'
        try {
          const cfg = await loadConfig()
          baseUrl = cfg.baseUrl
          await ensureComfyUI(cfg)
          sendJson(res, 200, { ok: true, ...(await comfyStatus(baseUrl)) })
        } catch (error) {
          sendJson(res, 200, {
            ok: false,
            online: false,
            message: `无法连接 ${baseUrl}：${error instanceof Error ? error.message : String(error)}`,
          })
        }
      },
    },
    {
      kind: 'exact',
      path: `${API}/models`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        try {
          const cfg = await loadConfig()
          await ensureComfyUI(cfg)
          const loras = await listLoras(cfg.baseUrl)
          const loraLabels = Object.fromEntries(loras.map((name) => [name, LORA_LABELS[name] || name]))
          sendJson(res, 200, { ok: true, checkpoints: await listModels(cfg.baseUrl), loras, loraLabels })
        } catch (error) {
          sendError(res, 502, error instanceof Error ? error.message : String(error), 'models-failed')
        }
      },
    },
    {
      kind: 'exact',
      path: `${API}/generate`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        if (req.method !== 'POST') return sendError(res, 405, '只支持 POST')
        try {
          const cfg = await loadConfig()
          await ensureComfyUI(cfg)
          const body = await readJson(req)
          const timeout = clampInt(body?.timeoutMs || DEFAULT_TIMEOUT_MS, 30000, 900000, DEFAULT_TIMEOUT_MS)
          const result = await runPrompt(cfg, body, timeout)
          sendJson(res, 200, { ok: true, ...result })
        } catch (error) {
          sendError(res, 502, error instanceof Error ? error.message : String(error), 'generate-failed')
        }
      },
    },
    {
      kind: 'exact',
      path: `${API}/gallery`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        try {
          const cfg = await loadConfig()
          const url = new URL(req.url || '/', 'http://localhost')
          const limit = clampInt(url.searchParams.get('limit') || 24, 1, 100, 24)
          sendJson(res, 200, { ok: true, images: await gallery(cfg, limit), outputDir: cfg.outputDir })
        } catch (error) {
          sendError(res, 400, error instanceof Error ? error.message : String(error))
        }
      },
    },
    {
      kind: 'exact',
      path: `${API}/cancel`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        if (req.method !== 'POST') return sendError(res, 405, '只支持 POST')
        try {
          const cfg = await loadConfig()
          await fetchJson(`${cfg.baseUrl}/interrupt`, { method: 'POST', body: '{}' }, 10000)
          sendJson(res, 200, { ok: true })
        } catch (error) {
          sendError(res, 502, error instanceof Error ? error.message : String(error))
        }
      },
    },
    {
      kind: 'exact',
      path: `${API}/open-folder`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        if (req.method !== 'POST') return sendError(res, 405, '只支持 POST')
        try {
          const cfg = await loadConfig()
          await openFolder(cfg.outputDir)
          sendJson(res, 200, { ok: true, outputDir: cfg.outputDir })
        } catch (error) {
          sendError(res, 500, error instanceof Error ? error.message : String(error))
        }
      },
    },
    {
      kind: 'prefix',
      path: `${API}/file`,
      handler: async (req, res) => {
        if (!guard(req, res)) return
        const cfg = await loadConfig()
        const name = (req.url || '').slice(`${API}/file/`.length).split('?')[0]
        await serveFile(res, cfg.outputDir, name)
      },
    },
  ]
}

const COMFY_IMAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    attachment_id: { type: 'string' },
    media_type: { type: 'string' },
    bytes: { type: 'integer' },
    width: { type: 'integer' },
    height: { type: 'integer' },
    name: { type: 'string' },
  },
  required: ['attachment_id', 'media_type', 'bytes', 'width', 'height'],
}

const COMFY_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    task_id: { type: 'string' },
    status: { type: 'string' },
    message: { type: 'string' },
    images: { type: 'array', items: COMFY_IMAGE_SCHEMA },
  },
  required: ['task_id', 'status', 'message', 'images'],
}

const COMFY_TOOL_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    prompt: { type: 'string', description: 'Detailed positive prompt describing the image.' },
    negative: { type: 'string', description: 'Negative prompt; defaults to a standard text/watermark/low-quality list.' },
    width: { type: 'integer', description: 'Image width, 256–2048, rounded to a multiple of 8.' },
    height: { type: 'integer', description: 'Image height, 256–2048, rounded to a multiple of 8.' },
    steps: { type: 'integer', description: 'Sampling steps, 1–80. Default 28.' },
    cfg: { type: 'number', description: 'CFG scale, 0–20. Default 5.5.' },
    batch: { type: 'integer', description: 'Batch size, 1–4. Default 1.' },
    checkpoint: { type: 'string', description: 'Checkpoint filename inside ComfyUI models/checkpoints. Omit to use the configured default.' },
    lora: { type: 'string', description: 'Optional LoRA filename inside ComfyUI models/loras. Omit for no LoRA.' },
    lora_strength: { type: 'number', description: 'LoRA strength, 0-1.5. Default 0.8.' },
    seed: { type: 'integer', description: 'Random seed; omit for a random seed.' },
  },
  required: ['prompt'],
}

function projectComfyImage(ref) {
  return {
    attachment_id: String(ref.attachmentId),
    media_type: ref.mediaType,
    bytes: ref.bytes,
    width: ref.width,
    height: ref.height,
    ...(ref.name === undefined ? {} : { name: ref.name }),
  }
}

function registerComfyTool(ctx) {
  return ctx.tools.register({
    name: 'generate_comfyui',
    description: 'Generate an image with the local ComfyUI/SDXL installation. Use this when the user asks for a local image, concept art, a game asset, or a background. ComfyUI is started automatically if it is not running. Generated images are saved in the configured output folder and returned as image attachments. Only works on this machine.',
    parameters: COMFY_TOOL_PARAMETERS,
    output: {
      schema: COMFY_RESULT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      presentationMeta: (_args, value) => ({ images: value.images }),
    },
    presentResult: (_args, result) => {
      const images = Array.isArray(result?.meta?.images) ? result.meta.images : []
      if (images.length === 0) return undefined
      return {
        card: 'generic',
        content: images.map(image => ({
          type: 'image',
          attachment: {
            attachmentId: image.attachment_id,
            mediaType: image.media_type,
            bytes: image.bytes,
            width: image.width,
            height: image.height,
            ...(image.name === undefined ? {} : { name: image.name }),
          },
        })),
      }
    },
    async execute(args) {
      const cfg = await loadConfig()
      await ensureComfyUI(cfg)
      const result = await runPrompt(cfg, args, cfg.timeoutMs || DEFAULT_TIMEOUT_MS)
      const files = await Promise.all(result.images.map(async image => ({
        data: await readFile(join(cfg.outputDir, image.name)),
        mediaType: 'image/png',
        name: image.name,
      })))
      const refs = await ctx.attachments.saveImages(files)
      const images = refs.map(projectComfyImage)
      return {
        task_id: result.promptId,
        status: 'completed',
        message: `已生成 ${images.length} 张图，保存在 ${cfg.outputDir}。`,
        images,
      }
    },
  })
}

export function apply(ctx) {
  const routes = makeRoutes()
  const disposers = routes.map(route => ctx.webServer.register(route))
  ctx.effect(() => () => {
    for (const dispose of disposers) dispose()
  }, 'dsh-comfyui: routes')

  ctx.inject(['tools', 'attachments'], (tctx) => {
    tctx.effect(() => {
      const disposeTool = registerComfyTool(tctx)
      return () => disposeTool()
    }, 'dsh-comfyui: agent tool')
  })
}
