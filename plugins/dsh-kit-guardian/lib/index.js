/**
 * dsh-kit-guardian - profile manifest and startup health guard.
 */
import { access, copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const name = 'plugin-guardian'
export const inject = []

const API = '/api/dsh-kit-guardian'
const MAX_CRASH = 6

function dshHome() { return process.env.DSH_HOME || join(homedir(), '.dsh') }
function profilesRoot() { return join(dshHome(), 'profiles') }
function stateDir() { return join(dshHome(), 'dsh-kit-guardian') }
function crashDir() {
  const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
  return join(appData, '@deepseek-ai', 'dsh-desktop', 'logs')
}

async function exists(path) { try { await access(path); return true } catch { return false } }
async function readText(path) { try { return await readFile(path, 'utf8') } catch { return null } }

function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

function lineOf(text, index) {
  let line = 1
  for (let i = 0; i < index && i < text.length; i += 1) if (text[i] === '\n') line += 1
  return line
}

function parseManifest(text) {
  const bom = text.charCodeAt(0) === 0xfeff
  const body = bom ? text.slice(1) : text
  try {
    return { ok: true, json: JSON.parse(body), bom }
  } catch (error) {
    const message = String(error && error.message ? error.message : error)
    const hint = /Unexpected token/.test(message)
      ? '检查数组/对象尾逗号、引号与 BOM；写入请用 UTF-8 无 BOM。'
      : '清单不是合法 JSON。'
    return { ok: false, bom, error: message, hint }
  }
}

async function detectProfile(name) {
  if (name) return join(profilesRoot(), name)
  for (const candidate of ['desktop', 'web']) {
    const dir = join(profilesRoot(), candidate)
    if (await exists(join(dir, 'package.json'))) return dir
  }
  return join(profilesRoot(), 'desktop')
}

async function inspectProfile(profileName) {
  const dir = await detectProfile(profileName)
  const issues = []
  const report = { profile: dir, manifest: null, counts: {}, issues, score: 100 }

  const manifestPath = join(dir, 'package.json')
  const text = await readText(manifestPath)
  if (text === null) {
    issues.push({ level: 'error', code: 'manifest-missing', message: 'profile 清单不存在：' + manifestPath })
    report.score = 0
    return report
  }

  const parsed = parseManifest(text)
  report.manifest = { path: manifestPath, bytes: text.length, bom: parsed.bom, ok: parsed.ok }
  if (!parsed.ok) {
    issues.push({ level: 'error', code: 'manifest-invalid', message: parsed.error, hint: parsed.hint })
    report.score = 0
  }
  if (parsed.bom) {
    issues.push({ level: 'warn', code: 'manifest-bom', message: '清单带 BOM，JSON.parse 会失败或某些解析器报错。', hint: '用 UTF8Encoding($false) 重写。' })
  }

  const patchPath = join(dir, 'cordis.patch.yml')
  const patchText = await readText(patchPath)
  const patchIds = []
  if (patchText) {
    const re = /-\s+id:\s*([A-Za-z0-9@/_.$-]+)/g
    let m
    while ((m = re.exec(patchText))) patchIds.push(m[1])
  }

  if (parsed.ok) {
    const json = parsed.json || {}
    const deps = Object.keys(json.dependencies || {})
    const bundles = Array.isArray(json.dsh && json.dsh.profile && json.dsh.profile.bundles) ? json.dsh.profile.bundles : []
    report.counts = { dependencies: deps.length, bundles: bundles.length, patchRows: patchIds.length }

    if (!bundles.length) {
      issues.push({ level: 'error', code: 'bundles-empty', message: 'dsh.profile.bundles 为空，应用不会加载任何插件。' })
      report.score -= 40
    }

    for (const dep of deps) {
      const local = /^link:/.test(String(json.dependencies[dep])) || /^file:/.test(String(json.dependencies[dep]))
      const isPluginName = local || dep.startsWith('dsh-') || dep.startsWith('@')
      if (isPluginName && !bundles.includes(dep)) {
        issues.push({ level: 'warn', code: 'dep-not-bundled', message: dep + ' 在 dependencies 里但不在 bundles 里（装了但不启用）。' })
        report.score -= 2
      }
    }

    for (const bundle of bundles) {
      if (String(bundle).startsWith('@deepseek-ai/')) continue // provided by the app itself
      const pkgPath = join(dir, 'node_modules', bundle, 'package.json')
      if (!(await exists(pkgPath))) {
        issues.push({ level: 'error', code: 'bundle-unresolved', message: 'bundles 里有 ' + bundle + '，但 node_modules 里找不到它。' })
        report.score -= 10
      }
    }

    for (const dep of deps) {
      if (!bundles.includes(dep)) continue
      const pkgPath = join(dir, 'node_modules', dep, 'package.json')
      const pkgText = await readText(pkgPath)
      if (pkgText) {
        try {
          const pkg = JSON.parse(pkgText)
          if (pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch && !(await exists(join(dir, 'node_modules', dep, pkg.dsh.bundle.patch)))) {
            issues.push({ level: 'warn', code: 'patch-missing', message: dep + ' 声明了 bundle.patch 但文件不存在。' })
          }
        } catch {}
      }
    }

    for (const id of patchIds) {
      const looksLikePlugin = /^dsh-/.test(id) || id.startsWith('@')
      if (!looksLikePlugin) continue
      if (!bundles.includes(id) && !bundles.some((b) => String(b).endsWith('/' + id))) {
        issues.push({ level: 'warn', code: 'patch-orphan', message: 'cordis.patch.yml 有 - id: ' + id + '，但 bundles 里没有对应插件。', hint: '通常无害；若启动异常先删这一行。' })
        report.score -= 1
      }
    }
  }

  const crashes = await readCrashes()
  report.crashes = crashes
  const recent = crashes.filter((c) => Date.now() - c.mtime < 24 * 3600 * 1000)
  if (recent.length) {
    issues.push({ level: 'warn', code: 'recent-crash', message: '过去 24 小时有 ' + recent.length + ' 份 startup crash 日志，最新错误：' + (recent[0].error || '') })
    report.score -= Math.min(15, recent.length * 3)
  }

  report.score = Math.max(0, Math.min(100, report.score))
  return report
}

async function readCrashes() {
  let names = []
  try { names = await readdir(crashDir()) } catch { return [] }
  const files = names.filter((n) => /^crash-.*\.log$/i.test(n)).sort().reverse().slice(0, MAX_CRASH)
  const out = []
  for (const file of files) {
    const text = (await readText(join(crashDir(), file))) || ''
    const lines = text.split(/\r?\n/)
    const errorLine = lines.find((l) => /^(DesktopHostFatalError|Error):/.test(l)) || lines.find((l) => / is not valid JSON|Web authentication failed/.test(l)) || ''
    const phaseMatch = /"?phase"?\s*[:=]\s*"?([A-Za-z-]+)/.exec(text)
    const mtime = (await readText(join(crashDir(), file))) ? 0 : 0
    let stats = null
    try { const st = await (await import('node:fs/promises')).stat(join(crashDir(), file)); stats = st.mtimeMs } catch {}
    out.push({ file, mtime: stats || mtime, phase: phaseMatch ? phaseMatch[1] : '', error: String(errorLine).slice(0, 300) })
  }
  return out
}

async function backupProfile(profileName) {
  const dir = await detectProfile(profileName)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = join(stateDir(), 'backups', stamp + '-' + (profileName || 'auto'))
  await mkdir(target, { recursive: true })
  const copied = []
  for (const file of ['package.json', 'cordis.patch.yml']) {
    const from = join(dir, file)
    if (await exists(from)) {
      await copyFile(from, join(target, file))
      copied.push(file)
    }
  }
  const meta = { profile: dir, copied, createdAt: Date.now(), id: stamp + '-' + (profileName || 'auto') }
  await writeFile(join(target, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8')
  return { ok: true, id: meta.id, path: target, copied }
}

async function listBackups() {
  try {
    const names = await readdir(join(stateDir(), 'backups'))
    const out = []
    for (const name of names.sort().reverse().slice(0, 30)) {
      const metaText = await readText(join(stateDir(), 'backups', name, 'meta.json'))
      let meta = null
      try { meta = metaText ? JSON.parse(metaText) : null } catch {}
      out.push({ id: name, meta })
    }
    return out
  } catch { return [] }
}

async function rollback(backupId, profileName) {
  if (!backupId) throw new Error('需要 backup id（见 GET ' + API + '/backups）')
  const src = join(stateDir(), 'backups', backupId)
  const dir = await detectProfile(profileName)
  const manifest = await readText(join(src, 'package.json'))
  if (manifest === null) throw new Error('备份里没有 package.json：' + src)
  const parsed = parseManifest(manifest)
  if (!parsed.ok) throw new Error('备份的清单本身不合法，拒绝回滚：' + parsed.error)
  const before = await backupProfile(profileName)
  const restored = []
  for (const file of ['package.json', 'cordis.patch.yml']) {
    const from = join(src, file)
    if (await exists(from)) {
      await copyFile(from, join(dir, file))
      restored.push(file)
    }
  }
  return { ok: true, restored, profile: dir, safetyBackup: before.id }
}

async function health(profileName) {
  try { return await inspectProfile(profileName) } catch (error) { return { ok: false, error: String(error && error.message ? error.message : error) } }
}

const SCHEMA = { type: 'string' }

function render(_args, value) { return [{ type: 'text', text: String(value) }] }

function registerTools(ctx) {
  const table = [
    {
      name: 'plugin_health',
      description: 'Check the current DSH profile: manifest JSON validity (trailing comma/BOM), dependencies vs bundles consistency, resolvable bundles, orphan patch rows, and recent startup crash causes.',
      parameters: { type: 'object', additionalProperties: false, properties: { profile: { type: 'string', description: 'Profile name, default desktop.' } } },
      async execute(args) { return JSON.stringify(await health(args && args.profile), null, 2) },
    },
    {
      name: 'plugin_backup',
      description: 'Back up the profile package.json and cordis.patch.yml into ~/.dsh/dsh-kit-guardian/backups and return the backup id.',
      parameters: { type: 'object', additionalProperties: false, properties: { profile: { type: 'string' } } },
      async execute(args) { return JSON.stringify(await backupProfile(args && args.profile), null, 2) },
    },
    {
      name: 'plugin_rollback',
      description: 'Restore a profile from a guardian backup after validating the backup manifest; the current state is backed up first.',
      parameters: { type: 'object', additionalProperties: false, properties: { backup: { type: 'string' }, profile: { type: 'string' } }, required: ['backup'] },
      async execute(args) { return JSON.stringify(await rollback(args && args.backup, args && args.profile), null, 2) },
    },
  ]
  const disposers = table.map((tool) => ctx.tools.register({ ...tool, output: { schema: SCHEMA, render } }))
  return () => { for (const dispose of disposers) dispose() }
}

function makeRoutes() {
  return [
    {
      kind: 'exact',
      path: API + '/scan',
      handler: async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' })
        const url = new URL(req.url || '/', 'http://localhost')
        sendJson(res, 200, await health(url.searchParams.get('profile') || ''))
      },
    },
    {
      kind: 'exact',
      path: API + '/backups',
      handler: async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' })
        sendJson(res, 200, { ok: true, backups: await listBackups() })
      },
    },
    {
      kind: 'exact',
      path: API + '/backup',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' })
        try {
          let body = ''
          for await (const chunk of req) body += chunk
          const payload = body ? JSON.parse(body) : {}
          sendJson(res, 200, await backupProfile(payload.profile))
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error && error.message ? error.message : error) })
        }
      },
    },
  ]
}

export function apply(ctx) {
  ctx.inject(['webServer'], (scope) => {
    scope.effect(() => {
      const disposers = makeRoutes().map((route) => scope.webServer.register(route))
      return () => { for (const dispose of disposers) { try { dispose() } catch { /* ignore */ } } }
    }, 'dsh-kit-guardian: routes')
  })
  ctx.inject(['tools'], (tctx) => {
    tctx.effect(() => registerTools(tctx), 'dsh-kit-guardian: tools')
  })
}

export { health, backupProfile, rollback, listBackups }