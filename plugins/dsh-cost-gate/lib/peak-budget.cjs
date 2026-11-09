'use strict'

/**
 * 峰时预算账本（Asia/Shanghai 自然日）。
 *
 * 只统计 cost_gate 放行时记录的估算额，不追溯已经跑起来的任务。
 * 账本：`<DSH_HOME>/dsh-cost-gate/peak-spend.json`
 *   { window: 'YYYY-MM-DD', spentCNY, entries: [{ ts, planId, totalPeakCNY }] }
 *
 * 跨日视为新窗口（逻辑重置，不主动改写旧账）。
 */

const { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } = require('node:fs')
const { join } = require('node:path')
const { homedir } = require('node:os')

const TZ = 'Asia/Shanghai'
const CAP_CNY = 10
const EPS = 1e-9

function baseDir() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'dsh-cost-gate')
}

function ledgerPath() {
  return join(baseDir(), 'peak-spend.json')
}

function windowFor(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date)
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d)
  const get = (type) => parts.find((part) => part.type === type)?.value || ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

function resetAtFor(window) {
  const [year, month, day] = String(window).split('-').map(Number)
  // Asia/Shanghai 固定 UTC+8，无夏令时；下一个本地 00:00 即 UTC 前一日 16:00。
  return new Date(Date.UTC(year, month - 1, day + 1) - 8 * 3600 * 1000).toISOString()
}

function round4(value) {
  return Number(Number(value).toFixed(4))
}

function emptyLedger(window) {
  return { window, spentCNY: 0, entries: [] }
}

function readLedger(now = new Date()) {
  const window = windowFor(now)
  let raw = null
  try {
    raw = JSON.parse(readFileSync(ledgerPath(), 'utf8'))
  } catch {
    return emptyLedger(window)
  }
  const spent = Number(raw?.spentCNY)
  if (raw?.window !== window || !Array.isArray(raw?.entries) || !Number.isFinite(spent) || spent < 0) {
    return emptyLedger(window)
  }
  return { window, spentCNY: round4(spent), entries: raw.entries }
}

function writeLedger(ledger) {
  const dir = baseDir()
  mkdirSync(dir, { recursive: true })
  const file = ledgerPath()
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(ledger, null, 2) + '\n', 'utf8')
    renameSync(tmp, file)
  } catch (error) {
    try { unlinkSync(tmp) } catch { /* ignore */ }
    throw error
  }
}

function status(now = new Date()) {
  const ledger = readLedger(now)
  const spentCNY = round4(ledger.spentCNY)
  const remainingCNY = round4(Math.max(0, CAP_CNY - spentCNY))
  return {
    window: ledger.window,
    spentCNY,
    capCNY: CAP_CNY,
    remainingCNY,
    resetAt: resetAtFor(ledger.window),
  }
}

/**
 * 记一笔放行估算。金额非法或超出上限时不写账。
 * @param {number} amountCNY
 * @param {{ planId?: string, now?: Date }} [meta]
 */
function charge(amountCNY, meta = {}) {
  const amount = Number(amountCNY)
  const now = meta.now instanceof Date ? meta.now : new Date()
  if (!Number.isFinite(amount) || amount < 0) {
    const current = status(now)
    return { ok: false, code: 'invalid-amount', window: current.window, spentCNY: current.spentCNY, remainingCNY: current.remainingCNY, capCNY: CAP_CNY }
  }

  const ledger = readLedger(now)
  const spentCNY = round4(ledger.spentCNY)
  const remainingCNY = round4(Math.max(0, CAP_CNY - spentCNY))
  const nextSpent = round4(spentCNY + amount)

  if (nextSpent > CAP_CNY + EPS) {
    return {
      ok: false,
      code: 'peak-cap',
      window: ledger.window,
      spentCNY,
      remainingCNY,
      capCNY: CAP_CNY,
    }
  }

  const entries = ledger.entries.concat({
    ts: now.toISOString(),
    planId: meta.planId ? String(meta.planId) : null,
    totalPeakCNY: round4(amount),
  })
  writeLedger({ window: ledger.window, spentCNY: nextSpent, entries })

  return {
    ok: true,
    window: ledger.window,
    spentCNY: nextSpent,
    remainingCNY: round4(Math.max(0, CAP_CNY - nextSpent)),
    capCNY: CAP_CNY,
  }
}

module.exports = {
  TZ,
  CAP_CNY,
  baseDir,
  ledgerPath,
  windowFor,
  resetAtFor,
  readLedger,
  charge,
  status,
}
