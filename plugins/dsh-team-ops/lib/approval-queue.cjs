#!/usr/bin/env node
'use strict';

/**
 * dsh-team-ops / A1 审批队列 schema v2（运行态，自包含）。
 *
 * 运行态固定：docs/tmp/team-ops-approval-queue.json（gitignore，不入 git）。
 * 旧审批单：docs/tmp/team-ops-approvals.json 只做一次性迁移（仅 pending），
 * 迁移前备份到 docs/tmp/tools/，旧文件由本模块视为只读（从不写）。
 *
 * 原子写：同目录 tmp 文件 + rename；跨进程锁：<queue>.lock（O_EXCL，30s 视为陈旧）。
 * 不访问网络；不依赖仓库其他脚本。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const QUEUE_VERSION = 2;
const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 3_000;
const OPTION_MIN = 2;
const OPTION_MAX = 4;
const ACTIVE_TTL_MS = 10 * 60 * 1000;
const ANSWER_REUSE_MS = 24 * 60 * 60 * 1000;
const STATUSES = ['pending', 'active', 'deferred', 'approved', 'rejected', 'expired', 'withdrawn'];

function queuePath() {
  const fromEnv = process.env.DSH_TEAM_OPS_QUEUE;
  return fromEnv && fromEnv.trim() ? fromEnv : path.join(ROOT, 'docs', 'tmp', 'team-ops-approval-queue.json');
}

function legacyPath() {
  const fromEnv = process.env.DSH_TEAM_OPS_APPROVALS;
  return fromEnv && fromEnv.trim() ? fromEnv : path.join(ROOT, 'docs', 'tmp', 'team-ops-approvals.json');
}

function backupDir() {
  const fromEnv = process.env.DSH_TEAM_OPS_QUEUE_BACKUP;
  return fromEnv && fromEnv.trim() ? fromEnv : path.join(ROOT, 'docs', 'tmp', 'tools');
}

function emptyQueue() {
  return { version: QUEUE_VERSION, updatedAt: null, items: [] };
}

function hashQuestion(question, options) {
  const material = `${String(question || '').trim()}\n${(options || []).map((o) => `- ${o}`).join('\n')}`;
  return crypto.createHash('sha256').update(material, 'utf8').digest('hex');
}

function normalizeItem(input) {
  const item = input && typeof input === 'object' ? input : {};
  const question = String(item.question || '').trim().slice(0, 500);
  const options = (Array.isArray(item.options) ? item.options : []).map((o) => String(o).trim()).filter(Boolean).slice(0, OPTION_MAX);
  if (!question) throw new Error('question is required');
  if (options.length < OPTION_MIN) throw new Error(`options must be ${OPTION_MIN}-${OPTION_MAX}`);
  const now = new Date().toISOString();
  return {
    id: String(item.id || `q-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`),
    batchKey: String(item.batchKey || 'default').slice(0, 120),
    batchId: item.batchId ? String(item.batchId).slice(0, 120) : null,
    createdAt: item.createdAt || now,
    priority: ['low', 'normal', 'high'].includes(item.priority) ? item.priority : 'normal',
    question,
    options,
    status: STATUSES.includes(item.status) ? item.status : 'pending',
    answer: item.answer || null,
    resolvedAt: item.resolvedAt || null,
    hash: item.hash || hashQuestion(question, options),
    approvalRef: item.approvalRef ? String(item.approvalRef).slice(0, 120) : null,
    pushedAt: item.pushedAt || null,
    deferredUntil: item.deferredUntil || null,
    batchSeq: Number.isFinite(Number(item.batchSeq)) ? Number(item.batchSeq) : null,
    messageId: item.messageId ? String(item.messageId).slice(0, 200) : null,
    deliveryAt: item.deliveryAt || null,
    deliveredAt: item.deliveredAt || null,
    resendCount: Number.isFinite(Number(item.resendCount)) ? Number(item.resendCount) : 0,
    questionHash: item.questionHash || hashNormalized(question),
  };
}

function normQuestion(question) {
  return String(question || '').trim().replace(/\s+/g, ' ');
}

function hashNormalized(question) {
  return crypto.createHash('sha256').update(normQuestion(question), 'utf8').digest('hex');
}

function normalizePriority(priority) {
  if (priority === 1 || priority === '1' || priority === 'high') return 'high';
  if (priority === 3 || priority === '3' || priority === 'low') return 'low';
  return 'normal';
}

function countsOf(queue) {
  const out = { total: 0, pending: 0, active: 0, deferred: 0, approved: 0, rejected: 0, expired: 0, withdrawn: 0 };
  for (const item of queue.items) {
    out.total += 1;
    if (out[item.status] !== undefined) out[item.status] += 1;
  }
  return out;
}

/** 只入队、不推送。同 batchKey + sha256(question) 去重。 */
function enqueue(input = {}) {
  const question = String(input.question || '').trim();
  if (!question) throw new Error('question is required');
  const options = (Array.isArray(input.options) ? input.options : []).map((option) => String(option).trim()).filter(Boolean);
  const batchKey = String(input.batchKey || 'default').slice(0, 120);
  const priority = normalizePriority(input.priority);
  return withLock(() => {
    const queue = loadQueue();
    const questionHash = hashNormalized(question);
    for (const item of queue.items) {
      if (item.batchKey !== batchKey || item.questionHash !== questionHash) continue;
      if (['pending', 'active', 'deferred'].includes(item.status)) {
        return { ok: true, deduped: true, reason: 'in-queue', id: item.id, status: item.status, total: queue.items.length };
      }
      const resolvedAt = item.resolvedAt ? Date.parse(item.resolvedAt) : 0;
      if (['approved', 'rejected', 'withdrawn'].includes(item.status) && Date.now() - resolvedAt < ANSWER_REUSE_MS) {
        return { ok: true, deduped: true, reason: 'answered-24h', id: item.id, status: item.status, answer: item.answer, total: queue.items.length };
      }
    }
    const item = normalizeItem({
      question,
      options: options.length >= OPTION_MIN ? options : ['同意', '驳回'],
      batchKey,
      priority,
      approvalRef: input.approvalRef ? String(input.approvalRef) : null,
    });
    queue.items.push(item);
    saveQueue(queue);
    return { ok: true, deduped: false, item, total: queue.items.length };
  });
}

function buildBatchLines(queue, batchItems, batchId) {
  const pending = queue.items.filter((item) => item.status === 'pending').length;
  const lines = [`批 ${batchId}｜总数 ${queue.items.length}｜本批 ${batchItems.length} 项｜其余 ${pending} 项待批`];
  batchItems.forEach((item, index) => {
    const abc = item.options.map((option, i) => `${'ABCD'[i]} ${option}`).join('｜');
    lines.push(`${index + 1}. ${item.id}｜${item.question}｜${abc}`);
  });
  lines.push(`回复示例：/答 ${batchItems[0]?.id || ''} A`);
  return lines.join('\n');
}

/**
 * 形成下一批：最多 3 项、createdAt 升序、high 优先最多 1 项插最前。
 * 有未超 10 分钟的 active 批时返回 waiting；超时未答项转 deferred 后才继续。
 */
function flush(input = {}) {
  const maxPerBatch = Math.min(3, Math.max(1, Number(input.maxPerBatch) || 3));
  const nowMs = input.now ? Date.parse(input.now) : Date.now();
  const nowIso = new Date(nowMs).toISOString();
  return withLock(() => {
    const queue = loadQueue();
    const active = queue.items.filter((item) => item.status === 'active');
    if (active.length) {
      const oldest = active.reduce((a, b) => (Date.parse(a.pushedAt || 0) <= Date.parse(b.pushedAt || 0) ? a : b));
      const anyPushed = active.some((item) => item.pushedAt);
      if (!anyPushed) {
        const batchId = oldest.batchId || null;
        if (active.some((item) => item.messageId)) {
          return { ok: true, waiting: true, reason: 'active-batch-delivered', batchId, total: queue.items.length, counts: countsOf(queue) };
        }
        const alreadyResent = active.some((item) => (Number(item.resendCount) || 0) > 0);
        if (alreadyResent) {
          return { ok: true, waiting: true, reason: 'active-batch-resent', batchId, total: queue.items.length, counts: countsOf(queue) };
        }
        const batchItems = active
          .slice()
          .sort((a, b) => (Number(a.batchSeq) || 0) - (Number(b.batchSeq) || 0));
        for (const item of batchItems) {
          item.pushedAt = nowIso;
          item.deliveryAt = nowIso;
          item.resendCount = (Number(item.resendCount) || 0) + 1;
        }
        const lines = buildBatchLines(queue, batchItems, batchId);
        saveQueue(queue);
        return {
          ok: true,
          pushed: true,
          resent: true,
          resend: true,
          batchId,
          messageId: batchItems[0]?.messageId || null,
          items: batchItems.map((item) => ({ id: item.id, question: item.question, options: item.options, priority: item.priority })),
          text: lines,
          total: queue.items.length,
          pending: queue.items.filter((item) => item.status === 'pending').length,
          counts: countsOf(queue),
        };
      }
      const age = nowMs - Date.parse(oldest.pushedAt || 0);
      if (age < ACTIVE_TTL_MS) {
        return { ok: true, waiting: true, reason: 'active-batch', batchId: oldest.batchId || null, remainingMs: ACTIVE_TTL_MS - age, total: queue.items.length, counts: countsOf(queue) };
      }
      for (const item of active) {
        item.status = 'deferred';
        item.deferredUntil = new Date(nowMs + 24 * 60 * 60 * 1000).toISOString();
      }
    }
    const candidates = queue.items
      .filter((item) => {
        if (item.pushedAt) return false;
        if (item.status === 'pending') return true;
        return item.status === 'deferred' && (!item.deferredUntil || Date.parse(item.deferredUntil) <= nowMs);
      })
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    if (!candidates.length) {
      saveQueue(queue);
      return { ok: true, pushed: false, reason: 'empty', total: queue.items.length, counts: countsOf(queue) };
    }
    const highIndex = candidates.findIndex((item) => item.priority === 'high' || item.priority === 1);
    const ordered = [];
    if (highIndex >= 0) ordered.push(candidates[highIndex]);
    for (const item of candidates) {
      if (ordered.length >= maxPerBatch) break;
      if (!ordered.includes(item)) ordered.push(item);
    }
    const batchId = `b-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`;
    ordered.forEach((item, index) => {
      item.status = 'active';
      item.pushedAt = nowIso;
      item.deliveryAt = nowIso;
      item.batchId = batchId;
      item.batchSeq = index + 1;
    });
    const pending = queue.items.filter((item) => item.status === 'pending').length;
    const lines = [`批 ${batchId}｜总数 ${queue.items.length}｜本批 ${ordered.length} 项｜其余 ${pending} 项待批`];
    ordered.forEach((item, index) => {
      const abc = item.options.map((option, i) => `${'ABCD'[i]} ${option}`).join('｜');
      lines.push(`${index + 1}. ${item.id}｜${item.question}｜${abc}`);
    });
    lines.push(`回复示例：/答 ${ordered[0].id} A`);
    saveQueue(queue);
    return {
      ok: true,
      pushed: true,
      batchId,
      messageId: null,
      deliveryAt: nowIso,
      items: ordered.map((item) => ({ id: item.id, question: item.question, options: item.options, priority: item.priority })),
      text: lines.join('\n'),
      total: queue.items.length,
      pending,
      counts: countsOf(queue),
    };
  });
}

function loadQueue(file = queuePath()) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const items = Array.isArray(data?.items) ? data.items : [];
    return {
      version: QUEUE_VERSION,
      updatedAt: data?.updatedAt || null,
      items: items.filter((item) => item && item.id),
      migratedAt: data?.migratedAt || null,
    };
  } catch {
    return emptyQueue();
  }
}

function atomicWriteJson(file, value) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  try {
    const text = JSON.stringify(value, null, 2) + '\n';
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw error;
  }
}

function sleep(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) { /* spin: 队列写很小，避免 async */ }
}

function withLock(fn, file = queuePath()) {
  const lock = `${file}.lock`;
  const started = Date.now();
  let fd = null;
  for (;;) {
    try {
      fs.mkdirSync(path.dirname(lock), { recursive: true });
      fd = fs.openSync(lock, 'wx');
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      break;
    } catch (error) {
      if (error && error.code !== 'EEXIST') throw error;
      try {
        const info = fs.statSync(lock);
        if (Date.now() - info.mtimeMs > LOCK_STALE_MS) { fs.unlinkSync(lock); continue; }
      } catch { /* 锁刚被释放 */ }
      if (Date.now() - started > LOCK_TIMEOUT_MS) throw new Error(`queue lock busy: ${lock}`);
      sleep(25);
    }
  }
  try {
    return fn();
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
    try { fs.unlinkSync(lock); } catch { /* ignore */ }
  }
}

function saveQueue(queue, file = queuePath()) {
  const payload = {
    version: QUEUE_VERSION,
    updatedAt: new Date().toISOString(),
    migratedAt: queue.migratedAt || null,
    items: queue.items.map((item) => normalizeItem(item)),
  };
  atomicWriteJson(file, payload);
  return payload;
}

function list(filter = {}, file = queuePath()) {
  const queue = loadQueue(file);
  return queue.items.filter((item) => (filter.status ? item.status === filter.status : true));
}

function counts(file = queuePath()) {
  return countsOf(loadQueue(file));
}

function backupLegacy(legacy, stamp) {
  const dir = backupDir();
  fs.mkdirSync(dir, { recursive: true });
  let target = path.join(dir, `team-ops-approvals-backup-${stamp}.json`);
  for (let i = 2; fs.existsSync(target); i += 1) {
    target = path.join(dir, `team-ops-approvals-backup-${stamp}-${i}.json`);
  }
  fs.copyFileSync(legacy, target);
  return target;
}

function legacyItemToQueue(item) {
  const question = String(item.summary || item.question || '').trim();
  if (!question) return null;
  return normalizeItem({
    id: String(item.id),
    batchKey: 'legacy-migration',
    createdAt: item.createdAt || new Date().toISOString(),
    priority: 'normal',
    question,
    options: ['同意', '驳回'],
    status: 'pending',
    approvalRef: String(item.id),
    answer: null,
    resolvedAt: null,
  });
}

/**
 * 一次性迁移：仅 pending -> pending；approved/rejected/withdrawn/expired 不迁移。
 * 幂等：队列里已有同 id 的项跳过；重复调用 migrated=0。
 * 旧文件只读：先备份，绝不写回。
 */
function migrateLegacy(options = {}) {
  const legacy = options.legacy || legacyPath();
  const file = options.queue || queuePath();
  if (!fs.existsSync(legacy)) {
    return { ok: true, migrated: 0, total: 0, reason: 'no-legacy', legacy, queue: file };
  }
  return withLock(() => {
    const queue = loadQueue(file);
    let legacyData;
    try {
      legacyData = JSON.parse(fs.readFileSync(legacy, 'utf8'));
    } catch (error) {
      return { ok: false, migrated: 0, total: queue.items.length, error: `legacy unreadable: ${error.message}`, legacy, queue: file };
    }
    const legacyItems = legacyData && typeof legacyData.items === 'object' && legacyData.items
      ? Object.values(legacyData.items)
      : [];
    const pending = legacyItems.filter((item) => item && item.status === 'pending');
    const known = new Set(queue.items.map((item) => item.id));
    const added = [];
    for (const item of pending) {
      if (!item.id || known.has(String(item.id))) continue;
      const mapped = legacyItemToQueue(item);
      if (!mapped) continue;
      added.push(mapped);
      known.add(mapped.id);
    }
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');
    let backup = null;
    if (added.length) backup = backupLegacy(legacy, stamp);
    queue.items.push(...added);
    if (added.length) queue.migratedAt = new Date().toISOString();
    saveQueue(queue, file);
    return {
      ok: true,
      migrated: added.length,
      total: queue.items.length,
      pendingInLegacy: pending.length,
      backup,
      legacy,
      queue: file,
    };
  }, file);
}

const ANSWER_TOKEN_RE = /^(\d{1,2})-?(?:([A-Da-d])|(延后)(?::(\d{1,2}:\d{2}))?)$/;

function parseAnswerText(text) {
  const tokens = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return { ok: false, code: 'empty', message: '用法：/答 1A 2B 3-延后（数字=本批序号，字母=选项）' };
  const entries = [];
  const seen = new Set();
  for (const token of tokens) {
    const match = token.match(ANSWER_TOKEN_RE);
    if (!match) {
      return { ok: false, code: 'bad-token', token, message: `无法解析「${token}」；格式：1A / 2B / 3-延后[:14:30]` };
    }
    const index = Number(match[1]);
    if (!Number.isInteger(index) || index < 1) {
      return { ok: false, code: 'bad-index', token, message: `序号无效「${token}」` };
    }
    if (seen.has(index)) {
      return { ok: false, code: 'duplicate-index', token, message: `同一项重复回复：${index}` };
    }
    seen.add(index);
    entries.push({
      index,
      choice: match[2] ? match[2].toUpperCase() : 'defer',
      deferAt: match[4] || null,
      token,
    });
  }
  return { ok: true, entries };
}

function computeDeferredUntil(spec, nowMs) {
  if (!spec) return new Date(nowMs).toISOString();
  const match = String(spec).match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const date = new Date(nowMs);
  date.setHours(Number(match[1]), Number(match[2]), 0, 0);
  if (date.getTime() <= nowMs) date.setDate(date.getDate() + 1);
  return date.toISOString();
}

function batchItemsOf(queue, batchId) {
  return queue.items
    .filter((item) => item.batchId === batchId)
    .sort((a, b) => (Number(a.batchSeq) || 0) - (Number(b.batchSeq) || 0) || String(a.createdAt).localeCompare(String(b.createdAt)));
}

/**
 * 应用一次批量回复（事务）：全部合法才落盘。
 * 只能回答当前 activeBatch；过期批返回 expired；同项同选项重复返回 already:true。
 */
function answerBatch(input = {}) {
  const parsed = parseAnswerText(input.text);
  if (!parsed.ok) return parsed;
  const nowMs = input.now ? Date.parse(input.now) : Date.now();
  const nowIso = new Date(nowMs).toISOString();
  return withLock(() => {
    const queue = loadQueue();
    const active = queue.items.filter((item) => item.status === 'active');
    let batchId = input.batchId ? String(input.batchId) : (active[0]?.batchId || null);
    if (!batchId) {
      const batches = queue.items.filter((item) => item.batchId);
      batches.sort((a, b) => String(b.pushedAt || '').localeCompare(String(a.pushedAt || '')));
      batchId = batches[0]?.batchId || null;
    }
    if (!batchId) return { ok: false, code: 'no-batch', message: '当前没有可回答的批（先 flush）' };
    const items = batchItemsOf(queue, batchId);
    if (!items.length) return { ok: false, code: 'unknown-batch', batchId, message: `未知批次 ${batchId}` };

    const activeItems = items.filter((item) => item.status === 'active');
    if (activeItems.length) {
      const pushedAt = Math.max(...activeItems.map((item) => Date.parse(item.pushedAt || 0)));
      if (nowMs - pushedAt > ACTIVE_TTL_MS) {
        for (const item of activeItems) {
          item.status = 'expired';
          item.resolvedAt = nowIso;
        }
        saveQueue(queue);
        return { ok: false, code: 'expired', batchId, message: `批次 ${batchId} 已超 10 分钟，已标记 expired，请 flush 下一批` };
      }
    }

    const plan = [];
    let alreadyCount = 0;
    for (const entry of parsed.entries) {
      if (entry.index > items.length) {
        return { ok: false, code: 'out-of-range', batchId, message: `本批只有 ${items.length} 项，收到「${entry.token}」` };
      }
      const item = items[entry.index - 1];
      if (entry.choice !== 'defer') {
        const optionIndex = entry.choice.charCodeAt(0) - 65;
        if (optionIndex >= item.options.length) {
          return { ok: false, code: 'unknown-option', batchId, message: `「${entry.token}」超出选项范围（本项只有 ${item.options.length} 个）` };
        }
      }
      if (item.status !== 'active') {
        if (item.answer && item.answer.choice === entry.choice) { alreadyCount += 1; continue; }
        if (item.status === 'expired') return { ok: false, code: 'expired', batchId, message: `第 ${entry.index} 项所在批次已过期` };
        return { ok: false, code: 'already-answered', batchId, message: `第 ${entry.index} 项已经答过（${item.answer?.optionText || item.status}），不能用「${entry.token}」改答案` };
      }
      plan.push({ entry, item });
    }

    if (!plan.length) {
      return { ok: true, already: true, answered: 0, deferred: 0, batchId, cleared: queue.items.every((item) => item.status !== 'active') };
    }

    let answered = 0;
    let deferred = 0;
    for (const { entry, item } of plan) {
      if (entry.choice === 'defer') {
        const deferredUntil = entry.deferAt ? computeDeferredUntil(entry.deferAt, nowMs) : null;
        if (entry.deferAt && !deferredUntil) {
          return { ok: false, code: 'bad-defer-time', batchId, message: `延后时间格式无效「${entry.token}」` };
        }
        item.status = 'deferred';
        item.deferredUntil = deferredUntil;
        item.pushedAt = null;
        item.messageId = null;
        item.deliveryAt = null;
        if (!deferredUntil) item.createdAt = nowIso;
        item.answer = { choice: 'defer', optionText: '延后', deferAt: entry.deferAt || null };
        item.resolvedAt = null;
        deferred += 1;
      } else {
        const optionIndex = entry.choice.charCodeAt(0) - 65;
        item.status = 'approved';
        item.answer = { choice: entry.choice, option: optionIndex + 1, optionText: item.options[optionIndex] };
        item.resolvedAt = nowIso;
        item.deferredUntil = null;
        answered += 1;
      }
    }
    const cleared = queue.items.every((item) => item.status !== 'active');
    saveQueue(queue);
    return { ok: true, already: false, batchId, answered, deferred, cleared, items: plan.map(({ item }) => ({ id: item.id, status: item.status })) };
  });
}

function markDelivered(input = {}) {
  const messageId = String(input.messageId || '').trim();
  if (!messageId) return { ok: false, code: 'missing-message-id', message: 'messageId is required' };
  const batchId = input.batchId ? String(input.batchId) : null;
  const itemIds = Array.isArray(input.itemIds) ? input.itemIds.map(String) : [];
  const nowIso = new Date(input.now ? Date.parse(input.now) : Date.now()).toISOString();
  return withLock(() => {
    const queue = loadQueue();
    const targets = queue.items.filter((item) => (batchId ? item.batchId === batchId : itemIds.includes(item.id)));
    if (!targets.length) return { ok: false, code: 'unknown-batch', batchId };
    if (targets.every((item) => item.messageId === messageId)) {
      return { ok: true, already: true, messageId, batchId: batchId || targets[0].batchId || null, count: targets.length };
    }
    for (const item of targets) {
      item.messageId = messageId;
      item.deliveredAt = nowIso;
      item.deliveryAt = item.deliveryAt || nowIso;
    }
    saveQueue(queue);
    return { ok: true, already: false, messageId, batchId: batchId || targets[0].batchId || null, count: targets.length, counts: countsOf(queue) };
  });
}

module.exports = {
  QUEUE_VERSION,
  ACTIVE_TTL_MS,
  queuePath,
  legacyPath,
  backupDir,
  loadQueue,
  saveQueue,
  list,
  counts,
  migrateLegacy,
  enqueue,
  flush,
  markDelivered,
  parseAnswerText,
  answerBatch,
  computeDeferredUntil,
  normalizeItem,
  normQuestion,
  hashNormalized,
  hashQuestion,
  atomicWriteJson,
  withLock,
  emptyQueue,
};
