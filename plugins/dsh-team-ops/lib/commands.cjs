#!/usr/bin/env node
'use strict';

/**
 * dsh-team-ops / 0.3.3 入站快捷命令（自包含）。
 *
 * 宿主事件里拿不到 QQ 原文时，由桥接（dsh-im / dsh-qqbot / 自建脚本）
 * 把文本 POST 到 /api/team-ops/command，本模块做应答：
 *   /帮助 /状态 /队列 /任务 /角色 /待批 /汇总
 *   /提问 /回答 /待答 /关闭（C06，提问/关闭仅 Lead 会话）
 * 不访问网络（提问卡的发送由 questions.cjs 负责）、不改任务板。
 */

const status = require('./status.cjs');
const roles = require('./roles.cjs');
const approvals = require('./approvals.cjs');
const report = require('./report.cjs');
const questions = require('./questions.cjs');
const leadGate = require('./lead-gate.cjs');
const approvalQueue = require('./approval-queue.cjs');

const USAGE = [
  '/状态 成员与任务总览',
  '/队列 中枢受理/排队/待汇总',
  '/任务 当前任务列表',
  '/角色 10 个成员角色清单',
  '/待批 待用户批准的工单',
  '/答 1A 2B 3-延后 回复当前批（字母=选项，延后=下一批）',
  '/汇总 5 行报告（结论/交付/证据/需审核/遗留）',
  '/提问 摘要 | 选项1 | 选项2 [| 选项3] [| 选项4] [--分钟 30] [--approval ap-xxx]',
  '/回答 <id> <选项序号或文本>',
  '/待答 待答队列（id/摘要/剩余/状态）',
  '/关闭 <id> 撤回提问（仅 Lead）',
  '/帮助 查看命令',
].join('\n');

function counts(snapshot) {
  const members = Array.isArray(snapshot?.members) ? snapshot.members : [];
  const running = members.filter((m) => ['running', 'in_progress'].includes(m?.status)).length;
  const tasks = snapshot?.tasks || {};
  const hub = snapshot?.hub || {};
  return {
    members: members.length,
    running,
    total: Number(tasks.total || 0),
    done: Number(tasks.done || 0),
    inProgress: Number(tasks.inProgress || 0),
    pending: Number(tasks.pending || 0),
    inbox: Number(hub.inbox || 0),
    queued: Number(hub.queued || 0),
    executing: Number(hub.executing || 0),
    summarizing: Number(hub.summarizing || 0),
  };
}

function recentFailureCount(limit = 8) {
  try {
    const entries = status.readDeliveries(status.LOG_PATH, 20);
    return entries.slice(-limit).filter((entry) => entry && entry.ok === false).length;
  } catch {
    return 0;
  }
}

function replyState(snapshot) {
  const c = counts(snapshot);
  return [
    `成员 ${c.members}（运行 ${c.running} / 空闲 ${Math.max(0, c.members - c.running)}）`,
    `任务 ${c.total}（完成 ${c.done} / 进行 ${c.inProgress} / 待领 ${c.pending}）`,
    `快照 ${snapshot?.generatedAt || '未知'}`,
  ].join('\n');
}

function replyQueue(snapshot) {
  const c = counts(snapshot);
  const failed = recentFailureCount();
  return [
    `中枢：受理 ${c.inbox} / 排队 ${c.queued} / 执行 ${c.executing} / 待汇总 ${c.summarizing}`,
    `最近投递失败 ${failed} 条（日志 docs/tmp/qq-delivery-log.jsonl）`,
  ].join('\n');
}

function replyRoles() {
  return roles.listRoles()
    .map((role) => `${role.id}｜${role.label}｜${role.description}`)
    .join('\n');
}

function replyTasks(snapshot) {
  const items = Array.isArray(snapshot?.tasks?.items) ? snapshot.tasks.items : [];
  if (!items.length) return '当前任务：无进行中任务（快照里没有 items）';
  const lines = items.slice(0, 8).map((task) => {
    const owner = task?.owner ? ` @${task.owner}` : '';
    return `- ${task?.id || '?'} ${task?.status || '?'}${owner} ${task?.subject || ''}`.trim();
  });
  const more = items.length > 8 ? `\n…另有 ${items.length - 8} 条` : '';
  return ['当前任务：', ...lines].join('\n') + more;
}

function replyPending(options = {}) {
  const name = '/待批';
  const gate = leadGate.isLead(options.sessionId);
  if (!gate.allowed) return gateDenied(name, gate, options.sessionId);
  const items = approvalQueue.list();
  const counts = approvalQueue.counts();
  const total = counts.total || items.length;
  const active = items
    .filter((item) => item.status === 'active')
    .sort((a, b) => (Number(a.batchSeq) || 0) - (Number(b.batchSeq) || 0));
  const batchId = active[0]?.batchId || null;
  const rest = Math.max(0, total - active.length);
  const waiting = active.length > 0;
  const remainingMs = waiting && active[0]?.pushedAt
    ? Math.max(0, approvalQueue.ACTIVE_TTL_MS - (Date.now() - new Date(active[0].pushedAt).getTime()))
    : 0;
  const lines = [];
  if (waiting) {
    const minutes = String(Math.floor(remainingMs / 60000));
    const seconds = String(Math.floor((remainingMs % 60000) / 1000)).padStart(2, '0');
    lines.push(`待批 ${String(batchId || '').slice(-8) || '当前批'}｜总数 ${total}｜本批 ${active.length} 项｜其余 ${rest} 项`);
    for (const [index, item] of active.entries()) {
      const optionText = (item.options || []).map((text, i) => `${String.fromCharCode(65 + i)} ${text}`).join('｜');
      lines.push(`${index + 1}. ${String(item.question || '').slice(0, 40)}｜${optionText}`);
    }
    lines.push(`回复：/答 1A 2B 3-延后｜剩余 ${minutes}:${seconds}`);
  } else if ((counts.pending || 0) + (counts.deferred || 0) > 0) {
    lines.push(`待批｜总数 ${total}｜当前无已推批次｜待推 ${counts.pending + counts.deferred} 项，可 flush 下一批`);
  } else {
    lines.push(`待批｜总数 ${total}｜没有待处理项`);
  }
  return {
    ok: true,
    command: name,
    total,
    batchId,
    items: active.slice(0, 3).map((item, index) => ({ index: index + 1, id: item.id, question: item.question, options: item.options || [] })),
    waiting,
    remainingMs,
    canFlush: !waiting && (counts.pending || 0) + (counts.deferred || 0) > 0,
    reply: lines.join('\n'),
  };
}

function replySummary(snapshot) {
  const c = counts(snapshot);
  let pending = 0;
  try { pending = approvals.counts().pending; } catch { pending = 0; }
  return report.formatReport({
    结论: `任务 ${c.total} 中完成 ${c.done}、进行 ${c.inProgress}、待领 ${c.pending}`,
    交付: `快照覆盖 ${c.members} 名成员；本轮完成任务 ${c.done} 项`,
    证据: `快照时间 ${snapshot?.generatedAt || '未知'}`,
    需审核: `待批审批 ${pending} 条`,
    遗留: c.inProgress || c.pending ? `进行中 ${c.inProgress} 项、待领 ${c.pending} 项` : '无',
  });
}

function replyReport(text) {
  const verdict = report.validate(text);
  if (verdict.ok) return verdict.lines.join('\n');
  return report.formatReport({
    结论: `报告不合格（${verdict.code}）`,
    交付: verdict.missing?.length ? `缺少固定段：${verdict.missing.join('、')}` : '格式或行数不符合要求',
    证据: `共 ${verdict.totalLines} 行，上限 ${verdict.limit}`,
    需审核: '修正后重发',
    遗留: '原文本未发送',
  });
}

function parseQuestionArgs(rest) {
  let text = String(rest || '');
  let minutes = questions.DEFAULT_MINUTES;
  let approvalId = '';
  const minuteMatch = text.match(/--分钟\s*(\d+)/) || text.match(/--minutes?\s*(\d+)/i);
  if (minuteMatch) { minutes = Number(minuteMatch[1]); text = text.replace(minuteMatch[0], ' '); }
  const approvalMatch = text.match(/--approval\s*([A-Za-z0-9._-]+)/i);
  if (approvalMatch) { approvalId = approvalMatch[1]; text = text.replace(approvalMatch[0], ' '); }
  const parts = text.split('|').map((part) => part.trim()).filter(Boolean);
  return { question: parts[0] || '', options: parts.slice(1), minutes, approvalId };
}

function gateDenied(name, gate, sessionId) {
  return {
    ok: false,
    status: 403,
    command: name,
    reason: gate.reason,
    error: gate.error,
    sessionTail: leadGate.tail(sessionId),
    reply: `403 ${gate.error}（仅 Lead 会话可发起/关闭提问；reason=${gate.reason}）`,
  };
}

async function replyAsk(rest, options) {
  const name = '/提问';
  const gate = leadGate.isLead(options.sessionId);
  if (!gate.allowed) return gateDenied(name, gate, options.sessionId);
  const parsed = parseQuestionArgs(rest);
  const created = await questions.create(parsed, { by: leadGate.tail(options.sessionId) });
  if (!created.ok) {
    return { ok: false, command: name, code: created.code, error: created.error, reply: `提问失败：${created.code} — ${created.error}` };
  }
  const delivery = created.delivery || {};
  const deliveryText = delivery.messageId
    ? `已送达（${delivery.mode} messageId=${delivery.messageId}）`
    : `未送达（pending${delivery.error ? `：${delivery.error}` : ''}）`;
  return {
    ok: true,
    command: name,
    id: created.id,
    existing: created.existing === true,
    delivery,
    reply: `${created.existing ? '已存在待答' : '已创建待答'} ${created.id}，${deliveryText}\n${created.card || ''}`.trim(),
  };
}

function replyAnswer(rest, options = {}) {
  const name = '/回答';
  const gate = leadGate.isLead(options.sessionId);
  if (!gate.allowed) return gateDenied(name, gate, options.sessionId);
  const match = String(rest || '').match(/^(\S+)\s+(.+)$/);
  if (!match) return { ok: false, command: '/回答', error: 'usage: /回答 <id> <选项>', reply: '用法：/回答 <id> <选项序号或文本>' };
  const result = questions.answer(match[1], match[2]);
  if (!result.ok) return { ok: false, command: '/回答', code: result.code, error: result.error, reply: `回答失败：${result.code} — ${result.error}` };
  const note = result.already ? '（重复回答，幂等）' : '';
  const approval = result.approvalAction ? `，审批已写回 ${result.approvalAction}` : '';
  return { ok: true, command: '/回答', id: result.id, approvalAction: result.approvalAction || null, already: result.already === true, reply: `已记录 ${result.id} → ${result.item.answer.optionText}${approval}${note}` };
}

function replyWaiting() {
  const due = questions.remindDue();
  const table = questions.formatTable(questions.list());
  const reminder = due.length ? `\n超时提醒：${due.map((item) => item.id).join('、')} 未在截止前回答` : '';
  return { reply: `${table}${reminder}`, reminded: due };
}

function replyClose(rest, options) {
  const name = '/关闭';
  const gate = leadGate.isLead(options.sessionId);
  if (!gate.allowed) return gateDenied(name, gate, options.sessionId);
  const id = String(rest || '').trim();
  if (!id) return { ok: false, command: name, error: 'usage: /关闭 <id>', reply: '用法：/关闭 <id>' };
  const result = questions.close(id, { by: leadGate.tail(options.sessionId) });
  if (!result.ok) return { ok: false, command: name, code: result.code, error: result.error, reply: `关闭失败：${result.code} — ${result.error}` };
  return { ok: true, command: name, id: result.id, already: result.already === true, reply: `已关闭 ${result.id}${result.already ? '（重复关闭，幂等）' : ''}` };
}

function replyBatchAnswer(rest) {
  if (!rest) return '用法：/答 1A 2B 3-延后（数字=本批序号，字母=选项；延后可写 3-延后:14:30）';
  const result = approvalQueue.answerBatch({ text: rest });
  if (!result.ok) return `回答未生效：${result.message || result.code}`;
  if (result.already) return `这批已经答过（${result.batchId}），没有新的改动`;
  const lines = [`批 ${result.batchId}：已答 ${result.answered} 项，延后 ${result.deferred} 项`];
  if (result.cleared) lines.push('当前批已清空，可 flush 下一批');
  return lines.join('\n');
}

async function handleCommand(text, options = {}) {
  const raw = String(text ?? '').replace(/^\uFEFF/, '').trim();
  const head = (raw.split(/\s+/)[0] || '').toLowerCase();
  const command = head;
  const rest = raw.slice(head.length).trim();
  const snapshotPath = options.snapshotPath || status.DEFAULT_SNAPSHOT;
  let result;
  switch (command) {
    case '/帮助':
    case '/help':
      result = { reply: USAGE };
      break;
    case '/状态':
    case '/status':
      result = { reply: replyState(status.readSnapshot(snapshotPath)) };
      break;
    case '/队列':
    case '/queue':
      result = { reply: replyQueue(status.readSnapshot(snapshotPath)) };
      break;
    case '/任务':
    case '/tasks':
      result = { reply: replyTasks(status.readSnapshot(snapshotPath)) };
      break;
    case '/角色':
    case '/roles':
      result = { reply: replyRoles() };
      break;
    case '/待批':
    case '/pending':
      result = replyPending(options);
      if (!result.ok && !result.reply) result.reply = '仅 Lead 会话可查看待批（未配置 DSH_TEAM_OPS_LEAD_SESSION 时一律拒绝）';
      break;
    case '/答':
    case '/reply':
      result = { reply: replyBatchAnswer(rest) };
      break;
    case '/汇总':
    case '/summary':
      result = { reply: rest ? replyReport(rest) : replySummary(status.readSnapshot(snapshotPath)) };
      break;
    case '/提问':
    case '/ask':
      result = await replyAsk(rest, options);
      break;
    case '/回答':
    case '/answer':
      result = replyAnswer(rest, { sessionId: options.sessionId });
      break;
    case '/待答':
    case '/waiting':
      result = replyWaiting();
      break;
    case '/关闭':
    case '/close':
      result = replyClose(rest, options);
      break;
    case '':
      result = { reply: `没有输入命令。\n${USAGE}` };
      break;
    default:
      result = { reply: `没听懂「${raw.slice(0, 24)}」，发送 /帮助 查看命令` };
  }
  return { ok: result.ok !== false, command: command || null, ...result, reply: result.reply };
}

module.exports = { handleCommand, USAGE };
