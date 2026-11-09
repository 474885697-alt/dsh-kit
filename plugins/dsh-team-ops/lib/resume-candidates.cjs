#!/usr/bin/env node
'use strict';

/**
 * A-lite：重启候选只读清单（不是自动恢复）。
 *
 * 只读来源：
 *   - docs/tmp/team-status.json（任务板快照：tasks.items）
 *   - docs/tmp/team-ops-handoff.json（可选交接文件：items 数组）
 *
 * 不 spawn 进程、不跑 turn、不发 QQ、不广播；session 映射缺失时字段写 null 并注明来源不足。
 * A-lite 启动扫描只写 docs/tmp/hub/resume-candidates.json（带文件锁，原子替换），不自动续跑。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const queueStore = require('./approval-queue.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const DONE_STATUSES = new Set(['done', 'completed', 'cancelled', 'canceled', 'closed', 'merged']);

function snapshotPath() {
  return process.env.DSH_TEAM_SNAPSHOT || path.join(ROOT, 'docs', 'tmp', 'team-status.json');
}
function handoffPath() {
  return process.env.DSH_TEAM_OPS_HANDOFF || path.join(ROOT, 'docs', 'tmp', 'team-ops-handoff.json');
}
function outPath() {
  return process.env.DSH_TEAM_OPS_RESUME_OUT || path.join(ROOT, 'docs', 'tmp', 'hub', 'resume-candidates.json');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function candidateOf(input, source) {
  const blockedBy = Array.isArray(input.blockedBy) ? input.blockedBy.map(String) : [];
  const status = String(input.status || '').toLowerCase();
  const blocked = status === 'blocked' || blockedBy.length > 0;
  return {
    sessionId: input.sessionId ? String(input.sessionId) : null,
    lastTurnId: input.lastTurnId != null ? input.lastTurnId : null,
    taskId: input.taskId ? String(input.taskId) : (input.id ? String(input.id) : null),
    owner: input.owner ? String(input.owner) : null,
    reason: blocked ? 'blocked' : (input.reason ? String(input.reason) : (status || 'unknown')),
    blockedBy,
    recommendedAction: blocked ? 'needs-human' : (input.recommendedAction || (status === 'in_progress' ? 'resume-after-restart' : 'dispatch-when-free')),
    source,
  };
}

function dedupeKey(candidate) {
  if (candidate.sessionId && candidate.lastTurnId != null) return `${candidate.sessionId}:${candidate.lastTurnId}`;
  return `task:${candidate.taskId || candidate.reason}`;
}

function scan(input = {}) {
  const snapFile = input.snapshotPath || snapshotPath();
  const handoffFile = input.handoffPath || handoffPath();
  const snapshot = readJson(snapFile);
  const handoff = readJson(handoffFile);
  const sources = {
    snapshot: { path: snapFile, found: !!snapshot, tasks: 0 },
    handoff: { path: handoffFile, found: !!handoff, items: 0 },
    sessionMapping: 'unavailable',
    note: 'sessionId/lastTurnId 为 null 表示当前来源没有 session 映射；不猜。',
  };

  const raw = [];
  const taskItems = Array.isArray(snapshot?.tasks?.items) ? snapshot.tasks.items : (Array.isArray(snapshot?.items) ? snapshot.items : []);
  sources.snapshot.tasks = taskItems.length;
  for (const task of taskItems) {
    const status = String(task?.status || '').toLowerCase();
    if (DONE_STATUSES.has(status)) continue;
    raw.push(candidateOf({
      sessionId: task.sessionId,
      lastTurnId: task.lastTurnId,
      taskId: task.id || task.taskId,
      owner: task.owner || task.ownerName,
      status,
      blockedBy: task.blockedBy,
      reason: status,
    }, 'snapshot'));
  }

  const handoffItems = Array.isArray(handoff?.items) ? handoff.items : (Array.isArray(handoff) ? handoff : []);
  sources.handoff.items = handoffItems.length;
  for (const item of handoffItems) {
    if (String(item?.status || '').toLowerCase() === 'done') continue;
    raw.push(candidateOf(item, 'handoff'));
  }

  const seen = new Set();
  const candidates = [];
  for (const candidate of raw.sort((a, b) => String(a.taskId || a.reason).localeCompare(String(b.taskId || b.reason)))) {
    const key = dedupeKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(candidate);
  }

  const scannedAt = new Date().toISOString();
  return {
    ok: true,
    scannedAt,
    generatedAt: scannedAt,
    count: candidates.length,
    candidates,
    sources,
    note: '候选清单不是自动恢复：真实续跑仍需用户/Lead 手动执行 dsh --profile headless --session-id <id>。',
  };
}

function writeResult(result) {
  const file = outPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return queueStore.withLock(() => {
    queueStore.atomicWriteJson(file, result);
    return { ok: true, written: true, path: file, count: result.count };
  }, file);
}

module.exports = { scan, writeResult, snapshotPath, handoffPath, outPath, dedupeKey, candidateOf };
