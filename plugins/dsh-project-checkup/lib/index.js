/**
 * dsh-project-checkup - host half.
 *
 * A configurable project checkup service.  Nothing about the project is
 * hard-coded here: checks come from a JSON profile, auto-detected defaults, or
 * a per-scan `dir` argument, so the same plugin works for any workspace.
 *
 * Profile lookup order (first hit wins):
 *   1. <dir>/dsh-checkup.json            (per-project, committed with the repo)
 *   2. ~/.dsh/dsh-project-checkup/checks.json
 *   3. auto-detected defaults for <dir>
 */
import { access, readFile, readdir, stat } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { homedir } from 'node:os'

export const name = 'project-checkup'
export const inject = ['webServer']

const API = '/api/dsh-project-checkup'
const execFileAsync = promisify(execFile)
const PROFILE_FILES = ['dsh-checkup.json', '.dsh-checkup.json']
const GLOBAL_CONFIG = 'checks.json'
const MAX_CHECKS = 60
// 默认只此一处；可用环境变量 SEEKER_URL 覆盖（如隔离端口 3120）。
const DEFAULT_SEEKER_URL = 'http://127.0.0.1:3000'

function baseUrl() {
  return (process.env.SEEKER_URL || DEFAULT_SEEKER_URL).replace(/\/+$/, '')
}

function expandUrl(raw) {
  return String(raw || '').replace(/\$\{?SEEKER_URL\}?/g, baseUrl())
}

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

function check(id, label, status, detail, extra) {
  return { id, label, status, detail: String(detail || ''), ...(extra ? { extra } : {}) }
}

async function exists(path) {
  try { await access(path); return true } catch { return false }
}

async function isDirectory(path) {
  try { return (await stat(path)).isDirectory() } catch { return false }
}

async function readJsonFile(path) {
  try { return JSON.parse(await readFile(path, 'utf8')) } catch { return null }
}

async function runNode(args, cwd, timeout = 45000) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, args, { cwd, timeout, windowsHide: true })
    return { ok: true, out: `${stdout || ''}${stderr || ''}`.trim() }
  } catch (error) {
    return { ok: false, out: `${error.stdout || ''}${error.stderr || error.message || error}`.trim() }
  }
}

function resolveDir(input) {
  if (!input) return null
  const raw = String(input).trim()
  if (!raw) return null
  return isAbsolute(raw) ? raw : resolve(raw)
}

/** Candidate project directories, most specific first. */
async function candidateDirs(explicit) {
  const list = []
  const push = (value) => {
    const dir = resolveDir(value)
    if (dir && !list.includes(dir)) list.push(dir)
  }
  push(explicit)
  const config = await readJsonFile(join(dshHome(), 'dsh-project-checkup', 'config.json'))
  if (config) {
    push(config.projectDir)
    push(config.dir)
  }
  push(process.env.DSH_PROJECT_CHECKUP_DIR)
  const cwd = process.cwd()
  if (cwd && (await exists(join(cwd, 'dsh-checkup.json')) || await exists(join(cwd, 'package.json')))) push(cwd)
  push(homedir())
  return list
}

async function findProfile(dir) {
  for (const file of PROFILE_FILES) {
    const path = join(dir, file)
    const data = await readJsonFile(path)
    if (data && typeof data === 'object') return { data, path }
  }
  const globalPath = join(dshHome(), 'dsh-project-checkup', GLOBAL_CONFIG)
  const globalData = await readJsonFile(globalPath)
  if (globalData && typeof globalData === 'object') return { data: globalData, path: globalPath }
  return null
}

/* ------------------------------------------------------------------ */
/* check executors                                                     */
/* ------------------------------------------------------------------ */

function normalizeSpec(spec, index) {
  if (!spec || typeof spec !== 'object') return null
  const type = String(spec.type || 'file')
  return {
    type,
    id: String(spec.id || `${type}-${index + 1}`),
    label: String(spec.label || spec.id || `${type} ${spec.path || spec.url || ''}`.trim()),
    path: spec.path ? String(spec.path) : '',
    url: spec.url ? String(spec.url) : '',
    pattern: spec.pattern ? String(spec.pattern) : '',
    when: spec.when ? String(spec.when) : 'warn',
    min: Number.isFinite(spec.min) ? spec.min : 0,
    expect: Number.isFinite(spec.expect) ? spec.expect : 200,
    script: spec.script ? String(spec.script) : '',
    cmd: spec.cmd ? String(spec.cmd) : '',
    args: Array.isArray(spec.args) ? spec.args.map(String) : [],
    timeout: Number.isFinite(spec.timeout) ? spec.timeout : 45000,
    note: spec.note ? String(spec.note) : '',
    message: spec.message ? String(spec.message) : '',
    status: spec.status ? String(spec.status) : '',
    group: spec.group ? String(spec.group) : '',
    optional: Boolean(spec.optional || spec.note === 'optional'),
  }
}

async function runChecker(spec, dir) {
  const target = spec.path ? (isAbsolute(spec.path) ? spec.path : join(dir, spec.path)) : ''
  const rel = spec.path || target

  switch (spec.type) {
    case 'file': {
      const ok = await exists(target)
      return check(spec.id, spec.label, ok ? 'pass' : (spec.note ? 'warn' : 'fail'), ok ? rel : `缺少 ${rel}`)
    }
    case 'dir': {
      const ok = await isDirectory(target)
      return check(spec.id, spec.label, ok ? 'pass' : 'fail', ok ? rel : `缺少目录 ${rel}`)
    }
    case 'json': {
      const data = await readJsonFile(target)
      return check(spec.id, spec.label, data ? 'pass' : 'fail', data ? `${Array.isArray(data) ? data.length + ' 项' : '可解析'}` : `无法解析 ${rel}`)
    }
    case 'syntax': {
      if (!(await exists(target))) return check(spec.id, spec.label, 'skip', `文件不存在：${rel}`)
      const result = await runNode(['--check', target], dir, spec.timeout)
      return check(spec.id, spec.label, result.ok ? 'pass' : 'fail', result.ok ? '通过' : result.out.slice(0, 600))
    }
    case 'script': {
      if (!(await exists(target))) return check(spec.id, spec.label, 'skip', `文件不存在：${rel}`)
      const result = await runNode([target, ...spec.args], dir, spec.timeout)
      return check(spec.id, spec.label, result.ok ? 'pass' : 'fail', result.out.slice(0, 600))
    }
    case 'note':
      return check(spec.id, spec.label, spec.status || 'warn', spec.message || spec.note || '')
    case 'npm': {
      const name = spec.script || spec.args[0]
      if (!name) return check(spec.id, spec.label, 'skip', '未指定 npm script')
      if (!/^[A-Za-z0-9:_-]+$/.test(name)) return check(spec.id, spec.label, 'skip', `非法 script 名：${name}`)
      try {
        const options = { cwd: dir, timeout: spec.timeout, windowsHide: true }
        const result = process.platform === 'win32'
          ? await execFileAsync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `npm run ${name}`], options)
          : await execFileAsync('npm', ['run', name], options)
        return check(spec.id, spec.label, 'pass', `${(result.stdout || '').trim().slice(0, 400)}`)
      } catch (error) {
        return check(spec.id, spec.label, 'fail', `${(error.stdout || '')}${(error.stderr || error.message || '')}`.slice(0, 600))
      }
    }
    case 'http': {
      if (!spec.url) return check(spec.id, spec.label, 'skip', '未指定 url')
      const url = expandUrl(spec.url)
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(spec.timeout > 45000 ? 45000 : spec.timeout) })
        const ok = response.status === spec.expect
        return check(spec.id, spec.label, ok ? 'pass' : 'fail', `${url} → HTTP ${response.status}（期望 ${spec.expect}）`)
      } catch (error) {
        return check(spec.id, spec.label, 'fail', `${url} 未响应：${error.message}`)
      }
    }
    case 'adb': {
      const adb = process.env.ADB || (process.platform === 'win32' ? 'adb.exe' : 'adb')
      try {
        const result = await execFileAsync(adb, ['devices'], { cwd: dir, timeout: spec.timeout, windowsHide: true })
        const devices = String(result.stdout || '').split(/\r?\n/).filter((line) => /\tdevice$/.test(line.trim()) || /\sdevice$/.test(line.trim()))
        return devices.length
          ? check(spec.id, spec.label, 'pass', `${devices.length} 台设备在线`)
          : check(spec.id, spec.label, 'unverified', '无在线设备（未验证，不算失败）')
      } catch {
        return check(spec.id, spec.label, 'unverified', '未找到 adb（未验证，不算失败）')
      }
    }
    case 'count': {
      const scanDir = spec.path ? target : dir
      let files = []
      try {
        files = await readdir(scanDir)
      } catch {
        return check(spec.id, spec.label, 'warn', `无法读取 ${scanDir}`)
      }
      const regex = spec.pattern ? new RegExp(spec.pattern, 'i') : null
      const matched = regex ? files.filter((file) => regex.test(file)) : files
      const ok = matched.length >= spec.min
      return check(spec.id, spec.label, ok ? 'pass' : 'warn', `${matched.length} 个（下限 ${spec.min}）`)
    }
    case 'scan': {
      let text = ''
      try {
        text = await readFile(target, 'utf8')
      } catch {
        return check(spec.id, spec.label, 'warn', `文件不存在或不可读：${rel}`)
      }
      if (!spec.pattern) return check(spec.id, spec.label, 'skip', '未指定 pattern')
      const hits = (text.match(new RegExp(spec.pattern, 'g')) || []).length
      return check(spec.id, spec.label, hits ? spec.when : 'pass', hits ? `命中 ${hits} 处` : '未命中')
    }
    case 'todo': {
      let text = ''
      try {
        text = await readFile(target, 'utf8')
      } catch {
        return check(spec.id, spec.label, 'warn', `文件不存在或不可读：${rel}`)
      }
      const hits = (text.match(/\b(TODO|FIXME|XXX)\b/g) || []).length
      return check(spec.id, spec.label, hits ? 'warn' : 'pass', `${hits} 处`)
    }
    case 'command': {
      if (!spec.cmd) return check(spec.id, spec.label, 'skip', '未指定 cmd')
      try {
        const result = await execFileAsync(spec.cmd, spec.args, { cwd: spec.path ? target : dir, timeout: spec.timeout, windowsHide: true })
        return check(spec.id, spec.label, 'pass', `${(result.stdout || '').trim().slice(0, 400)}`)
      } catch (error) {
        return check(spec.id, spec.label, 'fail', `${(error.stdout || '')}${(error.stderr || error.message || '')}`.slice(0, 600))
      }
    }
    default:
      return check(spec.id, spec.label, 'skip', `未知检查类型：${spec.type}`)
  }
}

/* ------------------------------------------------------------------ */
/* auto-detected defaults                                              */
/* ------------------------------------------------------------------ */

async function detectProfile(dir) {
  const quick = []
  const full = []
  const packageJson = await readJsonFile(join(dir, 'package.json'))

  quick.push({ id: 'project-dir', type: 'dir', path: '.', label: '项目目录可访问' })

  let recognised = false

  if (packageJson) {
    recognised = true
    quick.push({ id: 'package-json', type: 'json', path: 'package.json', label: 'package.json 可解析' })
  }

  if (await exists(join(dir, 'index.html'))) {
    recognised = true
    quick.push({ id: 'index', type: 'file', path: 'index.html', label: 'index.html 存在' })
    if (await exists(join(dir, 'tools', 'check-syntax.cjs'))) {
      full.push({ id: 'inline-syntax', type: 'script', path: 'tools/check-syntax.cjs', label: '内联脚本语法' })
    }
    if (await exists(join(dir, 'tools', 'ui-audit.cjs'))) {
      quick.push({ id: 'ui-audit-script', type: 'file', path: 'tools/ui-audit.cjs', label: 'UI 审计脚本存在' })
      full.push({
        id: 'ui-audit',
        type: 'script',
        path: 'tools/ui-audit.cjs',
        label: '响应式/遮挡/弹窗 UI 审计（服务需运行）',
        args: ['--strict', '--json'],
        optional: true,
        timeout: 180000,
      })
    }
    full.push({ id: 'todo', type: 'todo', path: 'index.html', label: '未完成标记' })
  }

  for (const file of ['server.js', 'src/index.js', 'main.js']) {
    if (await exists(join(dir, file))) {
      recognised = true
      quick.push({ id: file.replace(/[\\/.]/g, '-'), type: 'file', path: file, label: `${file} 存在` })
      full.push({ id: `${file.replace(/[\\/.]/g, '-')}-syntax`, type: 'syntax', path: file, label: `${file} 语法` })
    }
  }

  if (await exists(join(dir, '.git'))) {
    recognised = true
    quick.push({ id: 'git', type: 'dir', path: '.git', label: 'Git 仓库' })
  }
  if (await exists(join(dir, 'README.md'))) {
    recognised = true
    quick.push({ id: 'readme', type: 'file', path: 'README.md', label: 'README 存在', note: 'optional' })
  }

  if (!recognised) {
    quick.push({
      id: 'no-profile',
      type: 'note',
      label: '未识别到项目特征',
      message: 'package.json / index.html / .git / README 都没有；可在项目根目录放 dsh-checkup.json 自定义检查项',
      status: 'warn',
    })
  }

  return {
    name: packageJson?.name ? String(packageJson.name) : basename(dir),
    dir,
    quick: quick.slice(0, MAX_CHECKS),
    full: full.slice(0, MAX_CHECKS),
    source: 'auto',
  }
}

async function loadProfile(dir) {
  const found = await findProfile(dir)
  if (found) {
    const data = found.data
    const base = data.dir ? resolveDir(data.dir) || dir : dir
    return {
      name: String(data.name || basename(dir)),
      dir: base,
      quick: Array.isArray(data.quick) ? data.quick : [],
      full: Array.isArray(data.full) ? data.full : [],
      source: found.path,
      note: data.note ? String(data.note) : '',
    }
  }
  return detectProfile(dir)
}

/* ------------------------------------------------------------------ */
/* scan                                                                */
/* ------------------------------------------------------------------ */

async function scan(scope = 'quick', explicitDir, group = '') {
  const candidates = await candidateDirs(explicitDir)
  let profile = null
  for (const dir of candidates) {
    if (!dir) continue
    profile = await loadProfile(dir)
    if (profile && (profile.quick.length || profile.full.length || profile.source === 'auto')) break
  }
  if (!profile) profile = await detectProfile(candidates[candidates.length - 1] || homedir())

  const dir = profile.dir
  const full = scope === 'full'
  const wanted = String(group || '').trim().toLowerCase()
  const specs = (full ? [...profile.quick, ...profile.full] : profile.quick)
    .map((spec, index) => normalizeSpec(spec, index))
    .filter(Boolean)
    .filter((spec) => !wanted || spec.group === wanted)
    .slice(0, MAX_CHECKS)

  const checks = []
  for (const spec of specs) {
    try {
      const result = await runChecker(spec, dir)
      if (spec.optional && result.status === 'fail') {
        result.status = 'warn'
        result.detail = `[可选] ${result.detail}`
      }
      checks.push(result)
    } catch (error) {
      const result = check(spec.id, spec.label, 'fail', String(error.message || error))
      if (spec.optional) {
        result.status = 'warn'
        result.detail = `[可选] ${result.detail}`
      }
      checks.push(result)
    }
  }

  if (!checks.length) {
    checks.push(check('no-checks', '检查项', 'warn', '该项目没有配置检查项，可在项目根目录放 dsh-checkup.json'))
  }

  const pass = checks.filter((item) => item.status === 'pass').length
  const fail = checks.filter((item) => item.status === 'fail').length
  const warn = checks.filter((item) => item.status === 'warn').length
  const skip = checks.filter((item) => item.status === 'skip').length
  const unverified = checks.filter((item) => item.status === 'unverified').length
  const counted = pass + fail + warn + unverified
  return {
    ok: fail === 0,
    scope: full ? 'full' : 'quick',
    group: wanted || null,
    name: profile.name,
    projectDir: dir,
    profileSource: profile.source,
    generatedAt: Date.now(),
    summary: { pass, warn, fail, skip, unverified, total: checks.length, score: Math.round((pass / Math.max(1, counted)) * 100) },
    checks,
  }
}

export { scan }

export function makeRoutes() {
  return [
    {
      kind: 'exact',
      path: `${API}/scan`,
      handler: async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: '只支持 GET' })
        const url = new URL(req.url || '/', 'http://localhost')
        const scope = url.searchParams.get('scope') === 'full' ? 'full' : 'quick'
        const dir = url.searchParams.get('dir') || ''
        const group = url.searchParams.get('group') || ''
        try {
          sendJson(res, 200, await scan(scope, dir, group))
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error.message || error) })
        }
      },
    },
    {
      kind: 'exact',
      path: `${API}/profile`,
      handler: async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: '只支持 GET' })
        const url = new URL(req.url || '/', 'http://localhost')
        const dir = url.searchParams.get('dir') || ''
        try {
          const candidates = await candidateDirs(dir)
          const profile = candidates.length ? await loadProfile(candidates[0]) : null
          sendJson(res, 200, { ok: true, profile, candidates })
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error.message || error) })
        }
      },
    },
  ]
}

export function apply(ctx) {
  const disposers = makeRoutes().map((route) => ctx.webServer.register(route))
  ctx.effect(() => () => {
    for (const dispose of disposers) dispose()
  }, 'dsh-project-checkup: routes')
}
