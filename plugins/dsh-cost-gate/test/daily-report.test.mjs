#!/usr/bin/env node
/**
 * 每日账单自测（task-24 A）。
 *
 * 3 个未压缩 .jsonl 夹具：聚合 input/cached/output、单价、Top 10 排序；
 * 存在 .zstd 且 zstd 不可用时 supported:false；cost_gate report=daily 接线。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-gate-daily-'))
const sessions = path.join(tmp, 'sessions')
process.env.DSH_SESSIONS_DIR = sessions
process.env.DSH_PRICE_INPUT = '2'
process.env.DSH_PRICE_CACHED = '0.2'
process.env.DSH_PRICE_OUTPUT = '3'
process.chdir(tmp)

function writeSession(dir, id, title, records) {
  const base = path.join(sessions, dir)
  fs.mkdirSync(base, { recursive: true })
  const lines = [JSON.stringify({ type: 'session', version: 4, id })]
  if (title) lines.push(JSON.stringify({ type: 'session/title', data: { title } }))
  for (const record of records) lines.push(JSON.stringify(record))
  fs.writeFileSync(path.join(base, 'session.v4.jsonl'), lines.join('\n') + '\n', 'utf8')
}

function usage(input, cached, output) {
  return {
    type: 'assistant/message',
    ts: new Date().toISOString(),
    data: {
      usage: {
        inputTokens: input,
        cacheReadTokens: cached,
        outputTokens: output,
        totalTokens: input + cached + output,
      },
    },
  }
}

writeSession('session-aaaaaaaa1111', 'session-aaaaaaaa1111', 'Alpha', [
  usage(1000, 500, 100),
  usage(2000, 0, 200),
])
writeSession('session-bbbbbbbb2222', 'session-bbbbbbbb2222', 'Beta', [
  usage(500, 2000, 50),
])
writeSession('session-cccccccc3333', 'session-cccccccc3333', '', [
  usage(100, 0, 10),
])

const { default: sessionReport } = await import('../lib/session-report.cjs')
const checks = []
function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail })
}

const report = sessionReport.dailyReport({ sessionsDir: sessions, zstdAvailable: false })
check('daily-supported-plain', report.supported === true && report.sessions === 3, { supported: report.supported, sessions: report.sessions })
check('daily-totals', report.totals.input === 3600 && report.totals.cached === 2500 && report.totals.output === 360, report.totals)
check('daily-total-cny', report.totals.cny === 0.00878, report.totals.cny)
check('daily-top-order', report.top.map((item) => item.shortId).join(',') === 'aaaaaaaa,bbbbbbbb,cccccccc', report.top.map((item) => item.shortId))
check('daily-top-fields', report.top[0].title === 'Alpha' && report.top[0].requests === 2 && report.top[0].cached === 500 && report.top[0].cny === 0.007, report.top[0])
check('daily-title-missing', report.top[2].title === '', report.top[2].title)
check('daily-text', report.text.includes('每日账单') && report.text.includes('Top 10') && report.text.includes('¥0.0088'), report.text.slice(0, 160))
check('daily-prices', report.prices.input === 2 && report.prices.cached === 0.2 && report.prices.output === 3, report.prices)

// 宿主无 zstd：走 Node helper；坏帧只记读取失败，其余会话照常统计
const compressed = path.join(sessions, 'session-dddddddd4444')
fs.mkdirSync(compressed, { recursive: true })
fs.writeFileSync(path.join(compressed, 'session.v4.jsonl.zstd'), 'dummy', 'utf8')
const missing = sessionReport.dailyReport({ sessionsDir: sessions, zstdAvailable: false })
check('daily-no-zstd', missing.supported === true && missing.errors === 1 && missing.sessions === 3, { supported: missing.supported, errors: missing.errors, sessions: missing.sessions })
check('daily-no-zstd-hint', missing.text.includes('读取失败'), missing.text)
fs.rmSync(compressed, { recursive: true, force: true })

// cost_gate 工具接线（plain 夹具不需要 zstd）
const { apply } = await import('../lib/index.js')
let tool = null
apply({
  tools: { register(definition) { tool = definition; return () => {} } },
  effect(fn) { return fn() },
  on() { return () => {} },
})
check('tool-registered', tool?.name === 'cost_gate', tool?.name)
const viaTool = await tool.execute({ report: 'daily' })
check('tool-daily', viaTool.ok === true && viaTool.supported === true && viaTool.sessions === 3, { ok: viaTool.ok, supported: viaTool.supported, sessions: viaTool.sessions })

const failed = checks.filter((item) => !item.ok)
console.log(JSON.stringify({ ok: failed.length === 0, checks: checks.length, failed }, null, 2))
process.exit(failed.length === 0 ? 0 : 1)
