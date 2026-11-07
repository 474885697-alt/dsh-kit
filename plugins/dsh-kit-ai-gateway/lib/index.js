/**
 * dsh-kit-ai-gateway - local key pool with least-used handout.
 */
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

export const name = 'ai-gateway'
export const inject = []

const API = '/api/dsh-kit-ai-gateway'
const PROVIDERS = ['deepseek', 'openai', 'minimax', 'elevenlabs', 'stability', 'custom']

function dshHome() { return process.env.DSH_HOME || join(homedir(), '.dsh') }
function storeDir() { return join(dshHome(), 'dsh-kit-ai-gateway') }
function storePath() { return join(storeDir(), 'keys.json') }

function mask(key) {
  const text = String(key || '')
  if (text.length <= 12) return '***'
  return text.slice(0, 5) + '***' + text.slice(-4)
}

async function loadStore() {
  const text = await readFile(storePath(), 'utf8').catch(() => null)
  if (!text) return { version: 1, keys: [] }
  const data = JSON.parse(text)
  if (!Array.isArray(data.keys)) data.keys = []
  return data
}

async function saveStore(store) {
  await mkdir(storeDir(), { recursive: true })
  await writeFile(storePath(), JSON.stringify(store, null, 2), 'utf8')
  await chmod(storePath(), 0o600).catch(() => {})
}

export async function listKeys(showSecrets) {
  const store = await loadStore()
  return store.keys.map((k) => ({
    id: k.id, provider: k.provider, baseUrl: k.baseUrl || '', model: k.model || '',
    label: k.label || '', enabled: k.enabled !== false, usedCount: k.usedCount || 0,
    lastUsedAt: k.lastUsedAt || null, key: showSecrets ? k.key : mask(k.key),
  }))
}

export async function addKey(input) {
  const provider = String(input.provider || 'deepseek')
  const key = String(input.key || '').trim()
  if (!key) throw new Error('需要 key')
  const store = await loadStore()
  if (store.keys.some((k) => k.key === key)) throw new Error('这个 key 已经存在')
  const record = {
    id: randomUUID().slice(0, 8), provider, key,
    baseUrl: input.baseUrl || '', model: input.model || '', label: input.label || '',
    enabled: true, usedCount: 0, lastUsedAt: null, createdAt: new Date().toISOString(),
  }
  store.keys.push(record)
  await saveStore(store)
  return { ok: true, key: { ...record, key: mask(record.key) } }
}

export async function removeKey(id) {
  const store = await loadStore()
  const before = store.keys.length
  store.keys = store.keys.filter((k) => k.id !== id)
  if (store.keys.length === before) throw new Error('没有这个 id：' + id)
  await saveStore(store)
  return { ok: true, removed: id, left: store.keys.length }
}

export async function setEnabled(id, enabled) {
  const store = await loadStore()
  const record = store.keys.find((k) => k.id === id)
  if (!record) throw new Error('没有这个 id：' + id)
  record.enabled = Boolean(enabled)
  await saveStore(store)
  return { ok: true, id, enabled: record.enabled }
}

export async function pick(provider) {
  const store = await loadStore()
  const pool = store.keys.filter((k) => k.enabled !== false && (!provider || k.provider === provider))
  if (!pool.length) throw new Error('没有可用 key' + (provider ? '（provider=' + provider + '）' : ''))
  pool.sort((a, b) => (a.usedCount || 0) - (b.usedCount || 0) || String(a.createdAt || '').localeCompare(String(b.createdAt || '')))
  const chosen = pool[0]
  chosen.usedCount = (chosen.usedCount || 0) + 1
  chosen.lastUsedAt = new Date().toISOString()
  await saveStore(store)
  return { ok: true, id: chosen.id, provider: chosen.provider, baseUrl: chosen.baseUrl || '', model: chosen.model || '', key: chosen.key, usedCount: chosen.usedCount }
}

export async function usage() {
  const store = await loadStore()
  const byProvider = {}
  for (const k of store.keys) {
    const bucket = byProvider[k.provider] || (byProvider[k.provider] = { keys: 0, used: 0, enabled: 0, lastUsedAt: null })
    bucket.keys += 1
    bucket.used += k.usedCount || 0
    if (k.enabled !== false) bucket.enabled += 1
    if (k.lastUsedAt && (!bucket.lastUsedAt || k.lastUsedAt > bucket.lastUsedAt)) bucket.lastUsedAt = k.lastUsedAt
  }
  return { ok: true, providers: byProvider, total: store.keys.length }
}

function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

function loopback(req) {
  const addr = String((req.socket && req.socket.remoteAddress) || '')
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1' || addr === ''
}

function makeRoutes() {
  return [
    {
      kind: 'exact',
      path: API + '/pick',
      handler: async (req, res) => {
        if (!loopback(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' })
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' })
        const url = new URL(req.url || '/', 'http://localhost')
        try { sendJson(res, 200, await pick(url.searchParams.get('provider') || '')) } catch (error) { sendJson(res, 404, { ok: false, error: String(error.message || error) }) }
      },
    },
    {
      kind: 'exact',
      path: API + '/status',
      handler: async (req, res) => {
        if (!loopback(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' })
        try { sendJson(res, 200, { ok: true, keys: await listKeys(false), usage: await usage() }) } catch (error) { sendJson(res, 500, { ok: false, error: String(error.message || error) }) }
      },
    },
  ]
}

const OUT = { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] }

function registerTools(ctx) {
  const tools = [
    {
      name: 'gateway_keys',
      description: 'List (masked), add, remove or enable/disable API keys in the local pool. action=list|add|remove|enable|disable.',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['list', 'add', 'remove', 'enable', 'disable'] },
          id: { type: 'string' }, key: { type: 'string' }, provider: { type: 'string' },
          label: { type: 'string' }, baseUrl: { type: 'string' }, model: { type: 'string' },
          show_secrets: { type: 'boolean' },
        },
        required: ['action'],
      },
      async execute(args) {
        if (args.action === 'list') return JSON.stringify({ ok: true, keys: await listKeys(Boolean(args.show_secrets)) }, null, 2)
        if (args.action === 'add') return JSON.stringify(await addKey(args), null, 2)
        if (args.action === 'remove') return JSON.stringify(await removeKey(args.id), null, 2)
        if (args.action === 'enable') return JSON.stringify(await setEnabled(args.id, true), null, 2)
        if (args.action === 'disable') return JSON.stringify(await setEnabled(args.id, false), null, 2)
        throw new Error('未知 action：' + args.action)
      },
    },
    {
      name: 'gateway_pick',
      description: 'Hand out the least-used enabled key for a provider and increment its counter.',
      parameters: { type: 'object', additionalProperties: false, properties: { provider: { type: 'string', enum: PROVIDERS } } },
      async execute(args) { return JSON.stringify(await pick(args.provider || ''), null, 2) },
    },
    {
      name: 'gateway_usage',
      description: 'Usage counters grouped by provider.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      async execute() { return JSON.stringify(await usage(), null, 2) },
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
    }, 'dsh-kit-ai-gateway: routes')
  })
  ctx.inject(['tools'], (tctx) => { tctx.effect(() => registerTools(tctx), 'dsh-kit-ai-gateway: tools') })
}