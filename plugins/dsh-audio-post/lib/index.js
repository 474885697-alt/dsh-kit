/**
 * dsh-audio-post - ffmpeg based audio finishing.
 */
import { access, readdir, stat } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { basename, dirname, extname, join } from 'node:path'
import { homedir } from 'node:os'
import { promisify } from 'node:util'

export const name = 'audio-post'
export const inject = []

const API = '/api/dsh-audio-post'
const runAsync = promisify(execFile)
const AUDIO_EXT = new Set(['.mp3', '.wav', '.m4a', '.flac', '.ogg', '.opus', '.aac'])

const PRESETS = {
  'game-sfx': {
    description: '游戏音效：裁掉首尾静音，响度 -16 LUFS，峰值 -1.5 dBTP，mp3 44.1k/192k。',
    format: 'mp3', sampleRate: 44100, bitrate: '192k',
    filter: 'silenceremove=start_periods=1:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse,loudnorm=I=-16:TP=-1.5:LRA=11',
  },
  'netease-ai-music': {
    description: '音乐平台上传：响度 -14 LUFS，mp3 44.1k/320k。',
    format: 'mp3', sampleRate: 44100, bitrate: '320k',
    filter: 'loudnorm=I=-14:TP=-1.0:LRA=11',
  },
  'voice-clean': {
    description: '旁白/配音：高通 80Hz、降噪、响度 -16 LUFS，mp3 44.1k/128k。',
    format: 'mp3', sampleRate: 44100, bitrate: '128k',
    filter: 'highpass=f=80,afftdn=nf=-25,loudnorm=I=-16:TP=-1.5:LRA=11',
  },
  'voice-loud': {
    description: '提示音/短语音：只做响度与峰值控制，不裁静音，mp3 44.1k/192k。',
    format: 'mp3', sampleRate: 44100, bitrate: '192k',
    filter: 'loudnorm=I=-14:TP=-1.0:LRA=9',
  },
}

function dshHome() { return process.env.DSH_HOME || join(homedir(), '.dsh') }

async function exists(p) { try { await access(p); return true } catch { return false } }

async function toolPath(name) {
  if (process.env.DSH_FFMPEG && name === 'ffmpeg') return process.env.DSH_FFMPEG
  const local = join(dshHome(), 'tools', 'ffmpeg', name + (process.platform === 'win32' ? '.exe' : ''))
  if (await exists(local)) return local
  return name
}

async function run(name, args, timeout) {
  const bin = await toolPath(name)
  try {
    const { stdout, stderr } = await runAsync(bin, args, { timeout: timeout || 120000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 })
    return { ok: true, out: String(stdout || ''), err: String(stderr || '') }
  } catch (error) {
    const err = String((error && (error.stderr || error.message)) || error)
    return { ok: false, err: err.slice(-1500) }
  }
}

export async function audioInfo(input) {
  if (!input) throw new Error('需要 input 路径')
  const result = await run('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', input])
  if (!result.ok) return { ok: false, error: result.err }
  const data = JSON.parse(result.out)
  const stream = (data.streams || []).find((s) => s.codec_type === 'audio') || {}
  const format = data.format || {}
  return {
    ok: true,
    path: input,
    duration: Number(format.duration || stream.duration || 0),
    bitrate: Number(format.bit_rate || 0),
    sampleRate: Number(stream.sample_rate || 0),
    channels: Number(stream.channels || 0),
    codec: stream.codec_name || '',
    format: format.format_name || '',
  }
}

function outputFor(input, format) {
  const ext = '.' + (format || 'mp3')
  const dir = dirname(input)
  const stem = basename(input, extname(input))
  const direct = join(dir, stem + ext)
  // 同格式输入不要覆盖原文件（ffmpeg 会直接拒绝 "Output ... same as Input"）。
  if (direct === input) return join(dir, stem + '.post' + ext)
  return direct
}

function codecArgs(format, bitrate, sampleRate) {
  const args = []
  if (format === 'wav') args.push('-codec:a', 'pcm_s16le')
  else if (format === 'm4a') args.push('-codec:a', 'aac', '-b:a', bitrate || '192k')
  else args.push('-codec:a', 'libmp3lame', '-b:a', bitrate || '192k')
  if (sampleRate) args.push('-ar', String(sampleRate))
  return args
}

export async function convert(input, output, options) {
  const opts = options || {}
  if (!input) throw new Error('需要 input 路径')
  if (!(await exists(input))) throw new Error('文件不存在：' + input)
  const format = opts.format || extname(input).slice(1) || 'mp3'
  const target = output || outputFor(input, format)
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', input]
  if (opts.filter) args.push('-af', opts.filter)
  args.push(...codecArgs(format, opts.bitrate, opts.sampleRate), target)
  const result = await run('ffmpeg', args)
  if (!result.ok) return { ok: false, error: result.err }
  const info = await audioInfo(target)
  return { ok: true, output: target, info }
}

export async function preset(input, presetName, output) {
  const preset = PRESETS[presetName]
  if (!preset) throw new Error('未知预设：' + presetName + '（可用：' + Object.keys(PRESETS).join(', ') + '）')
  return convert(input, output, preset)
}

export async function batch(dir, presetName, options) {
  const presetSpec = PRESETS[presetName]
  if (!presetSpec) throw new Error('未知预设：' + presetName)
  let names = []
  try { names = await readdir(dir) } catch { throw new Error('目录不可读：' + dir) }
  const files = []
  for (const name of names) {
    if (!AUDIO_EXT.has(extname(name).toLowerCase())) continue
    if (/\.post\.[a-z0-9]+$/i.test(name)) continue
    const full = join(dir, name)
    const st = await stat(full)
    if (st.isFile()) files.push(full)
  }
  if (options && options.limit) files.length = Math.min(files.length, options.limit)
  const results = []
  for (const file of files) {
    const out = await convert(file, null, presetSpec)
    results.push({ input: file, ok: out.ok, output: out.output || '', error: out.error || '' })
  }
  return { ok: results.every((r) => r.ok), count: results.length, results }
}

function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

function makeRoutes() {
  return [
    {
      kind: 'exact',
      path: API + '/recipes',
      handler: async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' })
        sendJson(res, 200, { ok: true, presets: Object.fromEntries(Object.entries(PRESETS).map(([k, v]) => [k, v.description])) })
      },
    },
    {
      kind: 'exact',
      path: API + '/info',
      handler: async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' })
        const url = new URL(req.url || '/', 'http://localhost')
        try { sendJson(res, 200, await audioInfo(url.searchParams.get('path') || '')) } catch (error) { sendJson(res, 400, { ok: false, error: String(error.message || error) }) }
      },
    },
  ]
}

const OUT = { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] }

function registerTools(ctx) {
  const tools = [
    {
      name: 'audio_info',
      description: 'Inspect an audio file (duration, bitrate, sample rate, channels, codec).',
      parameters: { type: 'object', additionalProperties: false, properties: { path: { type: 'string' } }, required: ['path'] },
      async execute(args) { return JSON.stringify(await audioInfo(args.path), null, 2) },
    },
    {
      name: 'audio_convert',
      description: 'Convert audio to mp3/wav/m4a with optional sample rate and bitrate.',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          input: { type: 'string' }, output: { type: 'string' },
          format: { type: 'string', enum: ['mp3', 'wav', 'm4a'] },
          sample_rate: { type: 'integer' }, bitrate: { type: 'string' },
        },
        required: ['input'],
      },
      async execute(args) {
        return JSON.stringify(await convert(args.input, args.output, { format: args.format, sampleRate: args.sample_rate, bitrate: args.bitrate }), null, 2)
      },
    },
    {
      name: 'audio_preset',
      description: 'Apply a finishing preset: game-sfx, netease-ai-music, voice-clean or voice-loud.',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: { input: { type: 'string' }, preset: { type: 'string', enum: Object.keys(PRESETS) }, output: { type: 'string' } },
        required: ['input', 'preset'],
      },
      async execute(args) { return JSON.stringify(await preset(args.input, args.preset, args.output), null, 2) },
    },
    {
      name: 'audio_batch',
      description: 'Apply a preset to every audio file in a directory.',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: { dir: { type: 'string' }, preset: { type: 'string', enum: Object.keys(PRESETS) } },
        required: ['dir', 'preset'],
      },
      async execute(args) { return JSON.stringify(await batch(args.dir, args.preset), null, 2) },
    },
  ]
  const disposers = tools.map((tool) => ctx.tools.register({ ...tool, output: OUT }))
  return () => { for (const d of disposers) d() }
}

export function apply(ctx) {
  ctx.inject(['webServer'], (scope) => {
    scope.effect(() => {
      const disposers = makeRoutes().map((route) => scope.webServer.register(route))
      return () => { for (const d of disposers) { try { d() } catch { /* ignore */ } } }
    }, 'dsh-audio-post: routes')
  })
  ctx.inject(['tools'], (tctx) => { tctx.effect(() => registerTools(tctx), 'dsh-audio-post: tools') })
}

export { PRESETS }