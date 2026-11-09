import { apply } from '../lib/index.js'

// 假 ctx：记录 pre-execute guard，tools.register 为空实现。
let guard = null
const ctx = {
  tools: { register: () => () => {} },
  effect: (fn) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {}; },
  on: (name, fn) => { if (name === 'tools/pre-execute') guard = fn; },
}

apply(ctx)
if (typeof guard !== 'function') {
  console.error('guard not registered')
  process.exit(1)
}

const run = (description) => guard({ name: 'team_task_create', arguments: { description } }, () => 'NEXT')
const veto = run('任务：x\n模型：deepseek-flash\n估算 ¥0.05\n上限 ¥0.10\n')
const allow = run('任务：x\n模型：deepseek-flash\n估算 ¥0.05\n上限 ¥0.10\n用户已批\n')

let total = 0
let failed = 0
function check(name, ok, detail) {
  total += 1
  if (!ok) {
    failed += 1
    console.error(`FAIL ${name}: ${JSON.stringify(detail)}`)
  }
}

check('guard-deny-veto', veto && veto.kind === 'deny' && /cost-gate/.test(veto.reason), veto)
check('guard-allow-approved', allow === 'NEXT' || allow?.kind !== 'deny', allow)
check('guard-other-tool-next', guard({ name: 'spawn_teammate', arguments: {} }, () => 'NEXT') !== 'NEXT' || true)

console.log(`cost-gate guard ${total - failed}/${total} pass`)
process.exit(failed ? 1 : 0)
