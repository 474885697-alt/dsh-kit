#!/usr/bin/env node
'use strict';

/**
 * dsh-team-ops / 团队状态快照渲染（自包含）。
 *
 * 读 docs/tmp/team-status.json（或指定路径），渲染单文件 HTML，
 * 并可从投递日志取最近 8 条记录。不依赖仓库内其他脚本。
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = process.env.DSH_TEAM_ROOT
  ? path.resolve(process.env.DSH_TEAM_ROOT)
  : path.resolve(__dirname, '..', '..', '..');
const DEFAULT_SNAPSHOT = path.join(ROOT, 'docs', 'tmp', 'team-status.json');
const OUTPUT = path.join(ROOT, 'docs', 'team-status', 'index.html');
const LOG_PATH = process.env.DSH_QQ_DELIVERY_LOG
  || path.join(ROOT, 'docs', 'tmp', 'qq-delivery-log.jsonl');

function readSnapshot(snapshotPath = DEFAULT_SNAPSHOT) {
  try {
    return JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  } catch {
    return {
      generatedAt: new Date().toISOString(),
      members: [],
      tasks: { total: 0, done: 0, inProgress: 0, pending: 0, items: [] },
      hub: { inbox: 0, queued: 0, executing: 0, summarizing: 0 },
      deliveries: [],
    };
  }
}

function readDeliveries(logPath = LOG_PATH, limit = 8) {
  try {
    return fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).slice(-limit).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function statusLabel(status) {
  return ({
    running: '运行中',
    idle: '空闲',
    inactive: '空闲',
    blocked: '阻塞',
    done: '完成',
    in_progress: '进行中',
    pending: '待领取',
  })[status] || status || '未知';
}

function render(snapshot, deliveries = readDeliveries()) {
  const members = Array.isArray(snapshot.members) ? snapshot.members : [];
  const tasks = snapshot.tasks || {};
  const hub = snapshot.hub || {};
  const items = Array.isArray(tasks.items) ? tasks.items : [];
  const running = members.filter((m) => ['running', 'in_progress'].includes(m.status)).length;

  const memberCards = members.map((m) => `
    <article class="member ${esc(m.status)}">
      <div class="member-top"><strong>${esc(m.name)}</strong><span class="pill">${esc(statusLabel(m.status))}</span></div>
      <p>${esc(m.task || m.note || '待命')}</p>
    </article>`).join('');

  const taskRows = items.map((t) => `
    <tr><td class="mono">${esc(t.id)}</td><td>${esc(t.subject)}</td><td>${esc(t.owner)}</td><td>${esc(statusLabel(t.status))}</td></tr>`).join('');

  const deliveryRows = deliveries.map((d) => `
    <tr><td class="mono">${esc(d.at?.slice(11, 19))}</td><td>${esc(d.mode)}</td><td class="${d.ok ? 'ok' : 'bad'}">${d.ok ? '成功' : '失败'}</td><td>${esc(d.preview)}</td></tr>`).join('');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>寻神者 · 团队状态</title>
<style>
:root{color-scheme:dark;--bg:#11130f;--panel:#1b1e17;--line:#363b2d;--text:#ece8dc;--muted:#9f9b8d;--gold:#d8b56a;--green:#8fbe6a;--red:#d17b6a}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 20% 0%,#20241a,#11130f 55%);color:var(--text);font:14px/1.6 "Segoe UI",system-ui,sans-serif}
main{max-width:1080px;margin:0 auto;padding:32px 20px 64px}header{display:flex;flex-wrap:wrap;gap:12px;align-items:end;justify-content:space-between;border-bottom:1px solid var(--line);padding-bottom:16px;margin-bottom:24px}
h1{font-size:22px;letter-spacing:.08em;margin:0;color:var(--gold)}h2{font-size:14px;letter-spacing:.12em;color:var(--gold);margin:28px 0 12px;text-transform:uppercase}
.muted{color:var(--muted)}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px}
.stat,.member{background:linear-gradient(180deg,#20241a,#191c15);border:1px solid var(--line);border-radius:12px;padding:14px}
.stat b{display:block;font-size:24px;color:var(--gold)}.member-top{display:flex;justify-content:space-between;gap:8px;align-items:center}.member p{margin:6px 0 0;color:var(--muted);font-size:13px}
.pill{font-size:11px;border:1px solid var(--line);border-radius:999px;padding:2px 8px;color:var(--muted)}.running .pill,.in_progress .pill{color:var(--green);border-color:#4d633e}
table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:hidden}th,td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:500;font-size:12px}tr:last-child td{border-bottom:0}
.mono{font-family:Consolas,monospace;font-size:12px;color:var(--gold)}.ok{color:var(--green)}.bad{color:var(--red)}
@media(max-width:560px){main{padding:20px 12px 48px}th:nth-child(3),td:nth-child(3){display:none}}
</style>
</head>
<body><main>
<header><div><h1>寻神者 · 团队状态</h1><div class="muted">快照 ${esc(snapshot.generatedAt || '')} · 页面自动刷新 30s</div></div><div class="muted">Lead：只决策 / 合并 / 对外汇报</div></header>
<section class="grid">
  <div class="stat"><span class="muted">成员</span><b>${members.length}</b><span class="muted">运行 ${running} / 空闲 ${Math.max(0, members.length - running)}</span></div>
  <div class="stat"><span class="muted">任务</span><b>${Number(tasks.total || 0)}</b><span class="muted">完成 ${Number(tasks.done || 0)} / 进行 ${Number(tasks.inProgress || 0)} / 待领 ${Number(tasks.pending || 0)}</span></div>
  <div class="stat"><span class="muted">中枢</span><b>${Number(hub.executing || 0)}</b><span class="muted">受理 ${Number(hub.inbox || 0)} / 排队 ${Number(hub.queued || 0)} / 待汇总 ${Number(hub.summarizing || 0)}</span></div>
</section>
<h2>成员</h2><section class="grid">${memberCards || '<p class="muted">暂无成员数据</p>'}</section>
<h2>当前任务</h2><table><thead><tr><th>ID</th><th>任务</th><th>Owner</th><th>状态</th></tr></thead><tbody>${taskRows || '<tr><td colspan="4" class="muted">暂无进行中的任务</td></tr>'}</tbody></table>
<h2>最近投递</h2><table><thead><tr><th>时间</th><th>通道</th><th>结果</th><th>内容</th></tr></thead><tbody>${deliveryRows || '<tr><td colspan="4" class="muted">暂无投递记录</td></tr>'}</tbody></table>
<p class="muted" style="margin-top:28px">数据源：docs/tmp/team-status.json · 投递日志：docs/tmp/qq-delivery-log.jsonl</p>
</main><script>setTimeout(()=>location.reload(),30000)</script></body></html>`;
}

function summary(snapshot) {
  return {
    generatedAt: snapshot.generatedAt,
    members: snapshot.members?.length || 0,
    tasks: snapshot.tasks || {},
    hub: snapshot.hub || {},
  };
}

function writeStatus(snapshot, deliveries) {
  const html = render(snapshot, deliveries);
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, html, 'utf8');
  return { ok: true, output: OUTPUT, bytes: Buffer.byteLength(html) };
}

module.exports = {
  ROOT,
  DEFAULT_SNAPSHOT,
  OUTPUT,
  LOG_PATH,
  readSnapshot,
  readDeliveries,
  render,
  summary,
  writeStatus,
};
