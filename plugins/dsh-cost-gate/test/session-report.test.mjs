#!/usr/bin/env node
/**
 * 每日账单日期过滤自测（task-30）。
 *
 * 覆盖：默认今天（Asia/Shanghai）、昨天不计、跨零点边界、
 * days:0/all 全量、最近 N 天、空窗口、工具 days 参数。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-gate-window-'))
const sessions = path.join(tmp, 'sessions')
process.env.DSH_SESSIONS_DIR = sessions
process.env.DSH_PRICE_INPUT = '2'
process.env.DSH_PRICE_CACHED = '0.2'
process.env.DSH_PRICE_OUTPUT = '3'
process.chdir(tmp)

const NOW = '2026-11-09T12:00:00+08:00'
const YESTERDAY = '2026-11-08T23:59:59+08:00'
const TODAY_START = '2026-11-09T00:00:00+08:00'
const TODAY_END = '2026-11-09T23:59:59+08:00'
const TOMORROW = '2026-11-10T00:00:00+08:00'

function writeSession(dir, id, records) {
  const base = path.join(sessions, dir)
  fs.mkdirSync(base, { recursive: true })
  const lines = [JSON.stringify({ type: 'session', version: 4, id })]
  for (const record of records) lines.push(JSON.stringify(record))
  fs.writeFileSync(path.join(base, 'session.v4.jsonl'), lines.join('\n') + '\n', 'utf8')
}

function usage(ts, input, cached = 0, output = 0) {
  return {
    type: 'assistant/message',
    ts,
    data: { usage: { inputTokens: input, cacheReadTokens: cached, outputTokens: output } },
  }
}

writeSession('session-aaaaaaaa1111', 'session-aaaaaaaa1111', [
  usage(YESTERDAY, 100),
  usage(TODAY_START, 200),
  usage(TODAY_END, 300),
  usage(TOMORROW, 400),
])
writeSession('session-bbbbbbbb2222', 'session-bbbbbbbb2222', [usage(YESTERDAY, 500)])
writeSession('session-cccccccc3333', 'session-cccccccc3333', [])
writeSession('session-dddddddd4444', 'session-dddddddd4444', [
  // 真实会话使用顶层 time（毫秒），不是 ts。
  { type: 'assistant/message', time: Date.parse('2026-11-09T12:00:00+08:00'), data: { usage: { inputTokens: 50 } } },
])

const { default: sessionReport } = await import('../lib/session-report.cjs')
const checks = []
function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail })
}

const today = sessionReport.dailyReport({ sessionsDir: sessions, zstdAvailable: false, now: NOW })
check('today-default', today.supported === true && today.window.days === 1 && today.sessionsScanned === 4 && today.sessionsIncluded === 2, { window: today.window, scanned: today.sessionsScanned, included: today.sessionsIncluded })
check('today-from-to', today.window.from === '2026-11-08T16:00:00.000Z' && today.window.to === '2026-11-09T16:00:00.000Z', today.window)
check('today-only-window-events', today.totals.input === 550, today.totals)
check('yesterday-not-counted', !today.top.some((item) => item.id === 'session-bbbbbbbb2222'), today.top.map((item) => item.id))
check('midnight-boundary', today.top.length === 2 && today.top[0].id === 'session-aaaaaaaa1111' && today.top[0].input === 500, today.top.map((item) => ({ id: item.id, input: item.input })))
check('today-count', today.sessions === 2, today.sessions)
check('today-text', today.text.includes('今天') && today.text.includes('扫描 4 个会话文件'), today.text.slice(0, 200))

const all = sessionReport.dailyReport({ sessionsDir: sessions, zstdAvailable: false, now: NOW, days: 0 })
check('days-zero-all', all.window.days === 0 && all.window.from === null && all.window.to === null && all.totals.input === 1550 && all.sessionsIncluded === 3, { window: all.window, totals: all.totals, included: all.sessionsIncluded })
const allFlag = sessionReport.dailyReport({ sessionsDir: sessions, zstdAvailable: false, now: NOW, all: true })
check('all-flag', allFlag.window.days === 0 && allFlag.totals.input === 1550, { window: allFlag.window, totals: allFlag.totals })

const twoDays = sessionReport.dailyReport({ sessionsDir: sessions, zstdAvailable: false, now: NOW, days: 2 })
check('days-two', twoDays.window.days === 2 && twoDays.totals.input === 1150 && twoDays.sessionsIncluded === 3, { window: twoDays.window, totals: twoDays.totals, included: twoDays.sessionsIncluded })

const empty = path.join(tmp, 'empty-sessions')
writeSessionAt(empty, 'session-eeeeeeee5555', [usage('2026-11-01T12:00:00+08:00', 900)])
function writeSessionAt(root, dir, records) {
  const base = path.join(root, dir)
  fs.mkdirSync(base, { recursive: true })
  const lines = [JSON.stringify({ type: 'session', version: 4, id: dir })]
  for (const record of records) lines.push(JSON.stringify(record))
  fs.writeFileSync(path.join(base, 'session.v4.jsonl'), lines.join('\n') + '\n', 'utf8')
}
const emptyReport = sessionReport.dailyReport({ sessionsDir: empty, zstdAvailable: false, now: NOW })
check('empty-window', emptyReport.supported === true && emptyReport.totals.cny === 0 && emptyReport.sessionsIncluded === 0 && emptyReport.top.length === 0, { totals: emptyReport.totals, included: emptyReport.sessionsIncluded })

// 宿主无 zstd 时走 Node helper；坏帧只记读取失败，不整体降级。
const zstdDir = path.join(tmp, 'zstd-sessions')
fs.mkdirSync(path.join(zstdDir, 'session-ffffffff6666'), { recursive: true })
fs.writeFileSync(path.join(zstdDir, 'session-ffffffff6666', 'session.v4.jsonl.zstd'), 'dummy')
const zstd = sessionReport.dailyReport({ sessionsDir: zstdDir, zstdAvailable: false, now: NOW })
check('zstd-fallback-text', zstd.supported === true && zstd.errors === 1 && zstd.text.includes('读取失败'), zstd.text)

const { apply } = await import('../lib/index.js')
let tool = null
apply({
  tools: { register(definition) { tool = definition; return () => {} } },
  effect(fn) { return fn() },
  on() { return () => {} },
})
const viaToday = await tool.execute({ report: 'daily', days: 1, now: NOW })
check('tool-days-today', viaToday.ok === true && viaToday.window.days === 1 && viaToday.sessionsIncluded === 2, { window: viaToday.window, included: viaToday.sessionsIncluded })
const viaAll = await tool.execute({ report: 'daily', days: 0, now: NOW })
check('tool-days-all', viaAll.ok === true && viaAll.window.days === 0 && viaAll.sessionsIncluded === 3, { window: viaAll.window, included: viaAll.sessionsIncluded })

const failed = checks.filter((item) => !item.ok)
console.log(JSON.stringify({ ok: failed.length === 0, checks: checks.length, failed }, null, 2))
process.exit(failed.length === 0 ? 0 : 1)
