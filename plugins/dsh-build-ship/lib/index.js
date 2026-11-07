/**
 * dsh-build-ship - build, collect and verify release artifacts.
 */
import { readdir, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { promisify } from 'node:util'

export const name = 'build-ship'
export const inject = []

const API = '/api/dsh-build-ship'
const runAsync = promisify(execFile)

function dshHome() { return process.env.DSH_HOME || join(homedir(), '.dsh') }
function reportsDir() { return join(dshHome(), 'dsh-build-ship', 'reports') }

async function sha256(path) {
  const buffer = await readFile(path)
  return createHash('sha256').update(buffer).digest('hex')
}

export async function build(cwd, command, timeoutMs) {
  if (!cwd) throw new Error('需要 cwd')
  if (!command) throw new Error('需要 build_cmd')
  const started = Date.now()
  try {
    const { stdout, stderr } = await runAsync('cmd.exe', ['/d', '/s', '/c', command], { cwd, timeout: timeoutMs || 600000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 })
    return { ok: true, code: 0, ms: Date.now() - started, out: String(stdout || '').slice(-4000), err: String(stderr || '').slice(-4000) }
  } catch (error) {
    return { ok: false, code: error.code || -1, ms: Date.now() - started, out: String(error.stdout || '').slice(-4000), err: String(error.stderr || error.message || '').slice(-4000) }
  }
}

export async function collect(outDir, expect) {
  const result = { ok: true, files: [], missing: [] }
  let names = []
  try { names = await readdir(outDir) } catch { throw new Error('产物目录不可读：' + outDir) }
  for (const name of names) {
    const full = join(outDir, name)
    const info = await stat(full)
    if (!info.isFile()) continue
    result.files.push({ name, bytes: info.size, sha256: (await sha256(full)).slice(0, 16) })
  }
  for (const wanted of expect || []) {
    if (!result.files.some((f) => f.name === wanted || f.name.startsWith(wanted))) result.missing.push(wanted)
  }
  result.ok = result.missing.length === 0 && result.files.length > 0
  return result
}

export async function ship(options) {
  const { cwd, build_cmd, out_dir, expect } = options || {}
  const report = { startedAt: new Date().toISOString(), cwd, build_cmd, out_dir }
  report.build = await build(cwd, build_cmd, options.timeout_ms)
  if (out_dir) {
    try { report.artifacts = await collect(out_dir, expect) } catch (error) { report.artifacts = { ok: false, error: String(error.message || error), files: [], missing: expect || [] } }
  }
  report.ok = Boolean(report.build.ok && (!report.artifacts || report.artifacts.ok))
  await mkdir(reportsDir(), { recursive: true })
  const file = join(reportsDir(), report.startedAt.replace(/[:.]/g, '-') + '.json')
  await writeFile(file, JSON.stringify(report, null, 2), 'utf8')
  report.reportPath = file
  return report
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
      path: API + '/report',
      handler: async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' })
        const url = new URL(req.url || '/', 'http://localhost')
        const name = url.searchParams.get('name')
        try {
          if (name) return sendJson(res, 200, { ok: true, report: JSON.parse(await readFile(join(reportsDir(), name), 'utf8')) })
          const names = (await readdir(reportsDir()).catch(() => [])).filter((n) => n.endsWith('.json')).sort().reverse().slice(0, 10)
          sendJson(res, 200, { ok: true, reports: names })
        } catch (error) { sendJson(res, 404, { ok: false, error: String(error.message || error) }) }
      },
    },
  ]
}

const OUT = { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] }

function registerTools(ctx) {
  const tools = [
    {
      name: 'ship_build',
      description: 'Run a build command in a project directory and return exit code plus output tail.',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: { cwd: { type: 'string' }, build_cmd: { type: 'string' }, timeout_ms: { type: 'integer' } },
        required: ['cwd', 'build_cmd'],
      },
      async execute(args) { return JSON.stringify(await build(args.cwd, args.build_cmd, args.timeout_ms), null, 2) },
    },
    {
      name: 'ship_collect',
      description: 'List artifacts in a directory with sizes and short hashes; optionally verify expected file names.',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: { out_dir: { type: 'string' }, expect: { type: 'array', items: { type: 'string' } } },
        required: ['out_dir'],
      },
      async execute(args) { return JSON.stringify(await collect(args.out_dir, args.expect), null, 2) },
    },
    {
      name: 'ship_run',
      description: 'Full pipeline: build, collect and verify artifacts, write a report under ~/.dsh/dsh-build-ship/reports.',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: { cwd: { type: 'string' }, build_cmd: { type: 'string' }, out_dir: { type: 'string' }, expect: { type: 'array', items: { type: 'string' } }, timeout_ms: { type: 'integer' } },
        required: ['cwd', 'build_cmd'],
      },
      async execute(args) { return JSON.stringify(await ship(args), null, 2) },
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
    }, 'dsh-build-ship: routes')
  })
  ctx.inject(['tools'], (tctx) => { tctx.effect(() => registerTools(tctx), 'dsh-build-ship: tools') })
}