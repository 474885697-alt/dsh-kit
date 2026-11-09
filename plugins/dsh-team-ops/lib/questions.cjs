#!/usr/bin/env node
'use strict';

/**
 * dsh-team-ops / 0.3.3 提问卡与待答队列（自包含）。
 *
 * 状态文件：env DSH_TEAM_OPS_QUESTIONS 或 <repo>/docs/tmp/team-ops-questions.json。
 * 一条提问：{ id, question, options[2..4], deadline, status, approvalId,
 *            delivery:{mode,messageId,error}, answer:{option,by,at}, remindedAt }
 * status: open | answered | closed | expired
 *
 * 约定：
 * - 只由 Lead 会话发起/关闭（由 commands 里的 lead-gate 判定）。
 * - 发送失败不假装送达：delivery.mode='pending' + error 写清楚；只有拿到 messageId 才算送达。
 * - 回答与提醒均幂等：重复回答同选项返回 already:true；同一提醒只发一次。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const qq = require('./qq.cjs');
const approvals = require('./approvals.cjs');

const DEFAULT_MINUTES = 30;
const MAX_OPTIONS = 4;
const MIN_OPTIONS = 2;

function statePath() {
  return process.env.DSH_TEAM_OPS_QUESTIONS || path.join(ROOT, 'docs', 'tmp', 'team-ops-questions.json');
}

function load() {
  try {
    const data = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
    if (!data || typeof data !== 'object' || !data.items) return { version: 1, items: {} };
    return data;
  } catch {
    return { version: 1, items: {} };
  }
}

function save(state) {
  fs.mkdirSync(path.dirname(statePath()), { recursive: true });
  const tmp = `${statePath()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, statePath());
}

function newId() {
  return `q-${crypto.randomBytes(3).toString('hex')}`;
}

function isExpired(item, now = Date.now()) {
  return item.status === 'open' && Date.parse(item.deadline) <= now;
}

function derivedStatus(item, now = Date.now()) {
  if (item.status === 'open' && isExpired(item, now)) return 'expired';
  return item.status;
}

function remainingLabel(item, now = Date.now()) {
  const ms = Date.parse(item.deadline) - now;
  if (item.status !== 'open') return '—';
  if (ms <= 0) return '已超时';
  const minutes = Math.ceil(ms / 60000);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h${minutes % 60}m` : `${minutes}m`;
}

async function defaultSend(text) {
  if (process.env.DSH_TEAM_OPS_DRY_RUN === '1') {
    return { ok: true, messageId: `dry-${crypto.createHash('sha1').update(text).digest('hex').slice(0, 12)}` };
  }
  try {
    const result = await qq.sendSdkRequired(text);
    return result?.ok && result.messageId
      ? { ok: true, messageId: result.messageId }
      : { ok: false, error: result?.error || 'send failed' };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

function cardText(id, item) {
  const lines = [`【待答】${item.question}`, ...item.options.map((opt, index) => `${index + 1}) ${opt}`),
    `截止：${item.deadline}`, `回复：/回答 ${id} <选项>`];
  if (item.approvalId) lines.push(`关联审批：${item.approvalId}`);
  return lines.join('\n');
}

function buildItem({ question, options, minutes = DEFAULT_MINUTES, approvalId = '', by = '' }) {
  const now = Date.now();
  return {
    id: newId(),
    question,
    options,
    deadline: new Date(now + Math.max(1, Number(minutes) || DEFAULT_MINUTES) * 60000).toISOString(),
    status: 'open',
    approvalId: approvalId || null,
    createdBy: by || null,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    delivery: { mode: 'pending', messageId: null, error: null },
    answer: null,
    reminderAt: null,
  };
}

async function create(input = {}, options = {}) {
  const question = String(input.question || '').trim();
  const list = (Array.isArray(input.options) ? input.options : []).map((value) => String(value).trim()).filter(Boolean);
  if (!question) return { ok: false, code: 'question-required', error: 'question is required' };
  if (list.length < MIN_OPTIONS) return { ok: false, code: 'too-few-options', error: `need ${MIN_OPTIONS}-${MAX_OPTIONS} options` };
  if (list.length > MAX_OPTIONS) return { ok: false, code: 'too-many-options', error: `need ${MIN_OPTIONS}-${MAX_OPTIONS} options` };
  const approvalId = String(input.approvalId || '').trim();
  if (approvalId && !approvals.get(approvalId)) {
    return { ok: false, code: 'unknown-approval', error: `unknown approval: ${approvalId}` };
  }

  const state = load();
  // 去重：同一 approvalId + 同一问题 + 同选项，且仍 open，直接返回已有 id
  if (approvalId) {
    const existing = Object.values(state.items).find((item) => item.approvalId === approvalId
      && item.question === question && JSON.stringify(item.options) === JSON.stringify(list)
      && derivedStatus(item) === 'open');
    if (existing) return { ok: true, existing: true, id: existing.id, item: existing, delivery: existing.delivery };
  }

  const item = buildItem({ ...input, question, options: list, approvalId, by: options.by });
  const send = options.send || defaultSend;
  let delivery = { mode: 'pending', messageId: null, error: null };
  try {
    const result = await send(cardText(item.id, item));
    delivery = result?.messageId
      ? { mode: process.env.DSH_TEAM_OPS_DRY_RUN === '1' ? 'dry-run' : 'qq', messageId: result.messageId, error: null }
      : { mode: 'pending', messageId: null, error: String(result?.error || 'send failed') };
  } catch (error) {
    delivery = { mode: 'pending', messageId: null, error: String(error?.message || error) };
  }
  item.delivery = delivery;
  state.items[item.id] = item;
  save(state);
  return { ok: true, id: item.id, item, delivery, card: cardText(item.id, item) };
}

function get(id) {
  return load().items[String(id || '')] || null;
}

function list(filter = {}) {
  const now = Date.now();
  const items = Object.values(load().items).map((item) => ({ ...item, effectiveStatus: derivedStatus(item, now), remaining: remainingLabel(item, now) }));
  if (filter.status) return items.filter((item) => item.effectiveStatus === filter.status);
  return items.sort((a, b) => String(a.deadline).localeCompare(String(b.deadline)));
}

function counts(now = Date.now()) {
  const out = { total: 0, open: 0, answered: 0, closed: 0, expired: 0 };
  for (const item of Object.values(load().items)) {
    out.total += 1;
    out[derivedStatus(item, now)] = (out[derivedStatus(item, now)] || 0) + 1;
  }
  return out;
}

function writeBack(item, action, by) {
  if (!item.approvalId || !action) return null;
  try {
    if (action === 'approved') return approvals.approve(item.approvalId, { by, questionId: item.id });
    if (action === 'rejected') return approvals.reject(item.approvalId, { by, questionId: item.id });
    if (action === 'withdrawn') return approvals.withdraw(item.approvalId, { by, questionId: item.id });
    return { ok: false, error: `unknown approval action: ${action}` };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

function answer(id, option, meta = {}) {
  const state = load();
  const item = state.items[String(id || '')];
  if (!item) return { ok: false, code: 'unknown-question', error: `unknown question: ${id}` };
  const now = Date.now();
  if (derivedStatus(item, now) === 'expired') {
    if (item.status === 'open') { item.status = 'expired'; item.updatedAt = new Date(now).toISOString(); save(state); }
    return { ok: false, code: 'expired', error: 'question expired', item };
  }
  if (item.status === 'closed') return { ok: false, code: 'closed', error: 'question closed', item };

  const raw = String(option ?? '').trim();
  const index = Number(raw) >= 1 && Number(raw) <= item.options.length
    ? Number(raw)
    : item.options.findIndex((opt) => opt === raw) + 1;
  if (!index) return { ok: false, code: 'bad-option', error: `unknown option: ${raw}`, options: item.options };

  if (item.status === 'answered') {
    if (item.answer && item.answer.option === index) return { ok: true, already: true, id: item.id, item };
    return { ok: false, code: 'already-answered', error: 'already answered with another option', item };
  }

  if (item.approvalId) {
    const current = approvals.get(item.approvalId);
    if (!current) return { ok: false, code: 'unknown-approval', error: `unknown approval: ${item.approvalId}`, item };
    const effective = current.effectiveStatus || 'pending';
    if (effective === 'expired') {
      return { ok: false, code: 'approval-expired', error: 'approval expired; answer not recorded', item };
    }
    if (effective !== 'pending') {
      return { ok: false, code: `approval-${effective}`, error: `approval is ${effective}; answer not recorded`, item };
    }
  }

  const approvalAction = item.approvalId
    ? (index === 1 ? 'approved' : index === item.options.length ? 'rejected' : null)
    : null;
  const written = writeBack(item, approvalAction, meta.by);
  if (approvalAction && (!written || written.ok === false)) {
    return { ok: false, code: 'approval-write-failed', error: written?.error || 'approval write failed; answer not recorded', item };
  }
  item.status = 'answered';
  item.answer = { option: index, optionText: item.options[index - 1], by: meta.by || null, at: new Date(now).toISOString(), approvalAction };
  item.updatedAt = new Date(now).toISOString();
  save(state);
  return { ok: true, id: item.id, item, approvalAction };
}

function close(id, meta = {}) {
  const state = load();
  const item = state.items[String(id || '')];
  if (!item) return { ok: false, code: 'unknown-question', error: `unknown question: ${id}` };
  if (item.status === 'closed') return { ok: true, already: true, item };
  if (item.status !== 'open') return { ok: false, code: 'not-open', error: `question is ${item.status}`, item };
  item.status = 'closed';
  item.closedBy = meta.by || null;
  item.closedAt = new Date().toISOString();
  item.updatedAt = item.closedAt;
  save(state);
  writeBack(item, 'withdrawn', meta.by);
  return { ok: true, id: item.id, item };
}

/**
 * 超时提醒：把到期的 open 问询标为 expired，并返回「首次提醒」列表。
 * 同一问询只提醒一次（reminderAt 已存在则跳过）。
 */
function remindDue(now = Date.now()) {
  const state = load();
  const due = [];
  for (const item of Object.values(state.items)) {
    if (item.status !== 'open') continue;
    if (Date.parse(item.deadline) > now) continue;
    item.status = 'expired';
    item.updatedAt = new Date(now).toISOString();
    if (!item.reminderAt) {
      item.reminderAt = new Date(now).toISOString();
      due.push({ id: item.id, question: item.question, deadline: item.deadline });
    }
  }
  save(state);
  return due;
}

function formatTable(items) {
  if (!items.length) return '待答：无';
  const header = '待答（id | 摘要 | 剩余 | 状态）';
  const lines = items.map((item) => `${item.id} | ${String(item.question).slice(0, 24)} | ${remainingLabel(item)} | ${derivedStatus(item)}`);
  return [header, ...lines].join('\n');
}

module.exports = {
  statePath,
  create,
  get,
  list,
  counts,
  answer,
  close,
  remindDue,
  formatTable,
  derivedStatus,
  MIN_OPTIONS,
  MAX_OPTIONS,
  DEFAULT_MINUTES,
};
