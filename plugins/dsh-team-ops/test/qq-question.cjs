#!/usr/bin/env node
'use strict';

/**
 * C06 测试：提问卡 / 回答 / 待答 / 超时 / Lead 门 / 幂等。
 * 不联网：DSH_TEAM_OPS_DRY_RUN=1，发送返回 dry-<sha1>。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'team-ops-q-'));
process.env.DSH_TEAM_OPS_DRY_RUN = '1';
process.env.DSH_TEAM_OPS_LEAD_SESSION = 'lead-session';
process.env.DSH_TEAM_OPS_QUESTIONS = path.join(tmp, 'questions.json');
process.env.DSH_TEAM_OPS_APPROVALS = path.join(tmp, 'approvals.json');
process.env.DSH_TEAM_OPS_APPROVAL_AUDIT = path.join(tmp, 'audit.jsonl');

const questions = require('../lib/questions.cjs');
const approvals = require('../lib/approvals.cjs');
const commands = require('../lib/commands.cjs');

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail });
}
function item(id) { return questions.get(id); }
function approval(id) { return approvals.get(id); }

async function main() {
  const approval1 = approvals.create({ summary: 'C06 是否合并', source: 'test' });
  const approval2 = approvals.create({ summary: 'C06 撤回测试', source: 'test' });
  const approval3 = approvals.create({ summary: 'C06 驳回测试', source: 'test' });

  // 1) 提问：pending id + dry-run 回执
  const asked = await commands.handleCommand('/提问 是否现在合并 | 批准 | 驳回 --approval ' + approval1.id + ' --分钟 30', { sessionId: 'lead-session' });
  check('ask-created', asked.ok && /^q-[0-9a-f]{6}$/.test(asked.id || '') && asked.delivery?.messageId, asked.reply);
  const q1 = asked.id;
  check('ask-dry-run-delivery', item(q1)?.delivery?.mode === 'dry-run' && Boolean(item(q1)?.delivery?.messageId), item(q1)?.delivery);

  // 2) 非 Lead / 无会话
  const denied1 = await commands.handleCommand('/提问 是否合并 | 批准 | 驳回', { sessionId: 'hub-session' });
  check('ask-non-lead-403', denied1.status === 403 && denied1.ok === false, denied1.reason);
  const denied2 = await commands.handleCommand('/提问 是否合并 | 批准 | 驳回');
  check('ask-no-session-403', denied2.status === 403, denied2.reason);

  // 3) 参数校验
  const few = await commands.handleCommand('/提问 只有一项 | 批准', { sessionId: 'lead-session' });
  check('ask-too-few-options', few.ok === false && few.code === 'too-few-options', few.code);
  const badApproval = await commands.handleCommand('/提问 未知审批 | A | B --approval apv-nope', { sessionId: 'lead-session' });
  check('ask-unknown-approval', badApproval.ok === false && badApproval.code === 'unknown-approval', badApproval.code);
  const tooMany = await commands.handleCommand('/提问 太多项 | A | B | C | D | E', { sessionId: 'lead-session' });
  check('ask-too-many-options', tooMany.ok === false && tooMany.code === 'too-many-options', tooMany.code);

  // 4) 去重
  const again = await commands.handleCommand('/提问 是否现在合并 | 批准 | 驳回 --approval ' + approval1.id + ' --分钟 30', { sessionId: 'lead-session' });
  check('ask-dedupe', again.ok && again.existing === true && again.id === q1, again.reply.slice(0, 40));

  // 5) 待答表
  const waiting = await commands.handleCommand('/待答', {});
  check('waiting-table', waiting.reply.includes(q1) && waiting.reply.includes('open'), waiting.reply.slice(0, 80));

  // 6) 回答（仅 Lead）-> 写回 approved
  const answered = await commands.handleCommand(`/回答 ${q1} 1`, { sessionId: 'lead-session' });
  check('answer-approved', answered.ok && approval(approval1.id)?.effectiveStatus === 'approved' && item(q1)?.status === 'answered', answered.reply);
  const answeredByText = await commands.handleCommand(`/回答 ${q1} 批准`, { sessionId: 'lead-session' });
  check('answer-idempotent', answeredByText.ok && answeredByText.already === true, answeredByText.reply);
  const conflict = await commands.handleCommand(`/回答 ${q1} 2`, { sessionId: 'lead-session' });
  check('answer-conflict', conflict.ok === false && conflict.code === 'already-answered', conflict.code);

  // 6b) F1：非 Lead 回答 403，且问题状态不变
  const q1b = await questions.create({ question: 'F1 回答门', options: ['A', 'B'] });
  const answerDenied = await commands.handleCommand(`/回答 ${q1b.id} 1`, { sessionId: 'hub-session' });
  check('answer-non-lead-403', answerDenied.status === 403 && item(q1b.id)?.status === 'open', answerDenied.reason);

  // 7) 超时 -> expired + 只提醒一次
  const q2 = await questions.create({ question: '超时测试', options: ['A', 'B'], minutes: 30 });
  const stateFile = process.env.DSH_TEAM_OPS_QUESTIONS;
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  state.items[q2.id].deadline = '2000-01-01T00:00:00.000Z';
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  const due1 = questions.remindDue();
  const due2 = questions.remindDue();
  check('timeout-expired', due1.length === 1 && due1[0].id === q2.id && item(q2.id).status === 'expired', { due: due1.length });
  check('timeout-reminder-idempotent', due2.length === 0, { due: due2.length });
  const answerExpired = await commands.handleCommand(`/回答 ${q2.id} 1`, { sessionId: 'lead-session' });
  check('answer-expired', answerExpired.ok === false && answerExpired.code === 'expired', answerExpired.code);
  const waitingExpired = await commands.handleCommand('/待答', {});
  check('waiting-shows-expired', waitingExpired.reply.includes(q2.id) && waitingExpired.reply.includes('expired'), waitingExpired.reply.slice(0, 120));

  // 8) 关闭（仅 Lead），并写回 withdrawn
  const q3 = await questions.create({ question: '撤回测试', options: ['A', 'B'], approvalId: approval2.id });
  const closeDenied = await commands.handleCommand(`/关闭 ${q3.id}`, { sessionId: 'hub-session' });
  check('close-non-lead-403', closeDenied.status === 403, closeDenied.reason);
  const closed = await commands.handleCommand(`/关闭 ${q3.id}`, { sessionId: 'lead-session' });
  check('close-lead', closed.ok && item(q3.id)?.status === 'closed' && approval(approval2.id)?.effectiveStatus === 'withdrawn', closed.reply);
  const closedAgain = await commands.handleCommand(`/关闭 ${q3.id}`, { sessionId: 'lead-session' });
  check('close-idempotent', closedAgain.ok && closedAgain.already === true, closedAgain.reply);

  // 9) 最后一项选项写回 rejected
  const q4 = await questions.create({ question: '驳回测试', options: ['A', 'B', 'C'], approvalId: approval3.id });
  const rejected = await commands.handleCommand(`/回答 ${q4.id} 3`, { sessionId: 'lead-session' });
  check('answer-rejected', rejected.ok && approval(approval3.id)?.effectiveStatus === 'rejected', rejected.reply);

  // 9b) F2：审批已过期 -> 拒绝回答，approval 与问题都不变
  const approval4 = approvals.create({ summary: 'F2 过期审批', source: 'test', ttlMs: 60000 });
  const approvalFile = process.env.DSH_TEAM_OPS_APPROVALS;
  const approvalState = JSON.parse(fs.readFileSync(approvalFile, 'utf8'));
  approvalState.items[approval4.id].expiresAt = '2000-01-01T00:00:00.000Z';
  fs.writeFileSync(approvalFile, JSON.stringify(approvalState, null, 2));
  const q5 = await questions.create({ question: 'F2 过期回答', options: ['A', 'B'], approvalId: approval4.id });
  const expiredApprovalAnswer = await commands.handleCommand(`/回答 ${q5.id} 1`, { sessionId: 'lead-session' });
  check('answer-approval-expired', expiredApprovalAnswer.code === 'approval-expired'
    && item(q5.id)?.status === 'open'
    && approval(approval4.id)?.effectiveStatus === 'expired', expiredApprovalAnswer.code);

  // 10) 计数与状态文件
  const counts = questions.counts();
  check('counts', counts.total === 6 && counts.answered === 2 && counts.closed === 1 && counts.expired === 1, counts);
  check('state-file', fs.existsSync(stateFile), stateFile);

  const failed = checks.filter((c) => !c.ok);
  console.log(JSON.stringify({ ok: failed.length === 0, checks: checks.length, failed: failed.map((c) => c.name), detail: checks }, null, 2));
  if (failed.length) {
    for (const c of failed) console.error('FAIL', c.name, JSON.stringify(c.detail).slice(0, 300));
    process.exit(1);
  }
}

main().then(() => { fs.rmSync(tmp, { recursive: true, force: true }); }).catch((error) => { console.error(error); process.exit(1); });
