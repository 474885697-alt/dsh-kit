/**
 * dsh-cost-gate — 派活前的成本闸门（host 插件）
 *
 * 规则：
 * - 周末（周六/周日，Asia/Shanghai）默认全天谷时，只预估、不拦截。
 * - 谷时：只给预估，不拦截任何运行。
 * - 峰时：单任务估算 ≤ 模型阈值，或完全本地运行 → 放行；否则拦截。
 * - 每个模型可挂 phasePlan，或覆盖 valley / weekendValley / thresholdCNY；
 *   一个计划里不同模型可以落在不同相位，只拦峰时模型的任务。
 *
 * 暴露：
 *   - Agent 工具 cost_gate：估价 + 可选放行
 *   - tools/pre-execute 拦截：spawn_teammate / generate_audio / generate_comfyui
 *     在任一模型峰时且没有有效放行时返回 ask（审批 never 时等于硬拦截）
 */
import { readFileSync, appendFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import phaseCore from './phase.cjs'
import taskGate from './task-gate.cjs'
import peakBudget from './peak-budget.cjs'

export const name = 'cost-gate'
export const inject = ['tools']

const DIR = dirname(fileURLToPath(import.meta.url))
const GATED = ['spawn_teammate', 'generate_audio', 'generate_comfyui']
const { evaluate, phaseSummary } = phaseCore

function loadPrices() {
  const custom = process.env.DSH_COST_GATE_CONFIG
  const file = custom ? custom : join(DIR, '..', 'prices.json')
  return JSON.parse(readFileSync(file, 'utf8'))
}

let prices = null
try {
  prices = loadPrices()
} catch (error) {
  prices = null
  console.error('[dsh-cost-gate] prices.json 读取失败：' + String(error && error.message ? error.message : error))
}

function queueFile() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const dir = join(home, 'dsh-cost-gate')
  mkdirSync(dir, { recursive: true })
  return join(dir, 'blocked.jsonl')
}

function recordBlocked(tool, reason) {
  try {
    appendFileSync(queueFile(), JSON.stringify({
      ts: new Date().toISOString(),
      tool,
      reason,
    }) + '\n')
  } catch (error) {
    console.error('[dsh-cost-gate] 写等待队列失败：' + String(error && error.message ? error.message : error))
  }
}

function costHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

function handoffStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function writeHandoff(result, budget, reason) {
  const window = budget.window || peakBudget.windowFor(new Date())
  const ts = handoffStamp()
  const name = `${window}-${ts}.json`
  const payload = {
    window,
    capCNY: peakBudget.CAP_CNY,
    spentCNY: Number(budget.spentCNY || 0),
    tasks: (result.tasks || []).map((row) => ({
      id: row.id,
      name: row.name,
      member: row.member,
      model: row.model,
      estPeakCNY: row.estPeakCNY,
    })),
    reason,
    createdAt: new Date().toISOString(),
    status: 'unfinished',
  }
  const text = JSON.stringify(payload, null, 2) + '\n'
  const dir = join(costHome(), 'dsh-cost-gate', 'handoffs')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, name)
  writeFileSync(file, text, 'utf8')

  let hubCopy = null
  const hubDir = join(process.cwd(), 'docs', 'tmp', 'hub')
  if (existsSync(hubDir)) {
    const copyDir = join(hubDir, 'cost-handoffs')
    mkdirSync(copyDir, { recursive: true })
    hubCopy = join(copyDir, name)
    writeFileSync(hubCopy, text, 'utf8')
  }
  return { file, hubCopy }
}

function phaseLabel(phase) {
  if (phase === 'valley') return '谷时'
  if (phase === 'peak') return '峰时'
  if (phase === 'mixed') return '混合'
  return '无任务'
}

function renderReport(result, approved, allowanceMinutes) {
  const lines = []
  lines.push(`[${phaseLabel(result.phase)}] 默认阈值 ¥${result.thresholdCNY} | 默认谷时窗口 ${result.valleyWindow}`)
  for (const row of result.tasks) {
    const tag = row.decision === 'allow' ? '放行' : '拦截'
    const phaseTag = row.phase === 'valley' ? '谷时' : '峰时'
    lines.push(`- [${phaseTag}] ${row.id} ${row.name} | 模型 ${row.model} / ${row.plan} | 峰时 ¥${row.estPeakCNY.toFixed(2)} / 谷时 ¥${row.estValleyCNY.toFixed(2)} | ${tag} | ${row.reason}`)
  }
  lines.push(`合计：峰时 ¥${result.totalPeakCNY.toFixed(2)} / 谷时 ¥${result.totalValleyCNY.toFixed(2)}；拦截 ${result.blocked} 条`)
  const nowIds = (result.advice && result.advice.now) || []
  const laterIds = (result.advice && result.advice.later) || []
  if (nowIds.length || laterIds.length) {
    const parts = []
    if (nowIds.length) parts.push(`现在派 ${nowIds.join('、')}`)
    if (laterIds.length) parts.push(`${laterIds.join('、')} 等谷时或拆小`)
    lines.push('建议：' + parts.join('；'))
  }
  if (result.phase !== 'valley' && result.peakPlan) {
    const members = Object.keys(result.peakPlan.byMember)
    lines.push('峰时执行建议（按成员；只有谷时/低估价任务可派）：')
    if (!members.length) lines.push('- 无：没有可放行的任务，全部挂起')
    for (const member of members) {
      const items = result.peakPlan.byMember[member]
        .map((item) => `${item.id} ¥${item.cny.toFixed(2)}${item.phase === 'valley' ? '（谷时）' : ''}${item.local ? '（本地）' : ''}`)
        .join('、')
      lines.push(`- ${member}：${items}`)
    }
    if (result.peakPlan.hold.length) {
      lines.push('挂起（等谷时或拆小）：')
      for (const item of result.peakPlan.hold) {
        lines.push(`- ${item.member}：${item.id} ¥${item.cny.toFixed(2)}（${item.model}），至少拆 ${item.parts} 段`)
      }
    }
  }
  if (approved) lines.push(`已放行：${approved.join(', ')}（有效期 ${allowanceMinutes} 分钟）`)
  return lines.join('\n')
}

const allowance = new Map()

export function apply(ctx) {
  try {
    applyInner(ctx)
  } catch (error) {
    console.error('[dsh-cost-gate] apply failed: ' + String(error && error.stack ? error.stack : error))
  }
}

function applyInner(ctx) {
  if (!prices) {
    console.error('[dsh-cost-gate] 未加载价格表，插件不启用拦截')
    return
  }

  console.log('[dsh-cost-gate] 峰时预算上限 ¥10/日（Asia/Shanghai）：只统计 cost_gate 批准的估算额，不追溯已运行任务；达到上限后新任务不启动，已在跑的由 Lead 按交接单 interrupt。')

  if (typeof ctx.tools?.register === 'function') {
    ctx.effect(() => ctx.tools.register({
      name: 'cost_gate',
      description: '派活前的成本闸门：按任务模型各自的峰谷方案估价。周末/谷时只预估不拦截；峰时单任务超过该模型阈值且非纯本地运行时拦截。approve=true 时可把本次计划覆盖的工具记入放行。status=true 只读返回当日峰时预算（Asia/Shanghai 自然日上限 ¥10）。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          plan: { type: 'object', description: '任务计划：{ tasks: [{ id, name, model, turns, inTokens, outTokens, local, media: [{ unitCNY, count }] }] }' },
          status: { type: 'boolean', description: '为 true 时只读返回当前峰时预算账本，不估价、不写放行' },
          now: { type: 'string', description: '可选，ISO 时间，用于测试峰谷判定' },
          approve: { type: 'boolean', description: '为 true 且计划里没有被拦截的任务（或 force=true）时，写入放行记录' },
          approve_tools: { type: 'array', items: { type: 'string' }, description: '放行哪些工具，默认 spawn_teammate/generate_audio/generate_comfyui；填 * 为全部' },
          minutes: { type: 'number', description: '放行有效期，默认 30 分钟' },
          force: { type: 'boolean', description: '计划有拦截时也强制放行（需用户明确同意）' },
        },
        required: [],
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => [{ type: 'text', text: String(value && value.text ? value.text : JSON.stringify(value)) }],
      },
      async execute(args) {
        const now = args.now ? new Date(String(args.now)) : new Date()
        if (args.status) {
          const budget = peakBudget.status(now)
          return {
            ok: true,
            ...budget,
            text: `峰时预算（${budget.window}）：已用 ¥${budget.spentCNY.toFixed(2)} / ¥${budget.capCNY}，剩余 ¥${budget.remainingCNY.toFixed(2)}；${budget.resetAt} 重置。只统计 cost_gate 批准的估算额，不追溯已运行任务。`,
          }
        }
        const result = evaluate(prices, args.plan || {}, now)
        let approved = null
        let allowanceMinutes = null
        let blockedByCap = false
        let peakSpend = null
        let handoff = null
        if (args.approve && (result.blocked === 0 || args.force)) {
          const planTasks = Array.isArray(args.plan?.tasks) ? args.plan.tasks : []
          const planId = planTasks.map((task) => task?.id).filter(Boolean).join(',') || 'plan'
          try {
            peakSpend = peakBudget.charge(result.totalPeakCNY, { planId, now })
          } catch (error) {
            const current = peakBudget.status(now)
            peakSpend = {
              ok: false,
              code: 'peak-budget-error',
              window: current.window,
              spentCNY: current.spentCNY,
              remainingCNY: current.remainingCNY,
              capCNY: peakBudget.CAP_CNY,
              error: String(error && error.message ? error.message : error),
            }
          }
          if (!peakSpend.ok) {
            blockedByCap = true
            handoff = writeHandoff(result, peakSpend, peakSpend.code)
          } else {
            const tools = (Array.isArray(args.approve_tools) && args.approve_tools.length ? args.approve_tools : GATED)
            const minutes = Math.max(1, Math.min(720, Number(args.minutes) || 30))
            allowanceMinutes = minutes
            const expires = Date.now() + minutes * 60000
            for (const tool of tools) allowance.set(String(tool), expires)
            approved = tools
          }
        }
        let text = renderReport(result, approved, allowanceMinutes)
        if (blockedByCap) {
          const budget = peakBudget.status(now)
          text += `\n\n峰时预算已满：本窗口已用 ¥${budget.spentCNY.toFixed(2)} / ¥${budget.capCNY}，本次估算 ¥${Number(result.totalPeakCNY).toFixed(2)} 未放行。已写交接单：${handoff?.file || '(失败)'}；等下一个窗口重新投递。`
        }
        return {
          ...result,
          approved,
          allowanceMinutes,
          blockedByCap,
          peakSpend,
          handoff: handoff?.file || null,
          handoffHub: handoff?.hubCopy || null,
          text,
        }
      },
    }), 'dsh-cost-gate: cost_gate tool')
  }

  if (typeof ctx.on === 'function') {
    const guard = (exec, next) => {
      try {
        const tool = exec && exec.name ? String(exec.name) : ''
        const now = new Date()
        if (tool === 'team_task_create') {
          const verdict = taskGate.checkTask(String(exec?.arguments?.description || ''), { prices, now })
          if (verdict.ok) return next()
          const reason = `cost-gate: ${verdict.code} — ${verdict.reason}`
          recordBlocked(tool, reason)
          return {
            kind: 'deny',
            reason,
            displayReason: {
              en: `cost-gate: task card rejected (${verdict.code}) — ${verdict.model}, ${verdict.phase}. Add budget/estimate, cut scope, or get user approval.`,
              zh: `成本闸门：任务卡未通过（${verdict.code}）—— ${verdict.reason}`,
            },
          }
        }
        if (!GATED.includes(tool)) return next()
        const budget = peakBudget.status(now)
        if (budget.remainingCNY <= 0) {
          const reason = 'cost-gate: peak-cap — 峰时预算 ¥10 已用完'
          recordBlocked(tool, reason)
          return {
            kind: 'deny',
            reason,
            displayReason: {
              en: 'cost-gate: peak budget ¥10 for this window is used up. A handoff was saved; wait for the next window to re-dispatch.',
              zh: '已保存交接单，等中枢区下个窗口重新投递',
            },
          }
        }
        const summary = phaseSummary(prices, now)
        if (summary.overall === 'valley') return next()
        const expires = allowance.get(tool) || allowance.get('*')
        if (expires && expires > now.getTime()) return next()
        const peakModels = summary.phases
          .filter((item) => !item.valley)
          .map((item) => `${item.model}(${item.planName})`)
          .join('、')
        const reason = `cost-gate: ${tool} 涉及模型 ${peakModels} 处于峰时。先调用 cost_gate（按实际模型/任务估价，approve=true）放行；谷时或周末会自动放行。已记入等待队列：${queueFile()}`
        recordBlocked(tool, reason)
        return {
          kind: 'ask',
          reason,
          displayReason: {
            en: `cost-gate: ${tool} is gated because model(s) ${peakModels} are in peak hours. Call cost_gate with approve=true first; weekends/valley run automatically.`,
            zh: `成本闸门：模型 ${peakModels} 处于峰时，调用 ${tool} 前需要先用 cost_gate 估价并放行。周末/谷时自动放行。已记入等待队列。`,
          },
        }
      } catch (error) {
        console.error('[dsh-cost-gate] guard error: ' + String(error && error.message ? error.message : error))
        return next()
      }
    }
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => ctx.on('tools/pre-execute', guard), 'dsh-cost-gate: pre-execute guard')
    } else {
      ctx.on('tools/pre-execute', guard)
    }
  }
}
