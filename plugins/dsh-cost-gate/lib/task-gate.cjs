'use strict'

/**
 * 任务卡成本门（C10）。
 *
 * 在建工单 / 派发前从 description 读取 预算上限、模型、估算成本：
 *   - 缺 budget（或写 0 冒充缺失）→ 拒绝 missing-budget
 *   - 缺估算 → 拒绝 missing-estimate（不把缺失当 0）
 *   - 估算 > 上限 → 拒绝 over-cap（谷时也拒绝）
 *   - 谷时且未超限 → 放行（只预估）
 *   - 峰时未获用户批准 → 拒绝 peak-unapproved
 *   - 边界相等（estimate === cap）→ 放行
 *
 * 只依赖 phase.cjs；不读环境变量、不连网。
 */

const phaseCore = require('./phase.cjs')

const RE = {
  cap: /(?:上限|预算|cap(?:CNY)?|budget|ceiling)\s*[:：]?\s*[¥￥]?\s*([0-9]+(?:\.[0-9]+)?)/i,
  estimate: /(?:估算|估价|预计|预估|estimated?|costs?|谷时估|峰时估|成本)\s*[:：]?\s*(?:约\s*)?[¥￥]?\s*([0-9]+(?:\.[0-9]+)?)/i,
  model: /(?:模型|model)\s*[:：]?\s*`?([a-z0-9._-]+)`?/i,
  approved: /(?:用户已批|已批准|用户批准|approvedByUser\s*[:=]\s*true|approved\s*[:=]\s*true)/i,
}

function num(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function parseTaskText(text) {
  const raw = String(text || '')
  const cap = raw.match(RE.cap)
  const estimate = raw.match(RE.estimate)
  const model = raw.match(RE.model)
  return {
    capCNY: cap ? num(cap[1]) : null,
    estimateCNY: estimate ? num(estimate[1]) : null,
    model: model ? model[1] : null,
    approved: RE.approved.test(raw),
  }
}

function checkTask(text, options = {}) {
  const prices = options.prices
  if (!prices) throw new Error('checkTask 需要 prices')
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now())
  const parsed = parseTaskText(text)
  const model = parsed.model || prices.defaultModel
  const price = prices.models && prices.models[model]
  const base = {
    model,
    capCNY: parsed.capCNY,
    estimateCNY: parsed.estimateCNY,
    approved: parsed.approved,
  }

  if (!price) {
    return {
      ...base,
      ok: false,
      decision: 'deny',
      code: 'unknown-model',
      plan: null,
      phase: null,
      thresholdCNY: null,
      reason: `未知模型 ${model}（prices.json 里没有）；无法按峰谷估价`,
    }
  }

  const plan = phaseCore.phaseAt(prices, now, model)
  const context = {
    ...base,
    plan: plan.planName,
    phase: plan.valley ? 'valley' : 'peak',
    thresholdCNY: plan.thresholdCNY,
  }

  if (parsed.capCNY === null) {
    return {
      ...context,
      ok: false,
      decision: 'deny',
      code: 'missing-budget',
      reason: `任务卡缺少预算上限（写「上限 ¥x」）；不接受缺失按 0 处理`,
    }
  }
  if (parsed.estimateCNY === null) {
    return {
      ...context,
      ok: false,
      decision: 'deny',
      code: 'missing-estimate',
      reason: `任务卡缺少成本估算（写「估算 ¥x」）；不接受缺失按 0 处理`,
    }
  }

  const overCap = parsed.estimateCNY - parsed.capCNY > 1e-9
  if (overCap) {
    return {
      ...context,
      ok: false,
      decision: 'deny',
      code: 'over-cap',
      overCap: true,
      reason: `估算 ¥${parsed.estimateCNY} > 上限 ¥${parsed.capCNY}（模型 ${model} / 方案 ${plan.planName} / ${context.phase === 'valley' ? '谷时' : '峰时'}）`,
    }
  }

  if (plan.valley) {
    return {
      ...context,
      ok: true,
      decision: 'allow',
      code: 'ok',
      overCap: false,
      reason: `谷时（模型 ${model} / 方案 ${plan.planName}）：估算 ¥${parsed.estimateCNY} ≤ 上限 ¥${parsed.capCNY}，只预估不拦截`,
    }
  }

  if (!parsed.approved) {
    return {
      ...context,
      ok: false,
      decision: 'deny',
      code: 'peak-unapproved',
      overCap: false,
      reason: `峰时（模型 ${model} / 方案 ${plan.planName}）：需用户明确批准（「用户已批」/approvedByUser: true）才能派发；估算 ¥${parsed.estimateCNY} ≤ 上限 ¥${parsed.capCNY}`,
    }
  }

  return {
    ...context,
    ok: true,
    decision: 'allow',
    code: 'ok',
    overCap: false,
    reason: `峰时已批（模型 ${model} / 方案 ${plan.planName}）：估算 ¥${parsed.estimateCNY} ≤ 上限 ¥${parsed.capCNY}`,
  }
}

module.exports = { parseTaskText, checkTask }
