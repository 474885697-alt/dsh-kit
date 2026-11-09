'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const gate = require('../lib/phase.cjs');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'cost-gate.cjs');
const WATCH = path.join(ROOT, 'phase-watch.cjs');
const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'prices.json'), 'utf8'));

function at(value) {
  return new Date(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function run(args, env) {
  return spawnSync(process.execPath, args, {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

// 1. 周末全天谷时，周中仍按 00:30-08:30
assert.equal(gate.phaseAt(base, at('2026-11-08T17:00:00+08:00'), 'deepseek-flash').valley, true, '周日 17:00 应为谷时');
assert.equal(gate.phaseAt(base, at('2026-11-08T01:00:00+08:00'), 'deepseek-flash').valley, true, '周日 01:00 应为谷时');
assert.equal(gate.phaseAt(base, at('2026-11-09T17:00:00+08:00'), 'deepseek-flash').valley, false, '周一 17:00 应为峰时');
assert.equal(gate.phaseAt(base, at('2026-11-09T02:00:00+08:00'), 'deepseek-flash').valley, true, '周一 02:00 应为谷时');

// 2. 每个模型可以挂不同 phasePlan（含跨午夜窗口）
const custom = clone(base);
custom.phasePlans.night = {
  valley: [{ start: '22:00', end: '08:30' }],
  weekendValley: true,
  multiplier: 0.4,
};
custom.models['test-night'] = {
  inCNY: 2,
  outCNY: 3,
  phasePlan: 'night',
  thresholdCNY: 0.2,
};
assert.equal(gate.phaseAt(custom, at('2026-11-09T23:00:00+08:00'), 'test-night').valley, true, 'night 方案 23:00 应为谷时');
assert.equal(gate.phaseAt(custom, at('2026-11-09T07:00:00+08:00'), 'test-night').valley, true, 'night 方案 07:00 应为谷时');
assert.equal(gate.phaseAt(custom, at('2026-11-09T17:00:00+08:00'), 'test-night').valley, false, 'night 方案 17:00 应为峰时');

// 3. 模型可单独关闭周末谷时
custom.models['weekday-only'] = {
  inCNY: 2,
  outCNY: 3,
  phasePlan: 'default',
  weekendValley: false,
};
assert.equal(gate.phaseAt(custom, at('2026-11-08T17:00:00+08:00'), 'weekday-only').valley, false, '关闭周末谷时后周日 17:00 应为峰时');
assert.equal(gate.phaseAt(custom, at('2026-11-09T02:00:00+08:00'), 'weekday-only').valley, true, '周中 02:00 仍应为谷时');

// 4b. 守卫用的 phaseSummary 也按模型汇总
const sundaySummary = gate.phaseSummary(base, at('2026-11-08T17:00:00+08:00'));
assert.equal(sundaySummary.overall, 'valley', '周日所有计费模型都应谷时');
assert.ok(sundaySummary.phases.some((item) => item.model === 'deepseek-flash' && item.valley === true));
const mondaySummary = gate.phaseSummary(custom, at('2026-11-09T17:00:00+08:00'));
assert.equal(mondaySummary.overall, 'peak', '周一 17:00 计费模型都应峰时');
assert.equal(gate.phaseSummary(custom, at('2026-11-08T17:00:00+08:00')).overall, 'mixed', '有模型关闭周末谷时时整体为 mixed');

// 4. 同一计划里混合模型：只拦峰时且超该模型阈值的任务
const mondayNight = at('2026-11-09T23:00:00+08:00');
const mixedPlan = {
  tasks: [
    { id: 'flash-big', name: '峰时任务', model: 'deepseek-flash', turns: 1, inTokens: 300000, outTokens: 30000, member: 'mechanics' },
    { id: 'night-big', name: '谷时任务', model: 'test-night', turns: 1, inTokens: 300000, outTokens: 30000, member: 'online' },
  ],
};
const mixed = gate.evaluate(custom, mixedPlan, mondayNight);
assert.equal(mixed.phase, 'mixed', '混合模型计划应为 mixed');
assert.equal(mixed.blocked, 1, '只应拦截 flash-big');
assert.equal(mixed.tasks.find((task) => task.id === 'flash-big').decision, 'block');
assert.equal(mixed.tasks.find((task) => task.id === 'night-big').decision, 'allow');
assert.equal(mixed.tasks.find((task) => task.id === 'night-big').phase, 'valley');
assert.deepEqual(mixed.advice.now, ['night-big']);
assert.deepEqual(mixed.advice.later, ['flash-big']);
assert.equal(mixed.phases['deepseek-flash'], 'peak');
assert.equal(mixed.phases['test-night'], 'valley');

// 5. 模型自己的 thresholdCNY 生效
const mondayPeak = at('2026-11-09T17:00:00+08:00');
const threshold = gate.evaluate(custom, {
  tasks: [
    { id: 'flash-small', model: 'deepseek-flash', turns: 1, inTokens: 100000, outTokens: 10000 }, // ¥0.23 <= 0.5
    { id: 'night-big', model: 'test-night', turns: 1, inTokens: 300000, outTokens: 30000 }, // ¥0.69 > 0.2
  ],
}, mondayPeak);
assert.equal(threshold.phase, 'peak');
assert.equal(threshold.blocked, 1);
assert.equal(threshold.tasks.find((task) => task.id === 'flash-small').decision, 'allow');
assert.equal(threshold.tasks.find((task) => task.id === 'night-big').decision, 'block');

// 6. nextValleyMinutes 的落点确实是谷时
const wait = gate.nextValleyMinutes(base, mondayPeak, 'deepseek-flash');
assert.ok(wait > 0, '周一 17:00 之后应能找到谷时');
assert.equal(gate.phaseAt(base, new Date(mondayPeak.getTime() + wait * 60000), 'deepseek-flash').valley, true);

// 7. CLI：周末放行、周一峰时拦截、混合计划只拦一部分
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cost-gate-'));
const pricesPath = path.join(tmp, 'prices.json');
const planPath = path.join(tmp, 'plan.json');
fs.writeFileSync(pricesPath, JSON.stringify(custom, null, 2));
fs.writeFileSync(planPath, JSON.stringify(mixedPlan, null, 2));

const sunday = run([CLI, '--plan', planPath, '--prices', pricesPath, '--now', '2026-11-08T17:00:00+08:00', '--json']);
assert.equal(sunday.status, 0, '周末应 exit 0');
assert.equal(JSON.parse(sunday.stdout).phase, 'valley');
assert.equal(JSON.parse(sunday.stdout).blocked, 0);

const monday = run([CLI, '--plan', planPath, '--prices', pricesPath, '--now', '2026-11-09T23:00:00+08:00', '--json']);
assert.equal(monday.status, 1, '周一峰时混合计划应 exit 1');
const mondayJson = JSON.parse(monday.stdout);
assert.equal(mondayJson.phase, 'mixed');
assert.equal(mondayJson.blocked, 1);
assert.deepEqual(mondayJson.advice.now, ['night-big']);
assert.deepEqual(mondayJson.advice.later, ['flash-big']);

// 8. phase-watch：周日 once 写 valley 状态，状态里含每个模型
const watchPrices = clone(custom);
delete watchPrices.models['weekday-only'];
const watchPricesPath = path.join(tmp, 'prices-watch.json');
fs.writeFileSync(watchPricesPath, JSON.stringify(watchPrices, null, 2));
const stateDir = path.join(tmp, 'state');
const watch = run([WATCH, '--once', '--now', '2026-11-08T17:00:00+08:00'], {
  DSH_COST_GATE_CONFIG: watchPricesPath,
  DSH_COST_GATE_STATE_DIR: stateDir,
});
assert.equal(watch.status, 0);
assert.match(watch.stdout, /overall=valley/);
const state = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'));
assert.equal(state.phase, 'valley');
assert.ok(state.phases.some((item) => item.model === 'deepseek-flash' && item.phase === 'valley'));
assert.ok(fs.existsSync(path.join(stateDir, 'RESUME.md')));

console.log('cost-gate phase tests passed');
