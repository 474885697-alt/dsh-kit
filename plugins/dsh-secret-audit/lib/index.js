/**
 * dsh-secret-audit - masked local secret scan.
 */
import { access, readFile, readdir, stat } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { homedir } from 'node:os'

export const name = 'secret-audit'
export const inject = []

const API = '/api/dsh-secret-audit'
const MAX_BYTES = 2 * 1024 * 1024
const MAX_FILES = 6000
const MAX_HITS = 300
const TEXT_EXT = new Set(['.json', '.jsonc', '.yaml', '.yml', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.py', '.env', '.txt', '.md', '.ini', '.conf', '.properties', '.xml', '.ps1', '.sh', '.bat', '.cmd', '.toml'])
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.cache', '__pycache__', '.venv', 'venv', '_asar', 'app.asar', '.pnpm-store'])
const PATTERNS = [
  { id: 'deepseek', re: /sk-[A-Za-z0-9]{16,}/g },
  { id: 'openai-project', re: /sk-proj-[A-Za-z0-9_-]{20,}/g },
  { id: 'github', re: /gh[pousr]_[A-Za-z0-9]{30,}/g },
  { id: 'aws', re: /AKIA[0-9A-Z]{16}/g },
  { id: 'bearer', re: /Bearer\s+[A-Za-z0-9._-]{24,}/g },
  { id: 'assigned', re: /(?:api[_-]?key|apikey|secret|token)["']?\s*[:=]\s*["']([A-Za-z0-9_\-]{20,})["']/gi },
]

function dshHome() { return process.env.DSH_HOME || join(homedir(), '.dsh') }

function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

export function mask(value) {
  const s = String(value || '')
  if (s.length <= 12) return s.slice(0, 2) + '***'
  return s.slice(0, 6) + '***' + s.slice(-4)
}

async function exists(p) { try { await access(p); return true } catch { return false } }

async function inGitRepo(file) {
  let dir = dirname(resolve(file))
  for (let i = 0; i < 40; i += 1) {
    if (await exists(join(dir, '.git'))) return true
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return false
}

async function walk(dir, files, budget) {
  if (files.length >= MAX_FILES || budget.left <= 0) return
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    if (files.length >= MAX_FILES || budget.left <= 0) return
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      if (entry.name.startsWith('.')) continue
      await walk(full, files, budget)
      continue
    }
    const ext = extname(entry.name).toLowerCase()
    if (!TEXT_EXT.has(ext) && !/^\.env/i.test(entry.name)) continue
    if (/\.min\.(js|css)$/i.test(entry.name)) continue
    let st
    try { st = await stat(full) } catch { continue }
    if (!st.isFile() || st.size > MAX_BYTES) continue
    budget.left -= st.size
    files.push({ path: full, size: st.size })
  }
}

function matchLine(line, kind) {
  const hits = []
  for (const pattern of PATTERNS) {
    pattern.re.lastIndex = 0
    let m
    while ((m = pattern.re.exec(line))) {
      const raw = m[1] || m[0]
      const value = /Bearer/.test(raw) ? raw.replace(/^Bearer\s+/, '') : raw
      if (value.length < 16) continue
      hits.push({ kind: pattern.id, masked: mask(value), rawLength: value.length })
      if (hits.length > 6) return hits
    }
  }
  return hits
}

export async function scan(roots, options) {
  const opts = options || {}
  const list = (roots && roots.length ? roots : [process.cwd(), dshHome()]).map((r) => resolve(r))
  const budget = { left: 40 * 1024 * 1024 }
  const files = []
  for (const dir of list) if (await exists(dir)) await walk(dir, files, budget)

  const findings = []
  const credentialsFiles = []
  const sharedConfigs = []
  let scanned = 0
  let skippedBinary = 0

  for (const file of files) {
    let text
    try { text = await readFile(file.path, 'utf8') } catch { skippedBinary += 1; continue }
    if (text.includes('\u0000')) { skippedBinary += 1; continue }
    scanned += 1
    const lower = basename(file.path).toLowerCase()
    if (lower === 'ai-configs.json' || lower === 'ai-config.json') {
      try {
        const json = JSON.parse(text)
        const apis = json && json.apis ? json.apis : {}
        const entries = Object.entries(apis).map(([key, value]) => ({
          key,
          shareMode: value && value.shareMode,
          shareLimit: value && value.shareLimit,
          hasKey: Boolean(value && value.apiKey),
        }))
        if (entries.length) sharedConfigs.push({ path: file.path, entries })
      } catch {}
    }
    if (/credential|secret|\.env$/i.test(lower)) credentialsFiles.push(file.path)

    const lines = text.split(/\r?\n/)
    for (let i = 0; i < lines.length; i += 1) {
      if (findings.length >= MAX_HITS) break
      if (lines[i].length < 16) continue
      const hits = matchLine(lines[i], lower)
      for (const hit of hits) {
        findings.push({ file: file.path, line: i + 1, kind: hit.kind, masked: hit.masked, length: hit.rawLength })
      }
    }
  }

  const annotated = []
  for (const finding of findings) {
    if (opts.revealPaths === false) { annotated.push({ ...finding, file: undefined }); continue }
    annotated.push(finding)
  }

  const gitRisk = []
  const seen = new Set()
  for (const finding of annotated) {
    if (!finding.file || seen.has(finding.file)) continue
    seen.add(finding.file)
    if (await inGitRepo(finding.file)) gitRisk.push(finding.file)
  }

  const byFile = {}
  for (const finding of annotated) {
    const key = finding.file || '(hidden)'
    byFile[key] = (byFile[key] || 0) + 1
  }

  return {
    ok: true,
    roots: list,
    scanned,
    skippedBinary,
    files: files.length,
    findings: annotated.slice(0, 120),
    findingCount: annotated.length,
    byFile,
    gitExposedFiles: gitRisk.slice(0, 40),
    credentialsFiles: credentialsFiles.slice(0, 20),
    sharedConfigs,
    advice: buildAdvice(annotated, gitRisk, sharedConfigs),
  }
}

function buildAdvice(findings, gitRisk, sharedConfigs) {
  const advice = []
  if (!findings.length) advice.push('没有发现明文密钥。')
  if (findings.length) advice.push('发现 ' + findings.length + ' 处明文密钥；先确认它们是否真的需要留在磁盘上。')
  if (gitRisk.length) advice.push('有 ' + gitRisk.length + ' 个含密钥的文件位于 git 仓库内，提交前务必移除或改用环境变量。')
  for (const config of sharedConfigs) {
    const open = config.entries.filter((e) => e.shareMode && e.shareMode !== 'closed')
    if (open.length) advice.push(config.path + ' 里有 ' + open.length + ' 个 Key 处于共享状态（shareMode 非 closed），任何能访问该服务的人都可能消耗额度。')
    else advice.push(config.path + ' 里的 Key 共享均已关闭。')
  }
  advice.push('密钥一旦出现在聊天记录、日志或导出的会话里，最稳妥的处理是到平台吊销后重建。')
  return advice
}

function makeRoutes() {
  return [
    {
      kind: 'exact',
      path: API + '/scan',
      handler: async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' })
        const url = new URL(req.url || '/', 'http://localhost')
        const roots = (url.searchParams.get('roots') || '').split(',').map((s) => s.trim()).filter(Boolean)
        try { sendJson(res, 200, await scan(roots)) } catch (error) { sendJson(res, 500, { ok: false, error: String(error) }) }
      },
    },
  ]
}

function registerTools(ctx) {
  const tool = ctx.tools.register({
    name: 'secret_scan',
    description: 'Scan local workspaces for plaintext API keys and key-sharing config. Output is always masked (first 6 / last 4 characters) and flags files inside git repositories.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { roots: { type: 'string', description: 'Comma separated directories, default current workspace + DSH home.' } },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
    async execute(args) {
      const roots = String((args && args.roots) || '').split(',').map((s) => s.trim()).filter(Boolean)
      return JSON.stringify(await scan(roots), null, 2)
    },
  })
  return tool
}

export function apply(ctx) {
  ctx.inject(['webServer'], (scope) => {
    scope.effect(() => {
      const disposers = makeRoutes().map((route) => scope.webServer.register(route))
      return () => { for (const dispose of disposers) { try { dispose() } catch { /* ignore */ } } }
    }, 'dsh-secret-audit: routes')
  })
  ctx.inject(['tools'], (tctx) => { tctx.effect(() => registerTools(tctx), 'dsh-secret-audit: tool') })
}