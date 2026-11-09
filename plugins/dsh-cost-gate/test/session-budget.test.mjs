#!/usr/bin/env node
/**
 * 会话预算守卫自测（task-24 B）。
 *
 * 阈值边界：=阈值不 warn、+1 warn；input 按 inputTokens + cacheReadTokens（上下文总量）。
 * handoff 草稿字段与路径；session 不存在报错；cost_gate sessionId 接线。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-gate-session-'))
const sessions = path.join(tmp, 'sessions')
process.env.DSH_SESSIONS_DIR = sessions
process.chdir(tmp)

function writeSession(dir, id, title, usages) {
  const base = path.join(sessions, dir)
  fs.mkdirSync(base, { recursive: true })
  const lines = [JSON.stringify({ type: 'session', version: 4, id })]
  if (title) lines.push(JSON.stringify({ type: 'session/title', data: { title } }))
  for (const item of usages) {
    lines.push(JSON.stringify({
      type: 'assistant/message',
      data: { usage: { inputTokens: item.input, cacheReadTokens: item.cached, outputTokens: item.output } },
    }))
  }
  fs.writeFileSync(path.join(base, 'session.v4.jsonl'), lines.join('\n') + '\n', 'utf8')
}

writeSession('session-dddddddd4444', 'session-dddddddd4444', 'Budget Test', [
  { input: 150000, cached: 50000, output: 1000 },
])
writeSession('session-eeeeeeee5555', 'session-eeeeeeee5555', 'Just Over', [
  { input: 150001, cached: 50000, output: 1000 },
])

const { default: sessionReport } = await import('../lib/session-report.cjs')
const checks = []
function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail })
}

const exact = sessionReport.sessionBudget('session-dddddddd4444', {
  sessionsDir: sessions,
  zstdAvailable: false,
  threshold: 150000,
})
check('boundary-equal', exact.tokens === 150000 && exact.warn === false, { tokens: exact.tokens, warn: exact.warn })
check('boundary-breakdown', exact.inputTokens === 150000 && exact.cachedTokens === 50000 && exact.contextTokens === 200000 && exact.outputTokens === 1000 && exact.requests === 1, exact)
check('boundary-cost', exact.cny === 0.313, exact.cny)
check('boundary-short-id', exact.shortId === 'dddddddd', exact.shortId)

const over = sessionReport.sessionBudget('session-eeeeeeee5555', {
  sessionsDir: sessions,
  zstdAvailable: false,
  threshold: 150000,
})
check('boundary-plus-one', over.tokens === 150001 && over.warn === true, { tokens: over.tokens, warn: over.warn })
check('warn-text', over.text.includes('已超阈值') && over.text.includes('input 150001'), over.text)

// 环境变量阈值
process.env.DSH_SESSION_WARN_TOKENS = '150000'
const byEnv = sessionReport.sessionBudget('session-dddddddd4444', { sessionsDir: sessions, zstdAvailable: false })
check('env-threshold', byEnv.threshold === 150000 && byEnv.warn === false, { threshold: byEnv.threshold, warn: byEnv.warn })
delete process.env.DSH_SESSION_WARN_TOKENS

// handoff 草稿
const withHandoff = sessionReport.sessionBudget('session-dddddddd4444', {
  sessionsDir: sessions,
  zstdAvailable: false,
  handoff: true,
})
const handoffFile = path.join(tmp, 'docs', 'tmp', 'handoff-dddddddd.md')
check('handoff-path', withHandoff.handoff === handoffFile && fs.existsSync(handoffFile), withHandoff.handoff)
const draft = fs.readFileSync(handoffFile, 'utf8')
const lines = draft.split('\n')
check('handoff-headings', ['## 目标', '## 已完成', '## 待做', '## 下一步'].every((heading) => draft.includes(heading)), draft.slice(0, 300))
check('handoff-content', draft.includes('Budget Test') && draft.includes('150000') && draft.includes('session-dddddddd4444'), draft.slice(0, 300))
check('handoff-40-lines', lines.length <= 40, lines.length)

// session 不存在
let missingError = null
try {
  sessionReport.sessionBudget('session-ffffffff6666', { sessionsDir: sessions, zstdAvailable: false })
} catch (error) {
  missingError = error
}
check('missing-session', missingError && missingError.code === 'session-not-found' && /不存在/.test(missingError.message), missingError?.message)

// cost_gate 工具接线
const { apply } = await import('../lib/index.js')
let tool = null
apply({
  tools: { register(definition) { tool = definition; return () => {} } },
  effect(fn) { return fn() },
  on() { return () => {} },
})
const viaTool = await tool.execute({ sessionId: 'session-dddddddd4444', handoff: true })
check('tool-session', viaTool.ok === true && viaTool.tokens === 150000 && viaTool.warn === false && viaTool.handoff === handoffFile, viaTool)
const toolMissing = await tool.execute({ sessionId: 'session-ffffffff6666' })
check('tool-missing', toolMissing.ok === false && toolMissing.code === 'session-not-found', toolMissing)

const failed = checks.filter((item) => !item.ok)
console.log(JSON.stringify({ ok: failed.length === 0, checks: checks.length, failed }, null, 2))
process.exit(failed.length === 0 ? 0 : 1)
