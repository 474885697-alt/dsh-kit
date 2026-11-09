#!/usr/bin/env node
/**
 * C03 审批门自测（fake ctx，不触网）。
 *
 * 覆盖：无 approvedByUser → 拒绝；假 approvalRef → 拒绝；pending → 拒绝；
 *       非 Lead approve → 403；Lead approve → 允许；撤回 → 拒绝；驳回 → 拒绝；
 *       /待批 输出 pending；审计日志含 approvalId。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'team-ops-approval-'));
Object.assign(process.env, {
  DSH_TEAM_OPS_APPROVALS: path.join(tmp, 'approvals.json'),
  DSH_TEAM_OPS_APPROVAL_AUDIT: path.join(tmp, 'approvals-audit.jsonl'),
  DSH_TEAM_OPS_LEAD_SESSION: 'lead-session',
});

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail });
}

const plugin = await import('../lib/index.js');

const events = new Map();
const routes = new Map();
const tools = new Map();
const ctx = {
  on(name, fn) {
    events.set(name, [...(events.get(name) || []), fn]);
    return () => {};
  },
  get() { return null; },
  webServer: {
    register(route) {
      const key = `${route.kind}:${route.path}`;
      routes.set(key, route);
      return () => routes.delete(key);
    },
  },
  effect(fn) {
    const dispose = fn();
    return dispose;
  },
  inject(_deps, fn) {
    fn({
      effect: ctx.effect,
      tools: {
        register(def) {
          tools.set(def.name, def);
          return () => tools.delete(def.name);
        },
      },
    });
  },
};

const origLog = console.log;
const origError = console.error;
console.log = () => {};
console.error = () => {};
plugin.apply(ctx);
console.log = origLog;
console.error = origError;

const preExecute = (events.get('tools/pre-execute') || [])[0];
check('pre-execute-registered', typeof preExecute === 'function', Boolean(preExecute));
check('team-approval-tool', tools.has('team_approval'), [...tools.keys()]);

const leadExec = { agent: { id: 'lead-agent', session: { id: 'lead-session' } } };
const hubExec = { agent: { id: 'hub-agent', session: { id: 'hub-session' } } };

async function callGate(description, sessionId = 'lead-session') {
  let nextCalled = false;
  const result = await preExecute(
    { name: 'team_task_create', arguments: { description }, agent: { session: { id: sessionId } } },
    () => { nextCalled = true; return { kind: 'allow' }; },
  );
  return { result, nextCalled };
}

const approvalTool = tools.get('team_approval');

// 1) 无 approvedByUser
const noFlag = await callGate('派给 tools：跑发布门');
check('deny-no-approved-by-user', noFlag.result?.kind === 'deny' && /missing-approved-by-user/.test(String(noFlag.result.reason)) && !noFlag.nextCalled, noFlag);

// 2) 假 approvalRef
const fakeRef = await callGate('approvedByUser: true\napprovalRef: apv-fake-9999');
check('deny-unknown-approval', fakeRef.result?.kind === 'deny' && /unknown-approval/.test(String(fakeRef.result.reason)) && !fakeRef.nextCalled, fakeRef);

// 3) request 后 pending → 拒绝
const created = JSON.parse(await approvalTool.execute({ action: 'request', summary: '用户同意做 C03 审批门', quote: '继续做 C03', source: 'lead' }, leadExec));
const apvId = created?.approval?.id;
check('create-pending', created.ok === true && created.approval.status === 'pending' && /^apv-/.test(String(apvId)), created);
const pendingDraft = `approvedByUser: true\napprovalRef: ${apvId}\n派给 tools：C03`;
const pendingGate = await callGate(pendingDraft);
check('deny-pending', pendingGate.result?.kind === 'deny' && /not-approved/.test(String(pendingGate.result.reason)), pendingGate);

// 4) 非 Lead approve → 403
const hubApprove = JSON.parse(await approvalTool.execute({ action: 'approve', id: apvId }, hubExec));
check('approve-hub-403', hubApprove.ok === false && hubApprove.status === 403, hubApprove);

// 5) Lead approve → 允许
const leadApprove = JSON.parse(await approvalTool.execute({ action: 'approve', id: apvId }, leadExec));
check('approve-lead', leadApprove.ok === true && leadApprove.approval.status === 'approved', leadApprove);
const allowGate = await callGate(pendingDraft);
check('allow-approved', allowGate.result?.kind === 'allow' && allowGate.nextCalled === true, allowGate);
const stored = JSON.parse(fs.readFileSync(process.env.DSH_TEAM_OPS_APPROVALS, 'utf8'));
check('mark-used', stored.items[apvId].usedCount >= 1, stored.items[apvId].usedCount);
const audit = fs.existsSync(process.env.DSH_TEAM_OPS_APPROVAL_AUDIT)
  ? fs.readFileSync(process.env.DSH_TEAM_OPS_APPROVAL_AUDIT, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
  : [];
check('audit-has-approval-id', audit.some((e) => e.approvalId === apvId && e.action === 'allow'), audit.slice(-3));

// 6) 撤回后拒绝
const withdraw = JSON.parse(await approvalTool.execute({ action: 'withdraw', id: apvId }, leadExec));
check('withdraw-ok', withdraw.ok === true && withdraw.approval.status === 'withdrawn', withdraw);
const afterWithdraw = await callGate(pendingDraft);
check('deny-withdrawn', afterWithdraw.result?.kind === 'deny' && /withdrawn/.test(String(afterWithdraw.result.reason)) && !afterWithdraw.nextCalled, afterWithdraw);

// 7) 驳回后拒绝
const rejected = JSON.parse(await approvalTool.execute({ action: 'request', summary: '被驳回的工单' }, leadExec));
const reject = JSON.parse(await approvalTool.execute({ action: 'reject', id: rejected.approval.id }, leadExec));
check('reject-ok', reject.ok === true && reject.approval.status === 'rejected', reject);
const afterReject = await callGate(`approvedByUser: true\napprovalRef: ${rejected.approval.id}\n派给 tools：x`);
check('deny-rejected', afterReject.result?.kind === 'deny' && /rejected/.test(String(afterReject.result.reason)), afterReject);

// 8) /待批 输出 pending
const pendingAgain = JSON.parse(await approvalTool.execute({ action: 'request', summary: '待批列表要能看见我' }, leadExec));
const commandRoute = routes.get('exact:/api/team-ops/command');
function makeRes() {
  return { statusCode: 0, body: '', destroyed: false, writableEnded: false, writeHead(code) { this.statusCode = code; }, end(body) { this.body = String(body ?? ''); this.writableEnded = true; } };
}
const res = makeRes();
process.env.DSH_TEAM_OPS_BRIDGE_TOKEN = 'a4-test-token';
await commandRoute.handler({ url: '/api/team-ops/command?text=%2F%E5%BE%85%E6%89%B9&sessionId=lead-session', method: 'GET', headers: { 'x-team-ops-token': 'a4-test-token' }, socket: { remoteAddress: '127.0.0.1' } }, res);
const commandJson = JSON.parse(res.body);
check('command-pending', res.statusCode === 200 && commandJson.ok === true && typeof commandJson.total === 'number' && Array.isArray(commandJson.items) && commandJson.items.length <= 3, commandJson);

// 9) missing-ref 回归
const noRef = await callGate('approvedByUser: true\n派给 tools：x');
check('deny-missing-ref', noRef.result?.kind === 'deny' && /missing-approval-ref/.test(String(noRef.result.reason)) && !noRef.nextCalled, noRef);

// 10) approved 后过期：派生状态归 expired，不再记 approved；list(expired) 可见
const expiring = JSON.parse(await approvalTool.execute({ action: 'request', summary: '过期回归' }, leadExec));
await approvalTool.execute({ action: 'approve', id: expiring.approval.id }, leadExec);
const stateFile = process.env.DSH_TEAM_OPS_APPROVALS;
const storedState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
storedState.items[expiring.approval.id].expiresAt = new Date(Date.now() - 60000).toISOString();
fs.writeFileSync(stateFile, JSON.stringify(storedState), 'utf8');
const listedExpired = JSON.parse(await approvalTool.execute({ action: 'list', status: 'expired' }, leadExec));
check(
  'counts-expired-derived',
  listedExpired.ok === true
    && listedExpired.counts.expired >= 1
    && listedExpired.counts.approved === 0
    && listedExpired.approvals.some((item) => item.id === expiring.approval.id && item.effectiveStatus === 'expired'),
  listedExpired.counts,
);
const expiredGate = await callGate(`approvedByUser: true\napprovalRef: ${expiring.approval.id}\n派给 tools：x`);
check('deny-expired', expiredGate.result?.kind === 'deny' && /expired/.test(String(expiredGate.result.reason)) && !expiredGate.nextCalled, expiredGate);

const failed = checks.filter((c) => !c.ok).map((c) => c.name);
const out = { ok: failed.length === 0, checks: checks.length, passed: checks.length - failed.length, failed, tmp };
origLog(JSON.stringify(out, null, 2));
if (failed.length) origLog(JSON.stringify(checks.filter((c) => !c.ok), null, 2));
process.exitCode = failed.length ? 1 : 0;
