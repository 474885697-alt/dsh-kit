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
import { readFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import phaseCore from './phase.cjs'
import taskGate from './task-gate.cjs'

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

  if (typeof ctx.tools?.register === 'function') {
    ctx.effect(() => ctx.tools.register({
      name: 'cost_gate',
      description: '派活前的成本闸门：按任务模型各自的峰谷方案估价。周末/谷时只预估不拦截；峰时单任务超过该模型阈值且非纯本地运行时拦截。approve=true 时可把本次计划覆盖的工具记入放行。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          plan: { type: 'object', description: '任务计划：{ tasks: [{ id, name, model, turns, inTokens, outTokens, local, media: [{ unitCNY, count }] }] }' },
          now: { type: 'string', description: '可选，ISO 时间，用于测试峰谷判定' },
          approve: { type: 'boolean', description: '为 true 且计划里没有被拦截的任务（或 force=true）时，写入放行记录' },
          approve_tools: { type: 'array', items: { type: 'string' }, description: '放行哪些工具，默认 spawn_teammate/generate_audio/generate_comfyui；填 * 为全部' },
          minutes: { type: 'number', description: '放行有效期，默认 30 分钟' },
          force: { type: 'boolean', description: '计划有拦截时也强制放行（需用户明确同意）' },
        },
        required: ['plan'],
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => [{ type: 'text', text: String(value && value.text ? value.text : JSON.stringify(value)) }],
      },
      async execute(args) {
        const now = args.now ? new Date(String(args.now)) : new Date()
        const result = evaluate(prices, args.plan || {}, now)
        let approved = null
        let allowanceMinutes = null
        if (args.approve && (result.blocked === 0 || args.force)) {
          const tools = (Array.isArray(args.approve_tools) && args.approve_tools.length ? args.approve_tools : GATED)
          const minutes = Math.max(1, Math.min(720, Number(args.minutes) || 30))
          allowanceMinutes = minutes
          const expires = Date.now() + minutes * 60000
          for (const tool of tools) allowance.set(String(tool), expires)
          approved = tools
        }
        const text = renderReport(result, approved, allowanceMinutes)
        return { ...result, approved, allowanceMinutes, text }
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
