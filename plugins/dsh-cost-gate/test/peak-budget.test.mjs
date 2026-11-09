#!/usr/bin/env node
/**
 * 峰时预算账本自测（task-16 A/B）。
 *
 * 覆盖：未超、正好 10、超 10 被拒且不写账、跨日逻辑重置、cost_gate status
 * 参数、approve 命中上限返回 blockedByCap 且写交接单（字段齐全）。
 * 使用临时 DSH_HOME 与临时 cwd，不碰真实账本。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-gate-peak-'))
process.env.DSH_HOME = tmp
process.chdir(tmp)
fs.mkdirSync(path.join(tmp, 'docs', 'tmp', 'hub'), { recursive: true })

const peakBudget = (await import('../lib/peak-budget.cjs')).default

const checks = []
function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail })
}

const now = new Date('2026-11-09T02:00:00.000Z') // 10:00 Asia/Shanghai
const window = peakBudget.windowFor(now)
const ledgerFile = peakBudget.ledgerPath()

// 1) 空账本
const fresh = peakBudget.status(now)
check('fresh-zero', fresh.window === window && fresh.spentCNY === 0 && fresh.capCNY === 10 && fresh.remainingCNY === 10, fresh)
check('fresh-reset-at', typeof fresh.resetAt === 'string' && !Number.isNaN(Date.parse(fresh.resetAt)), fresh.resetAt)

// 2) 未超
const first = peakBudget.charge(3, { planId: 'p1', now })
check('charge-under-cap', first.ok === true && first.spentCNY === 3 && first.remainingCNY === 7, first)

// 3) 正好 10 放行
const exact = peakBudget.charge(7, { planId: 'p2', now })
check('charge-exact-cap', exact.ok === true && exact.spentCNY === 10 && exact.remainingCNY === 0, exact)

// 4) 超 10 被拒且不写账
const over = peakBudget.charge(0.01, { planId: 'p3', now })
check('charge-over-cap', over.ok === false && over.code === 'peak-cap' && over.spentCNY === 10 && over.remainingCNY === 0, over)
const stored = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'))
check('ledger-unchanged-on-reject', stored.spentCents === 1000 && stored.entries.length === 2, stored)
check('ledger-entry-cents', stored.entries.every((e) => typeof e.ts === 'string' && 'planId' in e && Number.isInteger(e.totalPeakCents)), stored.entries)

// 5) 跨日逻辑重置
fs.writeFileSync(ledgerFile, JSON.stringify({
  window: '2000-01-01',
  spentCNY: 99,
  entries: [{ ts: '2000-01-01T00:00:00.000Z', planId: 'old', totalPeakCNY: 99 }],
}), 'utf8')
const nextDay = peakBudget.status(now)
check('window-reset', nextDay.window === window && nextDay.spentCNY === 0 && nextDay.remainingCNY === 10, nextDay)
const afterReset = peakBudget.charge(1, { planId: 'p4', now })
check('charge-after-reset', afterReset.ok === true && afterReset.spentCNY === 1, afterReset)

// 6) 金额整数分：0.1 + 0.2 不应出现浮点尾数
fs.rmSync(ledgerFile, { force: true })
const centA = peakBudget.charge(0.1, { planId: 'cent-a', now })
const centB = peakBudget.charge(0.2, { planId: 'cent-b', now })
const centStatus = peakBudget.status(now)
check('cents-0.1+0.2', centA.ok === true && centB.ok === true && centStatus.spentCNY === 0.3 && centStatus.remainingCNY === 9.7, centStatus)
const centLedger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'))
check('cents-integer-ledger', centLedger.spentCents === 30 && centLedger.entries.every((e) => Number.isInteger(e.totalPeakCents) && e.totalPeakCents > 0), centLedger)

// 7) cost_gate status 参数 + approve 命中上限写交接单
const { apply } = await import('../lib/index.js')
let captured = null
const ctx = {
  tools: { register(def) { captured = def; return () => {} } },
  effect(fn) { return fn() },
  on() { return () => {} },
}
apply(ctx)
check('tool-registered', captured?.name === 'cost_gate', captured?.name)

const statusResult = await captured.execute({ status: true, now: now.toISOString() })
check('tool-status', statusResult.ok === true && statusResult.window === window && statusResult.capCNY === 10 && /峰时预算/.test(statusResult.text), statusResult)

// 把本窗口补满到 10（已有 0.1 + 0.2）
peakBudget.charge(9.7, { planId: 'p5', now })
const capResult = await captured.execute({
  now: now.toISOString(),
  force: true,
  approve: true,
  plan: { tasks: [{ id: 't-finish', name: '收尾', model: 'deepseek-flash', turns: 1, inTokens: 1000, outTokens: 1000 }] },
})
check('approve-blocked-by-cap', capResult.blockedByCap === true && capResult.approved === null && capResult.allowanceMinutes === null, capResult)
check('approve-handoff-path', typeof capResult.handoff === 'string' && fs.existsSync(capResult.handoff), capResult.handoff)
check('approve-handoff-hub-copy', typeof capResult.handoffHub === 'string' && fs.existsSync(capResult.handoffHub), capResult.handoffHub)

const handoff = JSON.parse(fs.readFileSync(capResult.handoff, 'utf8'))
check('handoff-fields', handoff.window === window && handoff.capCNY === 10 && handoff.spentCNY === 10 && handoff.reason === 'peak-cap' && handoff.status === 'unfinished' && typeof handoff.createdAt === 'string' && Array.isArray(handoff.tasks), handoff)
check('handoff-task', handoff.tasks.some((t) => t.id === 't-finish' && typeof t.estPeakCNY === 'number'), handoff.tasks)

const afterCap = peakBudget.status(now)
check('ledger-still-cap', afterCap.spentCNY === 10 && afterCap.remainingCNY === 0, afterCap)

// 8) 交接单 hub 副本失败：主单已写，不抛错，记录 hubError
const hubHandoffDir = path.join(tmp, 'docs', 'tmp', 'hub', 'cost-handoffs')
fs.rmSync(hubHandoffDir, { recursive: true, force: true })
fs.writeFileSync(hubHandoffDir, 'not-a-dir', 'utf8')
const hubFail = await captured.execute({
  now: now.toISOString(),
  force: true,
  approve: true,
  plan: { tasks: [{ id: 't-hub-fail', name: 'hub 失败', model: 'deepseek-flash', turns: 1, inTokens: 1000, outTokens: 1000 }] },
})
check('handoff-hub-failure-keeps-primary', hubFail.blockedByCap === true && typeof hubFail.handoff === 'string' && fs.existsSync(hubFail.handoff) && hubFail.handoffHub === null && typeof hubFail.handoffHubError === 'string', hubFail)
fs.rmSync(hubHandoffDir, { force: true })

// 9) 主交接单写失败（DSH_HOME 指向文件）：仍返回 deny，不抛错
const badHome = path.join(tmp, 'home-is-a-file')
fs.writeFileSync(badHome, 'x', 'utf8')
process.env.DSH_HOME = badHome
const primaryFail = await captured.execute({
  now: now.toISOString(),
  force: true,
  approve: true,
  plan: { tasks: [{ id: 't-write-fail', name: '写失败', model: 'deepseek-flash', turns: 1, inTokens: 1000, outTokens: 1000 }] },
})
process.env.DSH_HOME = tmp
check('handoff-primary-failure-does-not-throw', primaryFail.blockedByCap === true && primaryFail.handoff === null && typeof primaryFail.handoffError === 'string' && /失败/.test(primaryFail.text), primaryFail)

const failed = checks.filter((c) => !c.ok)
const out = { ok: failed.length === 0, checks: checks.length, passed: checks.length - failed.length, failed: failed.map((c) => c.name), tmp }
console.log(JSON.stringify(out, null, 2))
if (failed.length) console.log(JSON.stringify(failed, null, 2))
process.exit(failed.length ? 1 : 0)
