/**
 * dsh-kit-novel-studio - continuity bible for long-form fiction.
 */
import { access, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const name = 'novel-studio'
export const inject = []

const API = '/api/dsh-kit-novel-studio'
const SECTIONS = ['characters', 'rules', 'timeline', 'glossary', 'chapters']
const AI_SMELL = ['值得注意的是', '综上所述', '不难发现', '赋能', '闭环', '抓手', '质的飞跃', '随着时代的发展', '在这个信息爆炸的时代']

function dshHome() { return process.env.DSH_HOME || join(homedir(), '.dsh') }
function booksDir() { return join(dshHome(), 'dsh-kit-novel-studio', 'books') }
function bookPath(id) { return join(booksDir(), String(id).replace(/[^a-zA-Z0-9_-]/g, '_') + '.json') }

function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

async function exists(p) { try { await access(p); return true } catch { return false } }

function emptyBook(id, name) {
  return { id, name: name || id, updatedAt: Date.now(), characters: [], rules: [], timeline: [], glossary: [], chapters: [] }
}

async function loadBook(id) {
  if (!id) throw new Error('需要 book（书名或 id）')
  const text = await readFile(bookPath(id), 'utf8').catch(() => null)
  if (text === null) throw new Error('没有这本书：' + id + '（先用 novel_book action=create）')
  return JSON.parse(text)
}

async function saveBook(book) {
  await mkdir(booksDir(), { recursive: true })
  book.updatedAt = Date.now()
  await writeFile(bookPath(book.id), JSON.stringify(book, null, 2), 'utf8')
  return book
}

export async function listBooks() {
  let names = []
  try { names = await readdir(booksDir()) } catch { return [] }
  const out = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const text = await readFile(join(booksDir(), name), 'utf8').catch(() => null)
    if (!text) continue
    try {
      const book = JSON.parse(text)
      out.push({
        id: book.id,
        name: book.name,
        updatedAt: book.updatedAt,
        counts: Object.fromEntries(SECTIONS.map((s) => [s, Array.isArray(book[s]) ? book[s].length : 0])),
      })
    } catch {}
  }
  return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
}

export function digest(book, query, maxChars) {
  const limit = maxChars || 4000
  const terms = String(query || '').toLowerCase().split(/[\s,，。]+/).filter((t) => t.length >= 2)
  const pick = (item) => {
    const text = JSON.stringify(item).toLowerCase()
    return !terms.length || terms.some((t) => text.includes(t))
  }
  const lines = []
  lines.push('# ' + (book.name || book.id))
  const chars = (book.characters || []).filter(pick)
  if (chars.length) {
    lines.push('## 人物')
    for (const c of chars) {
      const aliases = c.aliases && c.aliases.length ? '（别名：' + c.aliases.join('、') + '）' : ''
      lines.push('- ' + c.name + aliases + (c.role ? '｜' + c.role : '') + (c.traits ? '｜' + c.traits : '') + (c.notes ? '｜' + c.notes : ''))
    }
  }
  const rules = (book.rules || []).filter(pick)
  if (rules.length) {
    lines.push('## 世界规则')
    for (const r of rules) lines.push('- ' + (r.title || '') + (r.detail ? '：' + r.detail : ''))
  }
  const timeline = (book.timeline || []).filter(pick)
  if (timeline.length) {
    lines.push('## 时间线')
    for (const t of timeline) lines.push('- ' + (t.when || '?') + '｜' + (t.event || ''))
  }
  const glossary = (book.glossary || []).filter(pick)
  if (glossary.length) {
    lines.push('## 术语')
    for (const g of glossary) lines.push('- ' + (g.term || '') + '：' + (g.meaning || ''))
  }
  const chapters = (book.chapters || []).filter(pick)
  if (chapters.length) {
    lines.push('## 章节摘要')
    for (const c of chapters) lines.push('- ' + (c.title || '') + (c.summary ? '：' + c.summary : ''))
  }
  const text = lines.join('\n')
  return text.length > limit ? text.slice(0, limit) + '\n…（已截断）' : text
}

export function checkText(book, text) {
  const issues = []
  const body = String(text || '')
  if (!body.trim()) return { ok: false, issues: [{ level: 'error', message: '正文为空' }] }

  const known = new Set()
  for (const c of book.characters || []) {
    if (c.name) known.add(c.name)
    for (const a of c.aliases || []) known.add(a)
  }
  const candidates = new Set()
  for (const m of body.matchAll(/[\u4e00-\u9fa5]{2,4}(?=说|问|笑|道|看着|走进|转身)/g)) candidates.add(m[0])
  for (const name of candidates) {
    if (known.has(name)) continue
    if (/^(他们|我们|你们|自己|有人|众人|那人|这人)$/.test(name)) continue
    issues.push({ level: 'warn', message: '疑似未登记人物：' + name, hint: '确认是角色就补进 characters，否则可能是笔误。' })
  }

  const timeline = (book.timeline || []).map((t) => String(t.when || '')).filter(Boolean)
  const order = []
  for (const when of timeline) {
    const index = body.indexOf(when)
    if (index >= 0) order.push({ when, index })
  }
  for (let i = 1; i < order.length; i += 1) {
    if (order[i].index < order[i - 1].index) {
      issues.push({ level: 'warn', message: '时间线可能倒置：' + order[i - 1].when + ' 出现在 ' + order[i].when + ' 之后' })
    }
  }

  const sentences = body.split(/[。！？!?]/).map((s) => s.trim()).filter((s) => s.length >= 12)
  const seen = new Map()
  for (const sentence of sentences) {
    if (seen.has(sentence)) issues.push({ level: 'info', message: '重复句：' + sentence.slice(0, 24) + '…' })
    seen.set(sentence, true)
  }

  for (const phrase of AI_SMELL) {
    if (body.includes(phrase)) issues.push({ level: 'info', message: 'AI 腔词组：' + phrase, hint: '可交给 dsh-prose-polish 或 humanizer-zh 处理。' })
  }

  if (body.length > 4000) issues.push({ level: 'info', message: '正文较长（' + body.length + ' 字），建议分段校对。' })
  return { ok: true, issues, stats: { chars: body.length, sentences: sentences.length } }
}

function makeRoutes() {
  return [
    {
      kind: 'exact',
      path: API + '/books',
      handler: async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' })
        sendJson(res, 200, { ok: true, books: await listBooks() })
      },
    },
    {
      kind: 'exact',
      path: API + '/context',
      handler: async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' })
        const url = new URL(req.url || '/', 'http://localhost')
        try {
          const book = await loadBook(url.searchParams.get('book') || '')
          sendJson(res, 200, { ok: true, digest: digest(book, url.searchParams.get('q') || '') })
        } catch (error) { sendJson(res, 404, { ok: false, error: String(error.message || error) }) }
      },
    },
  ]
}

const OUT = { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] }

function registerTools(ctx) {
  const tools = [
    {
      name: 'novel_book',
      description: 'List, create, read or delete a novel project. action=list|create|get|delete.',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: { action: { type: 'string', enum: ['list', 'create', 'get', 'delete'] }, book: { type: 'string' }, name: { type: 'string' } },
        required: ['action'],
      },
      async execute(args) {
        const action = args.action
        if (action === 'list') return JSON.stringify({ ok: true, books: await listBooks() }, null, 2)
        if (action === 'create') {
          const book = emptyBook(args.book, args.name)
          await saveBook(book)
          return JSON.stringify({ ok: true, book }, null, 2)
        }
        if (action === 'get') return JSON.stringify({ ok: true, book: await loadBook(args.book) }, null, 2)
        if (action === 'delete') {
          await rm(bookPath(args.book), { force: true })
          return JSON.stringify({ ok: true, deleted: args.book }, null, 2)
        }
        throw new Error('未知 action：' + action)
      },
    },
    {
      name: 'novel_upsert',
      description: 'Add or update entries in a novel section (characters, rules, timeline, glossary, chapters). entries is a JSON array; matching is by name/term/title/when.',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          book: { type: 'string' },
          section: { type: 'string', enum: SECTIONS },
          entries: { type: 'string', description: 'JSON array of objects' },
          replace: { type: 'boolean', description: 'Replace the whole section instead of merging' },
        },
        required: ['book', 'section', 'entries'],
      },
      async execute(args) {
        const book = await loadBook(args.book)
        const section = args.section
        if (!SECTIONS.includes(section)) throw new Error('未知 section：' + section)
        let items
        try { items = JSON.parse(args.entries) } catch (error) { throw new Error('entries 不是合法 JSON：' + error.message) }
        if (!Array.isArray(items)) throw new Error('entries 必须是数组')
        if (args.replace) book[section] = items
        else {
          const keyOf = (item) => String(item.name || item.term || item.title || item.when || JSON.stringify(item))
          const map = new Map((book[section] || []).map((item) => [keyOf(item), item]))
          for (const item of items) map.set(keyOf(item), { ...(map.get(keyOf(item)) || {}), ...item })
          book[section] = [...map.values()]
        }
        await saveBook(book)
        return JSON.stringify({ ok: true, section, count: book[section].length }, null, 2)
      },
    },
    {
      name: 'novel_context',
      description: 'Return a markdown digest of the setting bible (characters, rules, timeline, glossary, chapter summaries) to paste into a writing prompt.',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: { book: { type: 'string' }, query: { type: 'string', description: 'Only include entries matching these keywords' }, max_chars: { type: 'integer' } },
        required: ['book'],
      },
      async execute(args) {
        const book = await loadBook(args.book)
        return digest(book, args.query, args.max_chars)
      },
    },
    {
      name: 'novel_check',
      description: 'Check a chapter draft against the setting bible: unknown character names, timeline order, repeated sentences and common AI-sounding phrases.',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: { book: { type: 'string' }, text: { type: 'string' } },
        required: ['book', 'text'],
      },
      async execute(args) {
        const book = await loadBook(args.book)
        return JSON.stringify(checkText(book, args.text), null, 2)
      },
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
    }, 'dsh-kit-novel-studio: routes')
  })
  ctx.inject(['tools'], (tctx) => { tctx.effect(() => registerTools(tctx), 'dsh-kit-novel-studio: tools') })
}

export { emptyBook, saveBook, loadBook }