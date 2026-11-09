'use strict'

/**
 * cost-gate 的峰谷判定与估价核心。
 *
 * 规则：
 * - 谷时：只预估，不拦截。
 * - 峰时：单任务估算 ≤ 模型阈值，或完全本地运行 → 放行；否则拦截。
 * - 周末（周六/周日，Asia/Shanghai）默认全天谷时。
 * - 每个模型可以挂 phasePlan，或直接覆盖 valley / weekendValley / thresholdCNY /
 *   valleyMultiplier。一个计划里不同模型可以落在不同相位，只拦峰时模型的任务。
 */

const DEFAULT_TIMEZONE = 'Asia/Shanghai'
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function parseHHMM(value) {
  if (value === '24:00' || value === 24 * 60) return 24 * 60
  const [h, m] = String(value).split(':').map(Number)
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0)
}

function minutesInZone(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone || DEFAULT_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date)
  return Number(parts.find((p) => p.type === 'hour').value) * 60
    + Number(parts.find((p) => p.type === 'minute').value)
}

function weekdayInZone(date, timezone) {
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone || DEFAULT_TIMEZONE,
    weekday: 'short',
  }).format(date)
  return WEEKDAYS.indexOf(weekday)
}

function isWeekend(date, timezone) {
  const day = weekdayInZone(date, timezone)
  return day === 0 || day === 6
}

function hm(minutes) {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

function windowLabel(window) {
  if (window.start === 0 && window.end >= 24 * 60) return '全天'
  return `${hm(window.start)}-${hm(window.end)}`
}

function normalizeWindows(value) {
  const raw = Array.isArray(value) ? value : value ? [value] : []
  return raw.map((window) => {
    const start = parseHHMM(window.start === undefined ? '00:30' : window.start)
    const end = parseHHMM(window.end === undefined ? '08:30' : window.end)
    return {
      start,
      end,
      multiplier: window.multiplier === undefined ? null : Number(window.multiplier),
    }
  }).filter((window) => Number.isFinite(window.start) && Number.isFinite(window.end))
}

function resolvePlan(prices, model) {
  const modelConfig = (prices.models && prices.models[model]) || {}
  const planName = modelConfig.phasePlan || 'default'
  const plan = (prices.phasePlans && prices.phasePlans[planName]) || {}

  const rawWindows = modelConfig.valley !== undefined
    ? modelConfig.valley
    : plan.valley !== undefined
      ? plan.valley
      : prices.valley

  const weekendRaw = modelConfig.weekendValley !== undefined
    ? modelConfig.weekendValley
    : plan.weekendValley !== undefined
      ? plan.weekendValley
      : prices.weekendValley !== undefined
        ? prices.weekendValley
        : true

  const multiplierRaw = modelConfig.valleyMultiplier !== undefined
    ? modelConfig.valleyMultiplier
    : plan.multiplier !== undefined
      ? plan.multiplier
      : prices.valley && prices.valley.multiplier !== undefined
        ? prices.valley.multiplier
        : 1

  const thresholdRaw = modelConfig.thresholdCNY !== undefined
    ? modelConfig.thresholdCNY
    : plan.thresholdCNY !== undefined
      ? plan.thresholdCNY
      : prices.thresholdCNY !== undefined
        ? prices.thresholdCNY
        : 0.5

  return {
    model,
    planName,
    windows: normalizeWindows(rawWindows),
    weekendValley: Boolean(weekendRaw),
    multiplier: Number(multiplierRaw),
    thresholdCNY: Number(thresholdRaw),
    timezone: prices.timezone || DEFAULT_TIMEZONE,
  }
}

function inWindow(nowMin, window) {
  if (window.start === window.end) return false
  if (window.start < window.end) return nowMin >= window.start && nowMin < window.end
  return nowMin >= window.start || nowMin < window.end
}

function phaseAt(prices, date, model) {
  const plan = resolvePlan(prices, model)
  const nowMin = minutesInZone(date, plan.timezone)
  const weekend = isWeekend(date, plan.timezone)
  const valley = (plan.weekendValley && weekend)
    || plan.windows.some((window) => inWindow(nowMin, window))
  const windowText = plan.windows.length
    ? plan.windows.map(windowLabel).join('、')
    : '无固定谷时'
  return {
    ...plan,
    valley,
    weekend,
    nowMin,
    windowLabel: windowText + (plan.weekendValley ? '；周末全天' : ''),
  }
}

function nextValleyMinutes(prices, date, model, maxMinutes = 8 * 24 * 60) {
  if (phaseAt(prices, date, model).valley) return 0
  for (let i = 1; i <= maxMinutes; i += 1) {
    if (phaseAt(prices, new Date(date.getTime() + i * 60000), model).valley) return i
  }
  return null
}

function fmtDuration(minutes) {
  if (minutes === null || minutes === undefined) return '近期无谷时'
  if (minutes === 0) return '0 分'
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return h ? `${h} 小时 ${m} 分` : `${m} 分`
}

function priceOf(prices, model) {
  const key = model || prices.defaultModel
  if (!prices.models || !prices.models[key]) {
    throw new Error(`prices.json 里没有模型 ${key}`)
  }
  return prices.models[key]
}

function estimateTask(task, prices) {
  const turns = Math.max(1, Number(task.turns || 1))
  const inTokens = Math.max(0, Number(task.inTokens || 0))
  const outTokens = Math.max(0, Number(task.outTokens || 0))
  const model = task.model || prices.defaultModel
  const price = priceOf(prices, model)
  const plan = resolvePlan(prices, model)
  const media = (Array.isArray(task.media) ? task.media : [])
    .reduce((sum, item) => sum + Number(item.unitCNY || 0) * Number(item.count || 1), 0)
  const zeroPrice = Number(price.inCNY || 0) === 0 && Number(price.outCNY || 0) === 0
  const localOnly = (Boolean(task.local) || model === 'local' || zeroPrice)
    && media === 0
    && inTokens + outTokens > 0
  const tokensCNY = localOnly
    ? 0
    : ((inTokens / 1e6) * Number(price.inCNY || 0)
      + (outTokens / 1e6) * Number(price.outCNY || 0)) * turns
  return {
    turns,
    inTokens,
    outTokens,
    media,
    localOnly,
    peakCNY: tokensCNY + media,
    valleyCNY: tokensCNY * (Number.isFinite(plan.multiplier) ? plan.multiplier : 1) + media,
  }
}

function overallPhase(rows) {
  const relevant = rows.filter((row) => !row.localOnly)
  if (!relevant.length) return rows.length ? 'valley' : 'none'
  const valleyCount = relevant.filter((row) => row.phase === 'valley').length
  if (valleyCount === relevant.length) return 'valley'
  if (valleyCount === 0) return 'peak'
  return 'mixed'
}

function evaluate(prices, plan, now) {
  const rows = []
  let totalPeak = 0
  let totalValley = 0
  let blocked = 0

  for (const task of plan.tasks || []) {
    const model = String(task.model || prices.defaultModel)
    const phase = phaseAt(prices, now, model)
    const estimate = estimateTask(task, prices)
    totalPeak += estimate.peakCNY
    totalValley += estimate.valleyCNY

    let decision
    let reason
    let advice
    if (phase.valley) {
      decision = 'allow'
      reason = `谷时（模型 ${model} / 方案 ${phase.planName}）：只预估，不拦截`
      advice = '现在可派（谷时）'
    } else if (estimate.localOnly) {
      decision = 'allow'
      reason = '完全本地运行，无外部模型/media 费用'
      advice = '现在可派（本地运行）'
    } else if (estimate.peakCNY <= phase.thresholdCNY) {
      decision = 'allow'
      reason = `峰时估算 ¥${estimate.peakCNY.toFixed(2)} ≤ 模型阈值 ¥${phase.thresholdCNY}`
      advice = '现在可派'
    } else {
      decision = 'block'
      blocked += 1
      const parts = Math.ceil(estimate.peakCNY / phase.thresholdCNY)
      const wait = nextValleyMinutes(prices, now, model)
      reason = `峰时估算 ¥${estimate.peakCNY.toFixed(2)} > 模型阈值 ¥${phase.thresholdCNY}`
        + `（模型 ${model} / 方案 ${phase.planName}）；`
        + (wait === null ? '近期无谷时' : `等到谷时（约 ${fmtDuration(wait)}后）`)
        + `或拆成 ${parts} 个子任务`
      advice = wait === null
        ? `拆成 ${parts} 个 ≤ ¥${phase.thresholdCNY} 的子任务`
        : `等谷时（约 ${fmtDuration(wait)}后）或拆成 ${parts} 个 ≤ ¥${phase.thresholdCNY} 的子任务`
    }

    rows.push({
      id: String(task.id || '(未命名)'),
      name: String(task.name || ''),
      member: String(task.member || '-'),
      model,
      plan: phase.planName,
      phase: phase.valley ? 'valley' : 'peak',
      weekend: phase.weekend,
      thresholdCNY: phase.thresholdCNY,
      valleyWindow: phase.windowLabel,
      estPeakCNY: Number(estimate.peakCNY.toFixed(4)),
      estValleyCNY: Number(estimate.valleyCNY.toFixed(4)),
      localOnly: estimate.localOnly,
      decision,
      advice,
      reason,
    })
  }

  const peakPlan = { byMember: {}, hold: [] }
  for (const row of rows) {
    if (row.decision === 'allow') {
      if (!peakPlan.byMember[row.member]) peakPlan.byMember[row.member] = []
      peakPlan.byMember[row.member].push({
        id: row.id,
        cny: row.estPeakCNY,
        local: row.localOnly,
        phase: row.phase,
      })
    } else {
      peakPlan.hold.push({
        id: row.id,
        member: row.member,
        cny: row.estPeakCNY,
        parts: Math.ceil(row.estPeakCNY / row.thresholdCNY),
        model: row.model,
      })
    }
  }

  const defaultPhase = phaseAt(prices, now, prices.defaultModel)
  const phases = {}
  for (const row of rows) phases[row.model] = row.phase

  return {
    now: now.toISOString(),
    phase: overallPhase(rows),
    phases,
    defaultPhase: defaultPhase.valley ? 'valley' : 'peak',
    valleyWindow: defaultPhase.windowLabel,
    thresholdCNY: prices.thresholdCNY,
    weekendValley: prices.weekendValley !== false,
    tasks: rows,
    peakPlan,
    totalPeakCNY: Number(totalPeak.toFixed(4)),
    totalValleyCNY: Number(totalValley.toFixed(4)),
    blocked,
    advice: {
      now: rows.filter((row) => row.decision === 'allow').map((row) => row.id),
      later: rows.filter((row) => row.decision === 'block').map((row) => row.id),
    },
  }
}

function phaseSummary(prices, date) {
  const models = Object.keys(prices.models || {})
  if (!models.length && prices.defaultModel) models.push(prices.defaultModel)
  const phases = models.map((model) => {
    const phase = phaseAt(prices, date, model)
    const price = (prices.models && prices.models[model]) || {}
    const billable = !(Number(price.inCNY || 0) === 0 && Number(price.outCNY || 0) === 0)
    return {
      model,
      planName: phase.planName,
      phase: phase.valley ? 'valley' : 'peak',
      valley: phase.valley,
      billable,
      weekend: phase.weekend,
      thresholdCNY: phase.thresholdCNY,
      windowLabel: phase.windowLabel,
    }
  })
  const relevant = phases.filter((item) => item.billable)
  const valleyCount = relevant.filter((item) => item.valley).length
  const overall = !relevant.length || valleyCount === relevant.length
    ? 'valley'
    : valleyCount === 0
      ? 'peak'
      : 'mixed'
  return { overall, phases }
}

module.exports = {
  DEFAULT_TIMEZONE,
  parseHHMM,
  minutesInZone,
  weekdayInZone,
  isWeekend,
  phaseAt,
  phaseSummary,
  nextValleyMinutes,
  fmtDuration,
  estimateTask,
  evaluate,
  overallPhase,
}
