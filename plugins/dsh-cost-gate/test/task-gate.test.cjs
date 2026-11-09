'use strict'

/**
 * C10 任务卡成本门测试。
 * 运行：node plugins/dsh-cost-gate/test/task-gate.test.cjs
 */

const { spawnSync } = require('node:child_process')
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')

const prices = require('../prices.json')
const { parseTaskText, checkTask } = require('../lib/task-gate.cjs')

const VALLEY = '2026-11-10T03:00:00+08:00' // 周二 03:00
const PEAK = '2026-11-10T14:00:00+08:00' // 周二 14:00

let total = 0
let failed = 0
function check(name, ok, detail) {
  total += 1
  if (!ok) {
    failed += 1
    console.error(`FAIL ${name}: ${JSON.stringify(detail)}`)
  }
}

function run(text, now) {
  return checkTask(text, { prices, now: new Date(now) })
}

const base = '模型：deepseek-flash\n'

check('parse-cap', parseTaskText('上限 ¥0.10').capCNY === 0.1)
check('parse-estimate', parseTaskText('估算 ¥0.05').estimateCNY === 0.05)
check('parse-model', parseTaskText('模型：deepseek-pro').model === 'deepseek-pro')
check('parse-approved', parseTaskText('用户已批').approved === true)
check('parse-not-approved', parseTaskText('待用户确认').approved === false)

const missingBudget = run(base + '估算 ¥0.05', VALLEY)
check('missing-budget-deny', !missingBudget.ok && missingBudget.code === 'missing-budget', missingBudget)

const missingEstimate = run(base + '上限 ¥0.10', VALLEY)
check('missing-estimate-deny', !missingEstimate.ok && missingEstimate.code === 'missing-estimate', missingEstimate)

const valleyUnder = run(base + '估算 ¥0.05，上限 ¥0.10', VALLEY)
check('valley-under-allow', valleyUnder.ok && valleyUnder.decision === 'allow', valleyUnder)
check('valley-under-phase', valleyUnder.phase === 'valley' && valleyUnder.model === 'deepseek-flash', valleyUnder)

const valleyOver = run(base + '估算 ¥0.10，上限 ¥0.05', VALLEY)
check('valley-over-deny', !valleyOver.ok && valleyOver.code === 'over-cap', valleyOver)
check('valley-over-reason-has-numbers', /¥0\.1.*¥0\.05|¥0\.05.*¥0\.1/.test(valleyOver.reason), valleyOver.reason)

const peakUnapproved = run(base + '估算 ¥0.10，上限 ¥0.50', PEAK)
check('peak-unapproved-deny', !peakUnapproved.ok && peakUnapproved.code === 'peak-unapproved', peakUnapproved)

const peakApproved = run(base + '估算 ¥0.10，上限 ¥0.50，用户已批', PEAK)
check('peak-approved-allow', peakApproved.ok && peakApproved.decision === 'allow', peakApproved)
check('peak-phase', peakApproved.phase === 'peak', peakApproved)

const peakOver = run(base + '估算 ¥0.60，上限 ¥0.50，用户已批', PEAK)
check('peak-over-deny', !peakOver.ok && peakOver.code === 'over-cap', peakOver)

const boundaryValley = run(base + '估算 ¥0.05，上限 ¥0.05', VALLEY)
check('boundary-equal-allow', boundaryValley.ok, boundaryValley)

const unknownModel = run('模型：gpt-9 估算 ¥0.10 上限 ¥1', VALLEY)
check('unknown-model-deny', !unknownModel.ok && unknownModel.code === 'unknown-model', unknownModel)

const localTask = run('模型：local 估算 ¥0 上限 ¥0', PEAK)
check('local-allow', localTask.ok, localTask)

// CLI：fixture + --now 谷时 → exit 0；峰时未批 → exit 1
const dir = mkdtempSync(join(tmpdir(), 'cost-task-'))
try {
  const fixture = join(__dirname, 'fixtures', 'task-card.md')
  const cli = spawnSync(process.execPath, [
    join(__dirname, '..', 'cost-gate.cjs'), '--check-task', fixture, '--now', VALLEY, '--json',
  ], { encoding: 'utf8' })
  check('cli-valley-exit0', cli.status === 0, { status: cli.status, stderr: cli.stderr })
  const parsed = JSON.parse(cli.stdout)
  check('cli-valley-json', parsed.ok === true && parsed.model === 'deepseek-flash', parsed)

  const peakFile = join(dir, 'peak.md')
  writeFileSync(peakFile, '模型：deepseek-flash\n估算 ¥0.10，上限 ¥0.50\n', 'utf8')
  const peakCli = spawnSync(process.execPath, [
    join(__dirname, '..', 'cost-gate.cjs'), '--check-task', peakFile, '--now', PEAK,
  ], { encoding: 'utf8' })
  check('cli-peak-exit1', peakCli.status === 1, { status: peakCli.status, stdout: peakCli.stdout })
  check('cli-peak-output', /峰时|peak/.test(peakCli.stdout) && /拦截/.test(peakCli.stdout), peakCli.stdout)
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(`task-gate ${total - failed}/${total} pass`)
process.exit(failed ? 1 : 0)
