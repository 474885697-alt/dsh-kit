/**
 * dsh-kit-config-sync - snapshot skills + plugin setup, restore on another machine.
 */
import { mkdir, readdir, readFile, writeFile, copyFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, relative, dirname } from 'node:path'
import { homedir, hostname, platform } from 'node:os'

export const name = 'config-sync'
export const inject = []

const API = '/api/dsh-kit-config-sync'
const SECRET_RE = /(api[-_]?key|apikey|secret|token|password|passwd|credential|authorization|auth[-_]?key)/i
const TEXT_EXT = /\.(md|markdown|json|jsonc|yml|yaml|txt|js|mjs|cjs|ts|py|sh|ps1|css|html)$/i
const MAX_CONTENT = 200 * 1024
const DEFAULT_INTERVAL = 300

function dshHome() { return process.env.DSH_HOME || join(homedir(), '.dsh') }
function skillsDir() { return join(dshHome(), 'skills') }
function profilesDir() { return join(dshHome(), 'profiles') }
function storeDir() { return join(dshHome(), 'dsh-kit-config-sync') }
function snapshotsDir() { return join(storeDir(), 'snapshots') }
function configPath() { return join(storeDir(), 'config.json') }

async function readJsonSafe(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return fallback
  }
}

async function writeText(path, text) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text, 'utf8')
}

async function writeJson(path, value) {
  await writeText(path, JSON.stringify(value, null, 2))
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function fileStamp() {
  const d = new Date()
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().replace(/[-:T]/g, '').slice(0, 14)
}

async function walk(dir, base, out) {
  let entries = []
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) await walk(full, base, out)
    else if (entry.isFile()) {
      const info = await stat(full).catch(() => null)
      if (info) out.push({ path: relative(base, full).replace(/\\/g, '/'), size: info.size })
    }
  }
  return out
}

function parseFrontmatter(text) {
  const match = String(text || '').match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return {}
  const data = {}
  for (const line of match[1].split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/)
    if (!m) continue
    let value = m[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    data[m[1]] = value
  }
  return data
}

export async function collectSkills(includeContent) {
  const root = skillsDir()
  let dirs = []
  try {
    dirs = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const skills = []
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue
    const dirPath = join(root, dir.name)
    const skillPath = join(dirPath, 'SKILL.md')
    const text = await readFile(skillPath, 'utf8').catch(() => null)
    if (text === null) continue
    const front = parseFrontmatter(text)
    const files = []
    for (const file of await walk(dirPath, dirPath, [])) {
      const full = join(dirPath, file.path)
      const buffer = await readFile(full).catch(() => null)
      if (!buffer) continue
      const item = { path: file.path, size: file.size, sha256: sha256(buffer) }
      if (includeContent && file.size <= MAX_CONTENT && TEXT_EXT.test(file.path)) {
        item.content = buffer.toString('utf8')
      }
      files.push(item)
    }
    skills.push({
      dir: dir.name,
      name: front.name || dir.name,
      description: front.description || '',
      files,
    })
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name))
}

export function redactPatch(text) {
  const redactions = []
  const lines = String(text || '').split(/\r?\n/)
  let blockIndent = -1
  const SECRET_VALUE = /^(sk-[A-Za-z0-9-]{8,}|gsk_[A-Za-z0-9]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|AKIA[0-9A-Z]{12,}|xox[baprs]-[A-Za-z0-9-]{8,}|eyJ[A-Za-z0-9_-]{8,}\.)/
  const out = lines.map((line) => {
    const entry = line.match(/^(\s*)([A-Za-z0-9_.-]+)\s*:\s*(.*?)\s*$/)
    if (!entry) {
      if (blockIndent >= 0 && line.trim() && line.search(/\S/) <= blockIndent) blockIndent = -1
      return line
    }
    const indent = entry[1].length
    const key = entry[2]
    const value = entry[3]
    if (blockIndent >= 0 && indent <= blockIndent) blockIndent = -1

    const nestedBlock = value === '' && (SECRET_RE.test(key) || /secrets?$/i.test(key))
    if (nestedBlock) {
      blockIndent = indent
      return line
    }
    const inSecretBlock = blockIndent >= 0 && indent > blockIndent
    if (!value || value === '""' || value === "''" || value === '[]' || value === '{}') return line

    const sensitiveKey = SECRET_RE.test(key)
    const sensitiveValue = SECRET_VALUE.test(value.replace(/^["']/, '')) || /(bearer\s+)[A-Za-z0-9._-]{12,}/i.test(value)
    const longOpaque = value.length >= 48 && /^[A-Za-z0-9_\-./+=]+$/.test(value) && !/^link:|^https?:/.test(value)

    if (sensitiveKey || (inSecretBlock && (sensitiveValue || longOpaque)) || sensitiveValue || (longOpaque && /key|token|secret|pass/i.test(key))) {
      redactions.push(key)
      return entry[1] + key + ': "<redacted>"'
    }
    return line
  })
  return { text: out.join('\n'), redactions: [...new Set(redactions)] }
}

function patchRows(text) {
  const rows = []
  let current = null
  for (const line of String(text || '').split(/\r?\n/)) {
    const head = line.match(/^-\s+id:\s*(\S+)\s*$/)
    if (head) {
      current = { id: head[1], disabled: false }
      rows.push(current)
      continue
    }
    if (current && /^\s+disabled:\s*true\s*$/.test(line)) current.disabled = true
  }
  return rows
}

export async function collectProfile(profileName) {
  const profile = profileName || 'desktop'
  const dir = join(profilesDir(), profile)
  const pkgPath = join(dir, 'package.json')
  const patchPath = join(dir, 'cordis.patch.yml')
  const pkg = await readJsonSafe(pkgPath, null)
  if (!pkg) throw new Error('profile 清单不存在或无法解析：' + pkgPath)
  const patchRaw = await readFile(patchPath, 'utf8').catch(() => '')
  const patch = redactPatch(patchRaw)
  const bundles = Array.isArray(pkg.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : []
  const dependencies = pkg.dependencies || {}
  const plugins = bundles.map((bundle) => ({
    name: bundle,
    declared: Object.prototype.hasOwnProperty.call(dependencies, bundle),
    installed: existsSync(join(dir, 'node_modules', bundle)),
    link: String(dependencies[bundle] || '').startsWith('link:') ? dependencies[bundle] : undefined,
  }))
  return {
    profile,
    profileDir: dir,
    packageJson: { dependencies, bundles },
    patch: { rows: patchRows(patchRaw), redactions: patch.redactions, text: patch.text },
    plugins,
  }
}

export async function buildSnapshot(options) {
  const opts = options || {}
  const profileName = opts.profile || 'desktop'
  const skills = await collectSkills(true)
  const profile = await collectProfile(profileName)
  const core = { skills, profile: { profile: profile.profile, packageJson: profile.packageJson, patch: { rows: profile.patch.rows, text: profile.patch.text } } }
  const fingerprint = sha256(JSON.stringify(core))
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    note: opts.note || '',
    fingerprint,
    device: { hostname: hostname(), platform: platform(), dshHome: dshHome(), profile: profileName },
    skills,
    profile,
  }
}

export async function saveSnapshot(snap) {
  await mkdir(snapshotsDir(), { recursive: true })
  const id = stamp()
  const record = { ...snap, id }
  await writeJson(join(snapshotsDir(), id + '.json'), record)
  await writeJson(join(snapshotsDir(), 'latest.json'), record)
  return { ok: true, id, path: join(snapshotsDir(), id + '.json'), skills: snap.skills.length, bundles: snap.profile.packageJson.bundles.length }
}

export async function listSnapshots(limit) {
  let names = []
  try {
    names = await readdir(snapshotsDir())
  } catch {
    return []
  }
  const items = []
  for (const fileName of names) {
    if (!fileName.endsWith('.json') || fileName === 'latest.json') continue
    const data = await readJsonSafe(join(snapshotsDir(), fileName), null)
    if (!data) continue
    items.push({
      id: data.id || fileName.replace(/\.json$/, ''),
      createdAt: data.createdAt,
      note: data.note || '',
      skills: Array.isArray(data.skills) ? data.skills.length : 0,
      bundles: data.profile?.packageJson?.bundles?.length || 0,
    })
  }
  return items.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, limit || 50)
}

export async function loadSnapshot(id) {
  const key = !id || id === 'latest' ? 'latest' : String(id).replace(/[^A-Za-z0-9_-]/g, '')
  return readJsonSafe(join(snapshotsDir(), key + '.json'), null)
}

export async function loadConfig() {
  const data = await readJsonSafe(configPath(), null)
  return { backend: 'local', autoEnabled: true, autoIntervalSec: DEFAULT_INTERVAL, ...(data || {}) }
}

export async function saveConfig(patch) {
  const current = await loadConfig()
  const next = { ...current, ...patch }
  await writeJson(configPath(), next)
  return next
}

async function pushGist(snap, cfg) {
  if (!cfg.gistToken) throw new Error('gist 后端需要 gistToken（GitHub token，scope=gist）')
  const body = { description: 'DSH config snapshot', files: { 'dsh-config-snapshot.json': { content: JSON.stringify(snap, null, 2) } } }
  let url = cfg.gistId ? 'https://api.github.com/gists/' + cfg.gistId : 'https://api.github.com/gists'
  let method = cfg.gistId ? 'PATCH' : 'POST'
  let response = await fetch(url, { method, headers: { authorization: 'Bearer ' + cfg.gistToken, accept: 'application/vnd.github+json', 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (!response.ok) throw new Error('gist 推送失败：HTTP ' + response.status)
  const data = await response.json()
  if (!cfg.gistId && data.id) await saveConfig({ gistId: data.id })
  return { ok: true, backend: 'gist', gistId: data.id || cfg.gistId, url: data.html_url || '' }
}

async function pullGist(cfg) {
  if (!cfg.gistToken || !cfg.gistId) throw new Error('gist 后端需要 gistToken 与 gistId（先 push 一次会自动记录）')
  const response = await fetch('https://api.github.com/gists/' + cfg.gistId, { headers: { authorization: 'Bearer ' + cfg.gistToken, accept: 'application/vnd.github+json' } })
  if (!response.ok) throw new Error('gist 拉取失败：HTTP ' + response.status)
  const data = await response.json()
  const file = data.files?.['dsh-config-snapshot.json'] || Object.values(data.files || {})[0]
  if (!file) throw new Error('gist 里没有快照文件')
  const content = file.truncated ? await (await fetch(file.raw_url)).text() : file.content
  return JSON.parse(content)
}

async function pushHttp(snap, cfg) {
  if (!cfg.httpUrl) throw new Error('http 后端需要 httpUrl')
  const headers = { 'content-type': 'application/json' }
  if (cfg.httpToken) headers.authorization = 'Bearer ' + cfg.httpToken
  const response = await fetch(cfg.httpUrl, { method: 'POST', headers, body: JSON.stringify(snap) })
  if (!response.ok) throw new Error('HTTP 推送失败：' + response.status)
  return { ok: true, backend: 'http', url: cfg.httpUrl }
}

async function pullHttp(cfg) {
  if (!cfg.httpUrl) throw new Error('http 后端需要 httpUrl')
  const headers = cfg.httpToken ? { authorization: 'Bearer ' + cfg.httpToken } : {}
  const response = await fetch(cfg.httpUrl.replace(/\/$/, '') + '/latest', { headers })
  if (!response.ok) throw new Error('HTTP 拉取失败：' + response.status)
  return response.json()
}

export async function pushSnapshot(snap) {
  const cfg = await loadConfig()
  if (cfg.backend === 'gist') return pushGist(snap, cfg)
  if (cfg.backend === 'http') return pushHttp(snap, cfg)
  const saved = await saveSnapshot(snap)
  return { ok: true, backend: 'local', ...saved }
}

export async function pullLatest() {
  const cfg = await loadConfig()
  if (cfg.backend === 'gist') return pullGist(cfg)
  if (cfg.backend === 'http') return pullHttp(cfg)
  const snap = await loadSnapshot('latest')
  if (!snap) throw new Error('本地还没有快照，先执行 config_snapshot')
  return snap
}

export function summarize(snap) {
  const skills = (snap.skills || []).map((s) => ({ name: s.name, dir: s.dir, files: s.files.length, withContent: s.files.filter((f) => f.content).length }))
  const profile = snap.profile || {}
  return {
    id: snap.id || '',
    createdAt: snap.createdAt,
    note: snap.note || '',
    device: snap.device || {},
    skills,
    profile: profile.profile || '',
    bundles: profile.packageJson?.bundles?.length || 0,
    patchRows: profile.patch?.rows?.length || 0,
    redactions: profile.patch?.redactions || [],
    plugins: profile.plugins || [],
  }
}

async function backupFile(path) {
  if (!existsSync(path)) return ''
  const backup = path + '.manual-' + fileStamp()
  await copyFile(path, backup)
  return backup
}

export async function applySnapshot(snap, options) {
  const opts = options || {}
  const report = { ok: true, dryRun: opts.apply !== true, skills: [], profile: null, patch: null, warnings: [], redactions: [] }
  const targetProfile = opts.profile || snap.profile?.profile || 'desktop'
  const targetDir = join(profilesDir(), targetProfile)

  for (const skill of snap.skills || []) {
    const dir = join(skillsDir(), skill.dir)
    const exists = existsSync(dir)
    if (exists && opts.force !== true) {
      report.skills.push({ dir: skill.dir, status: 'exists-skip' })
      continue
    }
    report.skills.push({ dir: skill.dir, status: exists ? 'overwrite' : 'create' })
    if (opts.apply !== true) continue
    for (const file of skill.files || []) {
      if (file.content === undefined) {
        report.warnings.push('技能 ' + skill.dir + ' 的文件 ' + file.path + ' 没有内容（只记录了哈希），未恢复')
        continue
      }
      await writeText(join(dir, file.path), file.content)
    }
  }

  const pkgPath = join(targetDir, 'package.json')
  const pkg = await readJsonSafe(pkgPath, null)
  if (!pkg) {
    report.warnings.push('目标 profile 不存在：' + targetDir)
    report.ok = false
  } else {
    const wanted = snap.profile?.packageJson?.bundles || []
    const current = Array.isArray(pkg.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : []
    const missing = wanted.filter((b) => !current.includes(b))
    report.profile = { profile: targetProfile, missing, current: current.length, wanted: wanted.length }
    for (const bundle of missing) {
      const installed = existsSync(join(targetDir, 'node_modules', bundle))
      if (!installed) report.warnings.push('bundle 未安装，需要先 npm/link：' + bundle)
    }
    if (opts.apply === true && missing.length) {
      const backup = await backupFile(pkgPath)
      pkg.dsh = pkg.dsh || {}
      pkg.dsh.profile = pkg.dsh.profile || {}
      pkg.dsh.profile.bundles = [...current, ...missing]
      const text = JSON.stringify(pkg, null, 2) + '\n'
      let parsed
      try {
        parsed = JSON.parse(text)
      } catch (error) {
        report.warnings.push('清单序列化失败，已放弃写入：' + error.message)
        report.ok = false
      }
      if (parsed) {
        await writeText(pkgPath, text)
        const check = await readJsonSafe(pkgPath, null)
        if (!check) {
          await copyFile(backup, pkgPath)
          report.ok = false
          report.warnings.push('写入后校验失败，已回滚')
        } else {
          report.profile.backup = backup
          report.profile.added = missing.length
        }
      }
    }
  }

  const patchText = snap.profile?.patch?.text
  if (patchText) {
    const patchPath = join(targetDir, 'cordis.patch.yml')
    report.patch = { path: patchPath, rows: snap.profile?.patch?.rows?.length || 0, redactions: snap.profile?.patch?.redactions || [] }
    report.redactions = snap.profile?.patch?.redactions || []
    if (opts.apply === true && opts.applyPatch === true) {
      const backup = await backupFile(patchPath)
      await writeText(patchPath, patchText.endsWith('\n') ? patchText : patchText + '\n')
      report.patch.backup = backup
    } else if (opts.apply === true) {
      report.patch.skipped = '默认不覆盖 cordis.patch.yml（含敏感配置），需要 applyPatch: true'
    }
  }
  return report
}

async function startAuto(ctx, state) {
  const stop = () => { if (state.timer) clearInterval(state.timer); state.timer = null }
  stop()
  const cfg = await loadConfig()
  if (!cfg.autoEnabled) return
  const interval = Math.max(60, Number(cfg.autoIntervalSec) || DEFAULT_INTERVAL) * 1000
  state.timer = setInterval(async () => {
    if (state.running) return
    state.running = true
    try {
      const snap = await buildSnapshot({ note: 'auto' })
      if (snap.fingerprint === state.lastFingerprint) return
      state.lastFingerprint = snap.fingerprint
      const saved = await saveSnapshot(snap)
      state.lastAuto = new Date().toISOString()
      ctx.logger?.info?.('config-sync: auto snapshot ' + saved.id)
      if (cfg.backend !== 'local') {
        await pushSnapshot(snap).catch((error) => ctx.logger?.warn?.('config-sync: push failed ' + error.message))
      }
    } catch (error) {
      ctx.logger?.warn?.('config-sync: auto snapshot failed ' + String(error.message || error))
    } finally {
      state.running = false
    }
  }, interval)
  state.timer.unref?.()
}

function isLoopback(req) {
  const address = req.socket?.remoteAddress || ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

async function readBody(req, limit) {
  const max = limit || 4 * 1024 * 1024
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > max) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

function route(ctx, path, handler) {
  return ctx.webServer.register({
    kind: 'exact',
    path: API + path,
    handler: async (req, res) => {
      if (!isLoopback(req)) return sendJson(res, 403, { ok: false, error: '只允许本机访问' })
      try {
        const value = await handler(req)
        sendJson(res, value?.__status || 200, value)
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error.message || error) })
      }
    },
  })
}

function registerTools(ctx) {
  const tools = ctx.tools
  tools.register({
    name: 'config_snapshot',
    description: '把本机的技能与插件配置打包成一份快照（自动脱敏密钥），并按配置推送到远端。返回快照 id 与统计。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        note: { type: 'string', description: '备注，便于区分快照' },
        profile: { type: 'string', description: 'profile 名，默认 desktop' },
      },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute(args) {
      const snap = await buildSnapshot({ note: args?.note, profile: args?.profile })
      const pushed = await pushSnapshot(snap)
      return JSON.stringify({ ok: true, pushed, skills: snap.skills.length, bundles: snap.profile.packageJson.bundles.length, redactions: snap.profile.patch.redactions }, null, 2)
    },
  })

  tools.register({
    name: 'config_list',
    description: '列出本机保存过的配置快照（时间、备注、技能数、bundle 数）。',
    parameters: { type: 'object', additionalProperties: false, properties: { limit: { type: 'number', description: '最多返回条数，默认 20' } } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute(args) {
      const items = await listSnapshots(Number(args?.limit) || 20)
      return JSON.stringify({ ok: true, count: items.length, snapshots: items }, null, 2)
    },
  })

  tools.register({
    name: 'config_push',
    description: '把指定快照（默认 latest，或先新建）推送到当前后端（local/gist/http）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: '快照 id，默认 latest' },
        create: { type: 'boolean', description: '先按当前状态新建一份快照再推送' },
        note: { type: 'string' },
        profile: { type: 'string' },
      },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute(args) {
      const snap = args?.create ? await buildSnapshot({ note: args?.note, profile: args?.profile }) : await loadSnapshot(args?.id || 'latest')
      if (!snap) throw new Error('找不到快照：' + (args?.id || 'latest'))
      const pushed = await pushSnapshot(snap)
      return JSON.stringify({ ok: true, pushed, summary: summarize(snap) }, null, 2)
    },
  })

  tools.register({
    name: 'config_pull',
    description: '从当前后端拉取最新快照（不落盘），返回内容摘要与将要恢复的技能/插件清单。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute() {
      const snap = await pullLatest()
      return JSON.stringify({ ok: true, summary: summarize(snap) }, null, 2)
    },
  })

  tools.register({
    name: 'config_apply',
    description: '把快照恢复到本机：默认 dry-run（只报告会做什么），apply=true 才真正写文件；技能已存在会跳过，除非 force=true；cordis.patch.yml 需要 apply_patch=true 才覆盖。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: '快照 id，默认 latest；remote 表示先从远端拉取' },
        apply: { type: 'boolean', description: 'true 才真正写入，默认只演练' },
        apply_patch: { type: 'boolean', description: '是否覆盖 cordis.patch.yml（含脱敏占位符）' },
        force: { type: 'boolean', description: '技能目录已存在时是否覆盖' },
        profile: { type: 'string', description: '目标 profile，默认用快照里的' },
      },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute(args) {
      const snap = args?.id === 'remote' ? await pullLatest() : await loadSnapshot(args?.id || 'latest')
      if (!snap) throw new Error('找不到快照：' + (args?.id || 'latest'))
      const report = await applySnapshot(snap, { apply: args?.apply === true, applyPatch: args?.apply_patch === true, force: args?.force === true, profile: args?.profile })
      return JSON.stringify(report, null, 2)
    },
  })

  tools.register({
    name: 'config_auto',
    description: '开关自动快照：开启后按间隔（≥60 秒，默认 300）检测技能/插件变化，变了就保存（非 local 后端会同时推送）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        enabled: { type: 'boolean', description: '是否启用' },
        interval_sec: { type: 'number', description: '检查间隔秒数，最小 60' },
      },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute(args) {
      const patch = {}
      if (typeof args?.enabled === 'boolean') patch.autoEnabled = args.enabled
      if (args?.interval_sec) patch.autoIntervalSec = Math.max(60, Number(args.interval_sec) || DEFAULT_INTERVAL)
      const cfg = await saveConfig(patch)
      return JSON.stringify({ ok: true, autoEnabled: cfg.autoEnabled, autoIntervalSec: cfg.autoIntervalSec, note: '已保存，重启宿主后按新配置启动' }, null, 2)
    },
  })

  tools.register({
    name: 'config_backend',
    description: '配置同步后端：local（默认，存本机）、gist（GitHub Gist，需要 gist_token）、http（自建服务，POST 推送 / GET <url>/latest 拉取）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        backend: { type: 'string', description: 'local | gist | http' },
        gist_token: { type: 'string', description: 'GitHub token（scope=gist）' },
        gist_id: { type: 'string', description: '已有 gist id，可留空由首次推送创建' },
        http_url: { type: 'string', description: '自建服务地址' },
        http_token: { type: 'string', description: '自建服务 Bearer token' },
      },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute(args) {
      if (args?.backend && !['local', 'gist', 'http'].includes(args.backend)) {
        throw new Error('backend 只能是 local / gist / http，收到：' + args.backend)
      }
      const patch = {}
      if (args?.backend) patch.backend = args.backend
      if (args?.gist_token) patch.gistToken = args.gist_token
      if (args?.gist_id) patch.gistId = args.gist_id
      if (args?.http_url) patch.httpUrl = args.http_url
      if (args?.http_token) patch.httpToken = args.http_token
      const cfg = await saveConfig(patch)
      if (cfg.backend === 'gist' && !cfg.gistToken) throw new Error('gist 后端需要 gist_token（GitHub token，scope=gist）')
      if (cfg.backend === 'http' && !cfg.httpUrl) throw new Error('http 后端需要 http_url')
      return JSON.stringify({ ok: true, backend: cfg.backend, gistId: cfg.gistId || '', hasToken: Boolean(cfg.gistToken || cfg.httpToken), httpUrl: cfg.httpUrl || '' }, null, 2)
    },
  })

  tools.register({
    name: 'config_status',
    description: '查看同步状态：后端、自动快照开关与间隔、本地快照数量、技能数量、当前指纹。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute() {
      const cfg = await loadConfig()
      const skills = await collectSkills(false)
      const snaps = await listSnapshots(5)
      const latest = await loadSnapshot('latest')
      return JSON.stringify({ ok: true, backend: cfg.backend, autoEnabled: cfg.autoEnabled, autoIntervalSec: cfg.autoIntervalSec, gistId: cfg.gistId || '', httpUrl: cfg.httpUrl || '', skills: skills.length, snapshots: snaps.length, latest: latest ? { id: latest.id, createdAt: latest.createdAt, skills: latest.skills?.length || 0 } : null, storeDir: storeDir() }, null, 2)
    },
  })
}

export async function apply(ctx) {
  const state = { timer: null, running: false, lastFingerprint: '', lastAuto: null }

  ctx.effect(
    () => () => {
      if (state.timer) clearInterval(state.timer)
      state.timer = null
    },
    'config-sync: auto timer',
  )

  ctx.inject(['webServer'], (scope) => {
    scope.effect(
      () => {
        const disposers = [
        route(scope, '/status', async () => {
          const cfg = await loadConfig()
          const skills = await collectSkills(false)
          return {
            ok: true,
            backend: cfg.backend,
            autoEnabled: cfg.autoEnabled,
            autoIntervalSec: cfg.autoIntervalSec,
            skills: skills.length,
            snapshots: (await listSnapshots(5)).length,
            lastAuto: state.lastAuto,
          }
        }),
        route(scope, '/list', async () => ({ ok: true, snapshots: await listSnapshots(50) })),
        route(scope, '/latest', async () => {
          const snap = await pullLatest()
          return { ok: true, summary: summarize(snap) }
        }),
        route(scope, '/snapshot', async (req) => {
          const body = await readBody(req)
          const snap = await buildSnapshot({ note: body.note, profile: body.profile })
          const pushed = await pushSnapshot(snap)
          return { ok: true, pushed, summary: summarize(snap) }
        }),
        route(scope, '/apply', async (req) => {
          const body = await readBody(req)
          const snap = body.id === 'remote' ? await pullLatest() : await loadSnapshot(body.id || 'latest')
          if (!snap) return { __status: 404, ok: false, error: '找不到快照' }
          return await applySnapshot(snap, {
            apply: body.apply === true,
            applyPatch: body.apply_patch === true,
            force: body.force === true,
            profile: body.profile,
          })
        }),
      ]
      return () => {
        for (const dispose of disposers) dispose()
      }
    },
      'config-sync: routes',
    )
  })

  ctx.inject(['tools'], (tctx) => {
    tctx.effect(() => registerTools(tctx), 'config-sync: tools')
  })

  void startAuto(ctx, state)
}
