#!/usr/bin/env node
/**
 * cost-gate —— 派活前的成本闸门（CLI，无插件依赖）
 *
 * 规则：
 *   周末（周六/周日，Asia/Shanghai）默认全天谷时，只预估、不拦截。
 *   谷时：只给预估，不拦截任何运行。
 *   峰时：单任务估算 ≤ 模型阈值，或可完全本地运行 → 放行；否则拦截。
 *   每个模型可挂 phasePlan，或覆盖 valley / weekendValley / thresholdCNY；
 *   一个计划里不同模型可以落在不同相位，只拦峰时模型的任务。
 *
 * 用法：
 *   node plugins/dsh-cost-gate/cost-gate.cjs --plan plan.json
 *   node plugins/dsh-cost-gate/cost-gate.cjs --plan plan.json --now 2026-11-08T02:00:00+08:00 --json
 *   node plugins/dsh-cost-gate/cost-gate.cjs --plan plan.json --prices prices.test.json
 *   node plugins/dsh-cost-gate/cost-gate.cjs --queue
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const gate = require('./lib/phase.cjs');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const planPath = arg('plan');
const queueArg = arg('queue');
const taskArg = arg('check-task');
if (!planPath && !queueArg && !taskArg) {
  console.error('缺少 --plan <file.json>（或 --queue 查看等待队列，或 --check-task <任务卡.md>）');
  process.exit(2);
}

const pricesPath = arg('prices') && arg('prices') !== true
  ? path.resolve(String(arg('prices')))
  : process.env.DSH_COST_GATE_CONFIG
    ? path.resolve(process.env.DSH_COST_GATE_CONFIG)
    : path.join(__dirname, 'prices.json');
const PRICES = JSON.parse(fs.readFileSync(pricesPath, 'utf8'));
const now = arg('now') ? new Date(String(arg('now'))) : new Date();
const asJson = !!arg('json', false);
const asAdvise = !!arg('advise', false);

if (taskArg) {
  const { checkTask } = require('./lib/task-gate.cjs');
  const text = taskArg === true
    ? require('fs').readFileSync(0, 'utf8')
    : require('fs').readFileSync(path.resolve(String(taskArg)), 'utf8');
  const result = checkTask(text, { prices: PRICES, now });
  if (asJson) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    const phaseLabel = result.phase === 'valley' ? '谷时' : result.phase === 'peak' ? '峰时' : '相位未知';
    console.log(`[${phaseLabel}] 模型 ${result.model} / 方案 ${result.plan || '-'} | 上限 ¥${result.capCNY ?? '-'} / 估算 ¥${result.estimateCNY ?? '-'} | ${result.ok ? '放行' : '拦截'} | ${result.reason}`);
  }
  process.exit(result.ok ? 0 : 1);
}

if (queueArg) {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const file = queueArg === true ? path.join(home, 'dsh-cost-gate', 'blocked.jsonl') : String(queueArg);
  let rows = [];
  try {
    rows = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return { ts: '', tool: '?', reason: line }; }
    });
  } catch {
    console.log('等待队列为空或不存在：' + file);
    process.exit(0);
  }
  const summary = gate.phaseSummary(PRICES, now);
  console.log(`等待队列 ${file}（${rows.length} 条）`);
  for (const r of rows) console.log(`- ${r.ts} ${r.tool} | ${r.reason}`);
  const phaseText = summary.phases
    .map((item) => `${item.model}=${item.valley ? '谷时' : '峰时'}`)
    .join('、');
  console.log(`当前模型相位：${phaseText || '(无模型)'}`);
  if (summary.overall === 'valley') {
    console.log('当前全部谷时/周末：以上调用可直接重新执行。');
  } else {
    const peak = summary.phases.filter((item) => !item.valley);
    const wait = peak.length ? gate.nextValleyMinutes(PRICES, now, peak[0].model) : null;
    console.log(`当前仍有峰时模型${wait === null ? '' : `；最近谷时约 ${gate.fmtDuration(wait)} 后`}。峰时模型的任务先估价或等谷时。`);
  }
  process.exit(0);
}

const plan = JSON.parse(fs.readFileSync(path.resolve(String(planPath)), 'utf8'));
const result = gate.evaluate(PRICES, plan, now);

if (asJson) {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} else {
  const phaseLabel = result.phase === 'valley'
    ? '谷时'
    : result.phase === 'peak'
      ? '峰时'
      : result.phase === 'mixed'
        ? '混合'
        : '无任务';
  console.log(`[${phaseLabel}] now=${result.now} 默认谷时窗口 ${result.valleyWindow} 默认阈值 ¥${result.thresholdCNY}${PRICES.weekendValley !== false ? '（周末全天谷时）' : ''}`);
  for (const row of result.tasks) {
    const tag = row.decision === 'allow' ? '放行' : '拦截';
    const phaseTag = row.phase === 'valley' ? '谷时' : '峰时';
    console.log(`- [${phaseTag}] ${row.id} ${row.name} | 模型 ${row.model} / ${row.plan} | 峰时 ¥${row.estPeakCNY.toFixed(2)} / 谷时 ¥${row.estValleyCNY.toFixed(2)} | ${tag} | ${row.reason}`);
  }
  console.log(`合计：峰时 ¥${result.totalPeakCNY.toFixed(2)} / 谷时 ¥${result.totalValleyCNY.toFixed(2)}；拦截 ${result.blocked} 条`);
  if (result.advice.now.length || result.advice.later.length) {
    const parts = [];
    if (result.advice.now.length) parts.push(`现在派 ${result.advice.now.join('、')}`);
    if (result.advice.later.length) parts.push(`${result.advice.later.join('、')} 等谷时或拆小`);
    console.log('建议：' + parts.join('；'));
  }

  if (asAdvise) {
    const safe = result.tasks.filter((row) => row.decision === 'allow');
    const hold = result.tasks.filter((row) => row.decision === 'block');
    const byMember = new Map();
    for (const row of safe) {
      const key = row.member || '(未指定)';
      if (!byMember.has(key)) byMember.set(key, []);
      byMember.get(key).push(`${row.id} ¥${row.estPeakCNY.toFixed(2)}${row.phase === 'valley' ? '（谷时）' : ''}${row.localOnly ? '（本地）' : ''}`);
    }
    console.log('\n峰谷执行建议（按成员；阈值按模型）：');
    if (byMember.size === 0) console.log('- 无：没有可放行的任务，全部挂起');
    for (const [member, items] of byMember) console.log(`- ${member}：${items.join('、')}`);
    if (hold.length) {
      console.log('挂起（等谷时或拆小）：');
      for (const row of hold) {
        const n = Math.ceil(row.estPeakCNY / row.thresholdCNY);
        console.log(`- ${row.member || '(未指定)'}：${row.id} ¥${row.estPeakCNY.toFixed(2)}，至少拆 ${n} 段`);
      }
    }
  }
}

process.exit(result.blocked === 0 ? 0 : 1);
