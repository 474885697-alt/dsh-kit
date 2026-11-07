/**
 * dsh-rulebook - turn a rulebook document into structured JSON.
 */
import { readFile } from 'node:fs/promises'
import { inflateRawSync } from 'node:zlib'
import { extname } from 'node:path'

export const name = 'rulebook'
export const inject = []

const API = '/api/dsh-rulebook'
const HEADING = /^(第[一二三四五六七八九十百零]+[章节篇]|[一二三四五六七八九十]+[、.．]|#{1,4}\s)/
const NUMBERED = /^[\s\-•·]*(\d+[.、)）]|[（(]\d+[)）]|[①②③④⑤⑥⑦⑧⑨⑩])/

function stripXml(xml) {
  return xml
    .replace(/<w:p[^>]*>/g, '\n')
    .replace(/<w:tab[^>]*\/>/g, '\t')
    .replace(/<w:br[^>]*\/>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/\n{2,}/g, '\n')
}

export function readDocxText(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('不是有效的 docx（找不到 zip 目录）')
  const count = buf.readUInt16LE(eocd + 10)
  let offset = buf.readUInt32LE(eocd + 16)
  const parts = []
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) break
    const method = buf.readUInt16LE(offset + 10)
    const compSize = buf.readUInt32LE(offset + 20)
    const nameLen = buf.readUInt16LE(offset + 28)
    const extraLen = buf.readUInt16LE(offset + 30)
    const commentLen = buf.readUInt16LE(offset + 32)
    const localOffset = buf.readUInt32LE(offset + 42)
    const entryName = buf.subarray(offset + 46, offset + 46 + nameLen).toString('utf8')
    if (/^word\/document.*\.xml$/.test(entryName)) {
      const localNameLen = buf.readUInt16LE(localOffset + 26)
      const localExtraLen = buf.readUInt16LE(localOffset + 28)
      const dataStart = localOffset + 30 + localNameLen + localExtraLen
      const data = buf.subarray(dataStart, dataStart + compSize)
      parts.push(method === 0 ? data.toString('utf8') : inflateRawSync(data).toString('utf8'))
    }
    offset += 46 + nameLen + extraLen + commentLen
  }
  if (!parts.length) throw new Error('docx 里没有 word/document.xml')
  return stripXml(parts.join('\n'))
}

export function extractRules(text, source) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const title = lines[0] || ''
  const chapters = []
  const clauses = []
  const numbers = []
  const tables = []
  let currentChapter = ''
  for (const line of lines) {
    const numbered = NUMBERED.test(line)
    const isHeading = !numbered && HEADING.test(line) && line.length <= 40
    if (isHeading) {
      currentChapter = line
      chapters.push({ title: line, index: chapters.length + 1 })
      continue
    }
    if (numbered) clauses.push({ chapter: currentChapter, text: line, index: clauses.length + 1 })
    for (const m of line.matchAll(/([\u4e00-\u9fa5A-Za-z]{2,10})\s*[：:]\s*(-?\d+(?:\.\d+)?)\s*(%|点|格|米|个|张|枚|次|回合)?/g)) {
      numbers.push({ chapter: currentChapter, label: m[1], value: Number(m[2]), unit: m[3] || '' })
    }
    if ((line.match(/\|/g) || []).length >= 2 || (line.match(/\t/g) || []).length >= 2) {
      tables.push({ chapter: currentChapter, row: line.split(/\t+|\s*\|\s*/).filter(Boolean) })
    }
  }
  return { source: source || '', title, chapters, clauses, numbers, tables }
}

export function checkRules(rules) {
  const issues = []
  const seen = new Map()
  for (const c of rules.clauses || []) {
    const key = c.text.replace(/\s+/g, '')
    if (seen.has(key)) issues.push({ level: 'warn', message: '重复条目：' + c.text.slice(0, 30) })
    seen.set(key, true)
  }
  const byLabel = new Map()
  for (const n of rules.numbers || []) {
    if (!byLabel.has(n.label)) byLabel.set(n.label, [])
    byLabel.get(n.label).push(n.value)
  }
  for (const [label, values] of byLabel) {
    const unique = [...new Set(values)]
    if (unique.length > 3) issues.push({ level: 'info', message: '属性「' + label + '」出现 ' + unique.length + ' 个不同取值，确认不是不同章节的同名属性' })
  }
  if (!rules.chapters.length) issues.push({ level: 'warn', message: '没有识别到章节标题，检查标题格式（第一章节 / 一、 / 1. / # 标题）' })
  if (!rules.numbers.length) issues.push({ level: 'warn', message: '没有识别到「属性：数值」形式的数值，确认规则书使用中文冒号或英文冒号' })
  return { ok: issues.filter((i) => i.level !== 'info').length === 0, issues, stats: { chapters: rules.chapters.length, clauses: rules.clauses.length, numbers: rules.numbers.length, tables: rules.tables.length } }
}

export async function extractFile(path) {
  if (!path) throw new Error('需要 path')
  const ext = extname(path).toLowerCase()
  const buffer = await readFile(path)
  if (ext === '.docx') return extractRules(readDocxText(buffer), path)
  if (ext === '.txt' || ext === '.md' || ext === '.markdown') return extractRules(buffer.toString('utf8'), path)
  throw new Error('只支持 .docx / .txt / .md：' + path)
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
      path: API + '/extract',
      handler: async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' })
        const url = new URL(req.url || '/', 'http://localhost')
        try { sendJson(res, 200, { ok: true, rules: await extractFile(url.searchParams.get('path') || '') }) } catch (error) { sendJson(res, 400, { ok: false, error: String(error.message || error) }) }
      },
    },
  ]
}

const OUT = { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] }

function registerTools(ctx) {
  const tools = [
    {
      name: 'rulebook_extract',
      description: 'Extract chapters, numbered clauses, keyword-number pairs and table rows from a .docx/.txt/.md rulebook.',
      parameters: { type: 'object', additionalProperties: false, properties: { path: { type: 'string' } }, required: ['path'] },
      async execute(args) { return JSON.stringify(await extractFile(args.path), null, 2) },
    },
    {
      name: 'rulebook_check',
      description: 'Sanity-check a rulebook document: duplicated clauses, attributes with too many values, missing chapters or numbers.',
      parameters: { type: 'object', additionalProperties: false, properties: { path: { type: 'string' } }, required: ['path'] },
      async execute(args) {
        const rules = await extractFile(args.path)
        return JSON.stringify(checkRules(rules), null, 2)
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
    }, 'dsh-rulebook: routes')
  })
  ctx.inject(['tools'], (tctx) => { tctx.effect(() => registerTools(tctx), 'dsh-rulebook: tools') })
}