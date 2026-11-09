'use strict'

/**
 * 峰时预算账本（Asia/Shanghai 自然日）。
 *
 * 只统计 cost_gate 放行时记录的估算额，不追溯已经跑起来的任务。
 * 账本：`<DSH_HOME>/dsh-cost-gate/peak-spend.json`
 *   { window: 'YYYY-MM-DD', spentCents, entries: [{ ts, planId, totalPeakCents }] }
 *
 * 金额内部统一用整数分（cents）存储与比较，避免 0.1 + 0.2 这类浮点误差；
 * 对外仍返回 / 展示人民币元（CNY），保留两位小数。
 * 跨日视为新窗口（逻辑重置，不主动改写旧账）。
 */

const { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } = require('node:fs')
const { join } = require('node:path')
const { homedir } = require('node:os')

const TZ = 'Asia/Shanghai'
const CAP_CNY = 10
const CAP_CENTS = CAP_CNY * 100

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

/** 元 -> 整数分；非法金额返回 null。 */
function toCents(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  return Math.round(n * 100)
}

/** 整数分 -> 元。 */
function toCNY(cents) {
  return Number(cents) / 100
}

function emptyLedger(window) {
  return { window, spentCents: 0, entries: [] }
}

function normalizeEntries(raw) {
  if (!Array.isArray(raw)) return []
  const entries = []
  for (const entry of raw) {
    let cents = null
    if (Number.isInteger(entry?.totalPeakCents) && entry.totalPeakCents >= 0) {
      cents = entry.totalPeakCents
    } else if (Number.isFinite(Number(entry?.totalPeakCNY)) && Number(entry.totalPeakCNY) >= 0) {
      // 兼容 task-16 的旧账本（元，浮点）。
      cents = Math.round(Number(entry.totalPeakCNY) * 100)
    }
    if (cents === null) continue
    entries.push({
      ts: typeof entry?.ts === 'string' ? entry.ts : null,
      planId: entry?.planId == null ? null : String(entry.planId),
      totalPeakCents: cents,
    })
  }
  return entries
}

function readLedger(now = new Date()) {
  const window = windowFor(now)
  let raw = null
  try {
    raw = JSON.parse(readFileSync(ledgerPath(), 'utf8'))
  } catch {
    return emptyLedger(window)
  }
  let spentCents = null
  if (Number.isInteger(raw?.spentCents) && raw.spentCents >= 0) {
    spentCents = raw.spentCents
  } else if (Number.isFinite(Number(raw?.spentCNY)) && Number(raw.spentCNY) >= 0) {
    spentCents = Math.round(Number(raw.spentCNY) * 100)
  }
  if (raw?.window !== window || !Array.isArray(raw?.entries) || spentCents === null) {
    return emptyLedger(window)
  }
  return { window, spentCents, entries: normalizeEntries(raw.entries) }
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
  const spentCNY = toCNY(ledger.spentCents)
  const remainingCNY = toCNY(Math.max(0, CAP_CENTS - ledger.spentCents))
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
 * 入参为元，进入账本前先转整数分。
 * @param {number} amountCNY
 * @param {{ planId?: string, now?: Date }} [meta]
 */
function charge(amountCNY, meta = {}) {
  const amountCents = toCents(amountCNY)
  const now = meta.now instanceof Date ? meta.now : new Date()
  if (amountCents === null || amountCents < 0) {
    const current = status(now)
    return { ok: false, code: 'invalid-amount', window: current.window, spentCNY: current.spentCNY, remainingCNY: current.remainingCNY, capCNY: CAP_CNY }
  }

  const ledger = readLedger(now)
  const spentCNY = toCNY(ledger.spentCents)
  const remainingCNY = toCNY(Math.max(0, CAP_CENTS - ledger.spentCents))
  const nextSpentCents = ledger.spentCents + amountCents

  if (nextSpentCents > CAP_CENTS) {
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
    totalPeakCents: amountCents,
  })
  writeLedger({ window: ledger.window, spentCents: nextSpentCents, entries })

  return {
    ok: true,
    window: ledger.window,
    spentCNY: toCNY(nextSpentCents),
    remainingCNY: toCNY(Math.max(0, CAP_CENTS - nextSpentCents)),
    capCNY: CAP_CNY,
  }
}

module.exports = {
  TZ,
  CAP_CNY,
  CAP_CENTS,
  baseDir,
  ledgerPath,
  windowFor,
  resetAtFor,
  toCents,
  readLedger,
  charge,
  status,
}
