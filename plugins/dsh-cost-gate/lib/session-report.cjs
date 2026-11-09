/**
 * 会话账单与会话预算（task-24）。
 *
 * 只读：扫描 DSH 会话文件，解析 assistant/message.data.usage，不写峰时账本。
 * - 压缩会话：优先用 Node 内置 zlib 的 zstd 解码（Node ≥ 22.15），
 *   否则调用系统 `zstd -dc`；两者都没有时，若存在 .zstd 文件则 supported:false。
 * - 不新增 npm 依赖。
 * - 未压缩 `.jsonl` 夹具不需要 zstd，便于测试。
 */
'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const zlib = require('node:zlib')

const DEFAULT_THRESHOLD = 150000
const PRICE_DEFAULTS = { input: 2, cached: 0.2, output: 3 }

function numberOr(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

function price(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  return numberOr(raw, fallback)
}

function prices() {
  return {
    input: price('DSH_PRICE_INPUT', PRICE_DEFAULTS.input),
    cached: price('DSH_PRICE_CACHED', PRICE_DEFAULTS.cached),
    output: price('DSH_PRICE_OUTPUT', PRICE_DEFAULTS.output),
  }
}

function sessionsRoot() {
  if (process.env.DSH_SESSIONS_DIR) return process.env.DSH_SESSIONS_DIR
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'sessions')
}

function detectZstd() {
  if (typeof zlib.zstdDecompressSync === 'function') return true
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which'
    const out = spawnSync(cmd, ['zstd'], { encoding: 'utf8', windowsHide: true })
    return out.status === 0
  } catch {
    return false
  }
}

function walkSessionFiles(root) {
  const files = []
  const seen = new Set()
  const stack = [root]
  while (stack.length && files.length < 20000) {
    const dir = stack.pop()
    if (seen.has(dir)) continue
    seen.add(dir)
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue
        stack.push(full)
      } else if (entry.isFile() && /\.jsonl(\.zstd)?$/.test(entry.name)) {
        files.push(full)
      }
    }
  }
  return files
}

function readSessionText(file, zstdAvailable) {
  if (!file.endsWith('.zstd')) return fs.readFileSync(file, 'utf8')
  if (!zstdAvailable) {
    const error = new Error('zstd 不可用，无法读取压缩会话')
    error.code = 'zstd-unavailable'
    throw error
  }
  if (typeof zlib.zstdDecompressSync === 'function') {
    try {
      return zlib.zstdDecompressSync(fs.readFileSync(file)).toString('utf8')
    } catch {
      // 不是 zstd 帧或 Node 解码失败时，回退到系统命令
    }
  }
  const out = spawnSync('zstd', ['-dc', file], {
    maxBuffer: 128 * 1024 * 1024,
    windowsHide: true,
  })
  if (out.error) throw out.error
  if (out.status !== 0) {
    const stderr = out.stderr ? out.stderr.toString('utf8').trim() : ''
    const error = new Error(`zstd -dc 失败（${out.status}）${stderr ? '：' + stderr : ''}`)
    error.code = 'zstd-failed'
    throw error
  }
  return out.stdout.toString('utf8')
}

function shortId(id) {
  const value = String(id || '')
  const matched = /^session-([0-9a-f]{8})/i.exec(value)
  if (matched) return matched[1].toLowerCase()
  const stripped = value.replace(/^session-/, '')
  return (stripped.slice(0, 8) || 'unknown').toLowerCase()
}

function usageOf(record) {
  const usage = record && record.data && record.data.usage
  if (!usage) return null
  return {
    input: numberOr(usage.inputTokens ?? usage.input_tokens ?? usage.input, 0),
    cached: numberOr(usage.cacheReadTokens ?? usage.cachedTokens ?? usage.cache_read_input_tokens, 0),
    output: numberOr(usage.outputTokens ?? usage.output_tokens ?? usage.output, 0),
  }
}

function parseSession(text, file) {
  const dirId = path.basename(path.dirname(file))
  let id = dirId
  let title = ''
  let requests = 0
  let input = 0
  let cached = 0
  let output = 0
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    if (record.type === 'session') {
      if (record.id) id = String(record.id)
      if (record.title) title = String(record.title)
    } else if (record.type === 'session/title') {
      const nextTitle = record.data && record.data.title
      if (nextTitle) title = String(nextTitle)
    } else if (record.type === 'assistant/message') {
      const usage = usageOf(record)
      if (!usage) continue
      requests += 1
      input += usage.input
      cached += usage.cached
      output += usage.output
    }
  }
  return { id, shortId: shortId(id), title, requests, input, cached, output }
}

function costOf(input, cached, output, unit) {
  return (input * unit.input + cached * unit.cached + output * unit.output) / 1e6
}

function cny(value) {
  return Math.round(value * 1e6) / 1e6
}

function dailyReport(options = {}) {
  const root = options.sessionsDir || sessionsRoot()
  const zstdAvailable = options.zstdAvailable ?? detectZstd()
  const files = walkSessionFiles(root)
  const compressed = files.filter((file) => file.endsWith('.zstd'))
  const unit = prices()
  const base = {
    supported: false,
    reason: null,
    sessionsDir: root,
    sessions: 0,
    totals: { input: 0, cached: 0, output: 0, cny: 0 },
    top: [],
    errors: 0,
    prices: unit,
  }
  if (compressed.length && !zstdAvailable) {
    return {
      ...base,
      reason: 'zstd-not-found',
      text: '每日账单不可用：未找到系统 zstd，无法读取压缩会话。请安装 zstd 后重试（Windows 可 winget install zstd；Linux/macOS 可用包管理器安装）。',
    }
  }

  const sessions = []
  let errors = 0
  for (const file of files) {
    try {
      const parsed = parseSession(readSessionText(file, zstdAvailable), file)
      parsed.cny = cny(costOf(parsed.input, parsed.cached, parsed.output, unit))
      sessions.push(parsed)
    } catch {
      errors += 1
    }
  }
  sessions.sort((a, b) => b.cny - a.cny || b.input - a.input)
  const totals = sessions.reduce((sum, item) => ({
    input: sum.input + item.input,
    cached: sum.cached + item.cached,
    output: sum.output + item.output,
    cny: sum.cny + item.cny,
  }), { input: 0, cached: 0, output: 0, cny: 0 })
  totals.cny = cny(totals.cny)

  const top = sessions.slice(0, 10).map((item) => ({
    id: item.id,
    shortId: item.shortId,
    title: item.title,
    requests: item.requests,
    input: item.input,
    cached: item.cached,
    output: item.output,
    cny: item.cny,
  }))
  const lines = [
    `每日账单：${sessions.length} 个会话；input ${totals.input} / cached ${totals.cached} / output ${totals.output}；估算 ¥${totals.cny.toFixed(4)}`,
    `单价（元/百万）：input ${unit.input} / cached ${unit.cached} / output ${unit.output}`,
  ]
  if (top.length) {
    lines.push('Top 10（按估算 ¥）：')
    top.forEach((item, index) => {
      const title = item.title ? ` ${item.title.slice(0, 40)}` : ''
      lines.push(`${index + 1}. ${item.shortId}${title} | req ${item.requests} | cached ${item.cached} | ¥${item.cny.toFixed(4)}`)
    })
  } else {
    lines.push('Top 10：无可用会话')
  }
  if (errors) lines.push(`读取失败：${errors} 个文件（已跳过）`)

  return {
    ...base,
    supported: true,
    sessions: sessions.length,
    totals,
    top,
    errors,
    text: lines.join('\n'),
  }
}

function findSessionFile(sessionId, root) {
  const value = String(sessionId || '').trim()
  if (!value) return null
  try {
    if (fs.statSync(value).isFile()) return value
  } catch {
    // 按 session id 继续扫描
  }
  const files = walkSessionFiles(root)
  return files.find((file) => {
    if (path.basename(path.dirname(file)) === value) return true
    if (value.startsWith('session-') && path.basename(path.dirname(file)) === value) return true
    return path.basename(path.dirname(file)) === `session-${value}`
  }) || null
}

function writeHandoff(draft, cwd) {
  const dir = path.join(cwd || process.cwd(), 'docs', 'tmp')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `handoff-${draft.shortId}.md`)
  fs.writeFileSync(file, draft.lines.join('\n') + '\n', 'utf8')
  return file
}

function sessionBudget(sessionId, options = {}) {
  const root = options.sessionsDir || sessionsRoot()
  const zstdAvailable = options.zstdAvailable ?? detectZstd()
  const file = findSessionFile(sessionId, root)
  if (!file) {
    const error = new Error(`会话不存在：${sessionId}`)
    error.code = 'session-not-found'
    throw error
  }
  const parsed = parseSession(readSessionText(file, zstdAvailable), file)
  const unit = prices()
  const threshold = numberOr(
    options.threshold ?? process.env.DSH_SESSION_WARN_TOKENS,
    DEFAULT_THRESHOLD,
  )
  // 卡口径：累计 input token（usage.inputTokens）；cacheRead 单独返回，便于看上下文总量。
  const tokens = parsed.input
  const contextTokens = parsed.input + parsed.cached
  const warn = tokens > threshold
  const valueCny = cny(costOf(parsed.input, parsed.cached, parsed.output, unit))
  const result = {
    ok: true,
    sessionId: parsed.id,
    shortId: parsed.shortId,
    file,
    tokens,
    contextTokens,
    inputTokens: parsed.input,
    cachedTokens: parsed.cached,
    outputTokens: parsed.output,
    requests: parsed.requests,
    threshold,
    warn,
    cny: valueCny,
    handoff: null,
    handoffError: null,
  }
  if (options.handoff) {
    const target = String(parsed.title || '（未记录标题）').replace(/\s+/g, ' ').slice(0, 120)
    const lines = [
      `# 会话交接 — ${parsed.shortId}`,
      '',
      `- 生成时间：${new Date(options.now || Date.now()).toISOString()}`,
      `- 会话：${parsed.id}`,
      `- 上下文：${contextTokens} tokens（input ${parsed.input} + cached ${parsed.cached}）/ 阈值 ${threshold}`,
      `- 请求数：${parsed.requests}`,
      '',
      '## 目标',
      target,
      '',
      '## 已完成',
      `- 已累计 ${tokens} tokens，${parsed.requests} 次请求；${warn ? '已超过' : '未超过'}阈值。`,
      '',
      '## 待做',
      '- （自动草稿未解析，请补全未完成项）',
      '',
      '## 下一步',
      '- 开新会话，先读本页；从「待做」继续，不在原会话追加长上下文。',
    ]
    try {
      result.handoff = writeHandoff({ shortId: parsed.shortId, lines }, options.cwd)
    } catch (error) {
      result.handoffError = String(error && error.message ? error.message : error)
    }
  }
  result.text = `会话 ${parsed.shortId}：input ${tokens}（上下文 ${contextTokens}，含 cached ${parsed.cached}）/ 阈值 ${threshold}；${warn ? '已超阈值，建议收尾并写交接' : '未超阈值'}。`
  if (result.handoff) result.text += `交接草稿：${result.handoff}`
  if (result.handoffError) result.text += `交接草稿写入失败：${result.handoffError}`
  return result
}

module.exports = {
  DEFAULT_THRESHOLD,
  PRICE_DEFAULTS,
  sessionsRoot,
  detectZstd,
  walkSessionFiles,
  parseSession,
  dailyReport,
  sessionBudget,
  shortId,
}
