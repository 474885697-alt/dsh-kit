#!/usr/bin/env node
/**
 * phase-watch —— 峰谷相位监视器（成本闸门配套）
 *
 * 作用：
 *   1. 按 prices.json 里每个模型的 phasePlan / valley 覆盖，判断当前各模型的峰谷；
 *      周末（周六/周日）默认全天谷时。
 *   2. 相位或模型相位组合变化时写 state.json + events.jsonl，并生成 PAUSE.md / RESUME.md。
 *   3. 打印变化，供会话/定时任务看到后执行暂停或续做。
 *
 * 用法：
 *   node plugins/dsh-cost-gate/phase-watch.cjs --once
 *   node plugins/dsh-cost-gate/phase-watch.cjs --once --now 2026-11-08T23:00:00+08:00
 *   node plugins/dsh-cost-gate/phase-watch.cjs --once --prices prices.test.json
 *   node plugins/dsh-cost-gate/phase-watch.cjs --watch --interval 60
 *   node plugins/dsh-cost-gate/phase-watch.cjs --state
 *
 * 说明：
 *   本脚本只负责「发现相位变化 + 写操作单」，不直接暂停成员；
 *   暂停动作由会话执行（interrupt_agent + 写进度快照），因为插件/脚本拿不到 Team 工具。
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

const pricesPath = arg('prices') && arg('prices') !== true
  ? path.resolve(String(arg('prices')))
  : process.env.DSH_COST_GATE_CONFIG
    ? path.resolve(process.env.DSH_COST_GATE_CONFIG)
    : path.join(__dirname, 'prices.json');
const PRICES = JSON.parse(fs.readFileSync(pricesPath, 'utf8'));
const STATE_DIR = process.env.DSH_COST_GATE_STATE_DIR
  || path.join(os.homedir(), '.dsh', 'dsh-cost-gate');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const EVENTS_FILE = path.join(STATE_DIR, 'events.jsonl');

function ensureDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function writeAtomic(file, text) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

function signatureOf(summary) {
  return summary.phases
    .map((item) => `${item.model}:${item.valley ? 'v' : 'p'}`)
    .sort()
    .join('|');
}

function pauseGuide(summary, nowIso) {
  const peak = summary.phases.filter((item) => !item.valley);
  const valley = summary.phases.filter((item) => item.valley);
  return `# 峰时开始（${nowIso}）

当前峰时模型：${peak.length ? peak.map((item) => `${item.model}（${item.planName}，阈值 ¥${item.thresholdCNY}）`).join('、') : '无'}
当前谷时模型：${valley.length ? valley.map((item) => `${item.model}（${item.planName}）`).join('、') : '无'}

闸门规则：峰时单任务估算 > 该模型阈值且非纯本地运行 → 拦截；周末（周六/周日）全天按谷时，不拦截。

## 现在要做

1. 列出正在跑的成员（list_agents），只暂停「跑着峰时模型高估价任务」的成员；谷时模型的任务可以继续。
2. 给每个被暂停的任务写进度快照：\`docs/协作/进度快照/<任务id>.md\`
   - 已完成 / 正在改的文件 / 下一步第一条命令 / 卡点 / 重开需要的上下文。
3. 把未开工且超阈值的任务写进 \`docs/协作/等待队列.md\`（模块 / 模型 / 估价 / 状态=等谷时）。
4. 峰时可做：本地构建、看图、跑检查、写文档、拆任务、估价；不要 spawn/唤醒成员做峰时模型超阈值活。
5. 等到对应模型的谷时后，重跑 \`cost-gate --queue\` 与 \`cost_gate\`，按队列续做。
`;
}

function resumeGuide(summary, nowIso) {
  return `# 谷时开始（${nowIso}）

当前全部模型处于谷时/周末，闸门自动放行，不再拦截。按顺序续做：

1. 读 \`docs/协作/等待队列.md\`，取出「等谷时」的任务。
2. 重跑 \`node plugins/dsh-cost-gate/cost-gate.cjs --plan <plan>\`，确认全部可放行。
3. 对每个任务读 \`docs/协作/进度快照/<任务id>.md\`，按「下一步第一条命令」续做。
4. 需要成员继续的，send_message 唤醒；成员已随会话关闭的，在本会话直接做或重新 spawn。
5. 完成后更新队列状态与快照，避免下次重复。
`;
}

function transition(summary, nowIso) {
  ensureDir();
  const prev = readState();
  const signature = signatureOf(summary);
  const changed = !prev || prev.phase !== summary.overall || prev.signature !== signature;
  const state = {
    phase: summary.overall,
    since: changed ? nowIso : (prev && prev.since) || nowIso,
    updatedAt: nowIso,
    signature,
    phases: summary.phases.map((item) => ({
      model: item.model,
      phase: item.phase,
      planName: item.planName,
      thresholdCNY: item.thresholdCNY,
      windowLabel: item.windowLabel,
    })),
    valleyWindow: gate.phaseAt(PRICES, new Date(nowIso), PRICES.defaultModel).windowLabel,
    thresholdCNY: PRICES.thresholdCNY,
    weekendValley: PRICES.weekendValley !== false,
  };
  if (!changed) {
    writeAtomic(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
    return false;
  }
  writeAtomic(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
  fs.appendFileSync(EVENTS_FILE, JSON.stringify({
    ts: nowIso,
    from: prev ? prev.phase : null,
    to: summary.overall,
    signature,
    phases: state.phases,
  }) + '\n', 'utf8');
  if (summary.overall === 'valley') {
    writeAtomic(path.join(STATE_DIR, 'RESUME.md'), resumeGuide(summary, nowIso));
  } else {
    writeAtomic(path.join(STATE_DIR, 'PAUSE.md'), pauseGuide(summary, nowIso));
  }
  console.log(`[phase-watch] ${prev ? prev.phase : '(unknown)'} -> ${summary.overall} @ ${nowIso}`);
  console.log(summary.overall === 'valley'
    ? '[phase-watch] 执行单已写：' + path.join(STATE_DIR, 'RESUME.md')
    : '[phase-watch] 执行单已写：' + path.join(STATE_DIR, 'PAUSE.md'));
  return true;
}

function printSummary(summary, nowIso) {
  console.log(`[phase-watch] now=${nowIso} overall=${summary.overall}`);
  for (const item of summary.phases) {
    console.log(`- ${item.model}：${item.valley ? '谷时' : '峰时'} | 方案 ${item.planName} | 谷时窗口 ${item.windowLabel} | 阈值 ¥${item.thresholdCNY}`);
  }
}

const nowIso = arg('now')
  ? new Date(String(arg('now'))).toISOString()
  : new Date().toISOString();

if (arg('state')) {
  const state = readState();
  console.log(state ? JSON.stringify(state, null, 2) : '尚无状态文件；先跑 --once');
  process.exit(0);
}

if (arg('once')) {
  const summary = gate.phaseSummary(PRICES, new Date(nowIso));
  transition(summary, nowIso);
  printSummary(summary, nowIso);
  process.exit(0);
}

const interval = Number(arg('interval', 60)) * 1000;
function tick() {
  const at = new Date().toISOString();
  const summary = gate.phaseSummary(PRICES, new Date(at));
  transition(summary, at);
}
tick();
setInterval(tick, interval);
console.log(`[phase-watch] watching every ${interval / 1000}s；Ctrl+C 退出`);
