#!/usr/bin/env node
'use strict';

/**
 * dsh-team-ops / 0.3.2 工单审批状态门（自包含）。
 *
 * 目的：用户还没明确同意时，不允许建卡/派发。审批单由 `team_approval` 工具维护，
 * 状态 pending → approved → rejected/withdrawn；`tools/pre-execute` 拦截
 * `team_task_create`，description 必须同时含：
 *   approvedByUser: true
 *   approvalRef: apv-...
 * 且该审批单为 approved、未过期、未撤回/驳回，才放行；放行与拒绝都写审计日志。
 *
 * 状态文件：DSH_TEAM_OPS_APPROVALS（默认 <root>/docs/tmp/team-ops-approvals.json）
 * 审计日志：DSH_TEAM_OPS_APPROVAL_AUDIT（默认同目录 team-ops-approvals-audit.jsonl）
 * 不访问网络；不改平台工具本体。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const queueStore = require('./approval-queue.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const TTL_MS = 24 * 60 * 60 * 1000;
const APPROVED_RE = /approvedByUser\s*[:=]\s*true\b/i;
const REF_RE = /approvalRef\s*[:=]\s*["']?([A-Za-z0-9._-]{4,})/i;

function statePath() {
  const fromEnv = process.env.DSH_TEAM_OPS_APPROVALS;
  return fromEnv && fromEnv.trim() ? fromEnv : path.join(ROOT, 'docs', 'tmp', 'team-ops-approvals.json');
}

function auditPath() {
  const fromEnv = process.env.DSH_TEAM_OPS_APPROVAL_AUDIT;
  return fromEnv && fromEnv.trim() ? fromEnv : path.join(path.dirname(statePath()), 'team-ops-approvals-audit.jsonl');
}

/**
 * A1：把旧审批单里的 pending 一次性迁移进 approval-queue（幂等）。
 * 迁移结果缓存在进程内；失败不阻塞审批主流程。
 */
let queueMigration = null;
function ensureQueueMigrated() {
  if (queueMigration) return queueMigration;
  try {
    queueMigration = queueStore.migrateLegacy();
  } catch (error) {
    queueMigration = { ok: false, migrated: 0, error: String(error && error.message ? error.message : error) };
  }
  return queueMigration;
}

function load() {
  ensureQueueMigrated();
  try {
    const data = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
    return {
      version: 1,
      seq: Number(data?.seq) || 0,
      items: data && typeof data.items === 'object' && data.items ? data.items : {},
    };
  } catch {
    return { version: 1, seq: 0, items: {} };
  }
}

function save(state) {
  state.updatedAt = new Date().toISOString();
  try {
    fs.mkdirSync(path.dirname(statePath()), { recursive: true });
    const tmp = `${statePath()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, statePath());
  } catch { /* 状态写失败不阻塞调用方返回 */ }
}

function newId() {
  return `apv-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

function create({ summary, quote, source, ttlMs = TTL_MS } = {}) {
  const text = String(summary || '').trim();
  if (!text) throw new Error('summary is required (用户原话摘要)');
  const state = load();
  const createdAt = new Date().toISOString();
  const item = {
    id: newId(),
    summary: text.slice(0, 300),
    quote: String(quote || '').trim().slice(0, 600),
    source: String(source || 'unknown').slice(0, 80),
    status: 'pending',
    createdAt,
    expiresAt: new Date(Date.now() + Math.max(60000, Number(ttlMs) || TTL_MS)).toISOString(),
    usedCount: 0,
    lastUsedAt: null,
  };
  state.seq += 1;
  state.items[item.id] = item;
  save(state);
  appendAudit({ action: 'create', code: 'pending', approvalId: item.id, summary: item.summary });
  return item;
}

function get(id) {
  const state = load();
  const item = state.items[String(id || '')] || null;
  return item ? { ...item, effectiveStatus: derivedStatus(item) } : null;
}

function list(filter = {}) {
  const state = load();
  let items = Object.values(state.items).map((item) => ({ ...item, effectiveStatus: derivedStatus(item) }));
  if (filter.status) items = items.filter((item) => item.effectiveStatus === filter.status);
  return items.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

function counts() {
  const out = { total: 0, pending: 0, approved: 0, rejected: 0, withdrawn: 0, expired: 0 };
  for (const item of list()) {
    out.total += 1;
    const key = item.effectiveStatus;
    if (out[key] !== undefined) out[key] += 1;
  }
  return out;
}

function isExpired(item) {
  return Boolean(item?.expiresAt) && Date.parse(item.expiresAt) < Date.now();
}

// 派生状态：过期优先于原状态（approved 过期后也算 expired，不再计入 approved）。
function derivedStatus(item) {
  return isExpired(item) ? 'expired' : item.status;
}

function setStatus(id, status, meta = {}) {
  if (!['approved', 'rejected', 'withdrawn'].includes(status)) throw new Error(`unsupported status: ${status}`);
  const state = load();
  const item = state.items[String(id || '')];
  if (!item) throw new Error(`unknown approval: ${id}`);
  if (item.status === 'withdrawn') throw new Error('approval already withdrawn');
  if (item.status === 'rejected' && status !== 'withdrawn') throw new Error('approval already rejected');
  if (isExpired(item) && status !== 'withdrawn') throw new Error('approval expired');
  item.status = status;
  item[`${status}At`] = new Date().toISOString();
  if (meta?.by) item[`${status}By`] = String(meta.by).slice(0, 80);
  if (meta?.note) item.note = String(meta.note).slice(0, 300);
  save(state);
  appendAudit({ action: status, code: status, approvalId: item.id, summary: item.summary });
  return item;
}

function approve(id, meta) { return setStatus(id, 'approved', meta); }
function reject(id, meta) { return setStatus(id, 'rejected', meta); }
function withdraw(id, meta) { return setStatus(id, 'withdrawn', meta); }

function gate(description, opts = {}) {
  const text = typeof description === 'string' ? description : '';
  const state = opts.state || load();
  if (!APPROVED_RE.test(text)) {
    return { allowed: false, code: 'missing-approved-by-user', message: 'description 缺少 approvedByUser: true（用户尚未明确同意）' };
  }
  const refMatch = text.match(REF_RE);
  if (!refMatch) {
    return { allowed: false, code: 'missing-approval-ref', message: 'description 缺少 approvalRef（先调用 team_approval request）' };
  }
  const approvalRef = refMatch[1];
  const item = state.items[approvalRef];
  if (!item) return { allowed: false, code: 'unknown-approval', approvalRef, message: `未知审批单 ${approvalRef}` };
  const effective = derivedStatus(item);
  if (effective === 'expired') return { allowed: false, code: 'expired', approvalRef, message: `审批单 ${approvalRef} 已过期` };
  if (effective === 'pending') return { allowed: false, code: 'not-approved', approvalRef, message: `审批单 ${approvalRef} 仍是 pending，需用户明确同意后 approve` };
  if (effective === 'rejected') return { allowed: false, code: 'rejected', approvalRef, message: `审批单 ${approvalRef} 已被驳回` };
  if (effective === 'withdrawn') return { allowed: false, code: 'withdrawn', approvalRef, message: `审批单 ${approvalRef} 已撤回，不得再派发` };
  if (effective !== 'approved') return { allowed: false, code: 'invalid-status', approvalRef, message: `审批单状态异常：${item.status}` };
  return { allowed: true, code: 'ok', approvalRef, approval: item };
}

function markUsed(approvalRef, meta = {}) {
  const state = load();
  const item = state.items[String(approvalRef || '')];
  if (!item) return null;
  item.usedCount = Number(item.usedCount || 0) + 1;
  item.lastUsedAt = new Date().toISOString();
  if (meta?.note) item.lastNote = String(meta.note).slice(0, 200);
  save(state);
  return item;
}

function appendAudit(entry) {
  try {
    fs.mkdirSync(path.dirname(auditPath()), { recursive: true });
    fs.appendFileSync(auditPath(), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, 'utf8');
  } catch { /* 审计写失败不阻塞 */ }
}

function recentAudit(limit = 20) {
  try {
    const lines = fs.readFileSync(auditPath(), 'utf8').trim().split(/\r?\n/).filter(Boolean);
    return lines.slice(-limit).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  } catch {
    return [];
  }
}

module.exports = {
  statePath,
  auditPath,
  ensureQueueMigrated,
  load,
  save,
  create,
  get,
  list,
  counts,
  gate,
  approve,
  reject,
  withdraw,
  markUsed,
  appendAudit,
  recentAudit,
  isExpired,
  derivedStatus,
  TTL_MS,
};
