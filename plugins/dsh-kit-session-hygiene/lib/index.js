/**
 * dsh-kit-session-hygiene - report, archive and (explicitly) delete old DSH sessions.
 */
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const name = 'session-hygiene'
export const inject = []

const API = '/api/dsh-kit-session-hygiene'

function dshHome() { return process.env.DSH_HOME || join(homedir(), '.dsh') }
function sessionsDir() { return join(dshHome(), 'sessions') }
function archiveDir() { return join(dshHome(), 'sessions-archive') }

async function dirSize(dir) {
  let total = 0
  let entries = []
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return 0 }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) total += await dirSize(full)
    else total += (await stat(full).catch(() => ({ size: 0 }))).size
  }
  return total
}

async function collectSessions() {
  const root = sessionsDir()
  const groups = await readdir(root, { withFileTypes: true }).catch(() => [])
  const out = []
  for (const group of groups) {
    if (!group.isDirectory()) continue
    const groupDir = join(root, group.name)
    const sessions = await readdir(groupDir, { withFileTypes: true }).catch(() => [])
    for (const session of sessions) {
      if (!session.isDirectory()) continue
      const sessionDir = join(groupDir, session.name)
      const info = await stat(sessionDir).catch(() => null)
      if (!info) continue
      let done = 0
      let total = 0
      const files = await readdir(sessionDir).catch(() => [])
      for (const file of files) {
        const f = await stat(join(sessionDir, file)).catch(() => null)
        if (!f) continue
        done += 1
        total += f.size
      }
      out.push({ group: group.name, session: session.name, path: sessionDir, bytes: total, files: done, mtime: info.mtimeMs })
    }
  }
  return out.sort((a, b) => b.bytes - a.bytes)
}

function mb(bytes) { return Math.round((bytes / 1024 / 1024) * 10) / 10 }

export async function report(days) {
  const all = await collectSessions()
  const now = Date.now()
  const span = Math.max(1, Number(days) || 30)
  const recent = all.filter((s) => now - s.mtime <= span * 86400000)
  const byGroup = new Map()
  for (const s of all) {
    let bucket = byGroup.get(s.group)
    if (!bucket) { bucket = { group: s.group, sessions: 0, bytes: 0, newest: 0 }; byGroup.set(s.group, bucket) }
    bucket.sessions += 1
    bucket.bytes += s.bytes
    bucket.newest = Math.max(bucket.newest, s.mtime)
  }
  const groups = [...byGroup.values()].sort((a, b) => b.bytes - a.bytes).map((g) => ({ ...g, mb: mb(g.bytes), newestAt: new Date(g.newest).toISOString() }))
  return {
    ok: true,
    sessionsDir: sessionsDir(),
    total: all.length,
    totalMb: mb(all.reduce((n, s) => n + s.bytes, 0)),
    recentDays: span,
    recentCount: recent.length,
    recentMb: mb(recent.reduce((n, s) => n + s.bytes, 0)),
    groups,
    largest: all.slice(0, 10).map((s) => ({ session: s.session, group: s.group, mb: mb(s.bytes), mtime: new Date(s.mtime).toISOString() })),
  }
}

export async function archive(olderThanDays, dryRun) {
  const days = Number(olderThanDays)
  if (!Number.isFinite(days) || days < 1) throw new Error('older_than_days 必须是 >=1 的数字')
  const cutoff = Date.now() - days * 86400000
  const all = await collectSessions()
  const targets = all.filter((s) => s.mtime < cutoff)
  if (dryRun !== false) return { ok: true, dryRun: true, count: targets.length, mb: mb(targets.reduce((n, s) => n + s.bytes, 0)), targets: targets.map((s) => s.path) }
  const stamp = new Date().toISOString().slice(0, 10)
  const moved = []
  for (const target of targets) {
    const dest = join(archiveDir(), stamp, target.group, target.session)
    await mkdir(join(archiveDir(), stamp, target.group), { recursive: true })
    await rename(target.path, dest)
    moved.push({ from: target.path, to: dest })
  }
  return { ok: true, dryRun: false, moved: moved.length, details: moved }
}

export async function removeOld(olderThanDays, confirm, dryRun) {
  if (confirm !== 'DELETE') throw new Error('拒绝对话删除：需要 confirm 传 "DELETE"')
  const days = Number(olderThanDays)
  if (!Number.isFinite(days) || days < 7) throw new Error('older_than_days 至少 7，避免误删近期会话')
  const cutoff = Date.now() - days * 86400000
  const targets = (await collectSessions()).filter((s) => s.mtime < cutoff)
  if (dryRun !== false) return { ok: true, dryRun: true, count: targets.length, targets: targets.map((s) => s.path) }
  for (const target of targets) await rm(target.path, { recursive: true, force: true })
  return { ok: true, dryRun: false, deleted: targets.length }
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
        try { sendJson(res, 200, await report(Number(url.searchParams.get('days') || 30))) } catch (error) { sendJson(res, 500, { ok: false, error: String(error.message || error) }) }
      },
    },
  ]
}

const OUT = { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] }

function registerTools(ctx) {
  const tools = [
    {
      name: 'session_report',
      description: 'Report session storage: count, size, groups by project, largest sessions.',
      parameters: { type: 'object', additionalProperties: false, properties: { days: { type: 'integer' } } },
      async execute(args) { return JSON.stringify(await report(args.days || 30), null, 2) },
    },
    {
      name: 'session_archive',
      description: 'Move sessions older than N days into ~/.dsh/sessions-archive. dry_run defaults to true.',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: { older_than_days: { type: 'integer' }, dry_run: { type: 'boolean' } },
        required: ['older_than_days'],
      },
      async execute(args) { return JSON.stringify(await archive(args.older_than_days, args.dry_run !== false), null, 2) },
    },
    {
      name: 'session_delete',
      description: 'Permanently delete sessions older than N days (minimum 7). Requires confirm="DELETE"; dry_run defaults to true.',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: { older_than_days: { type: 'integer' }, confirm: { type: 'string' }, dry_run: { type: 'boolean' } },
        required: ['older_than_days', 'confirm'],
      },
      async execute(args) { return JSON.stringify(await removeOld(args.older_than_days, args.confirm, args.dry_run !== false), null, 2) },
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
    }, 'dsh-kit-session-hygiene: routes')
  })
  ctx.inject(['tools'], (tctx) => { tctx.effect(() => registerTools(tctx), 'dsh-kit-session-hygiene: tools') })
}