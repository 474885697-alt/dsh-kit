#!/usr/bin/env node
/**
 * WO-1b 接线自测（fake ctx，不触网）。
 * 覆盖：pre-execute 先跑 role-guard；非 Lead 危险工具 deny；Lead 保留
 * spawn/interrupt/plugin_manager；mapped mechanics 写域；未知 session 跳过写域但
 * deny 危险工具；team_task_create 原有审批门不变；/health roleGuard 字段与启动横幅。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'team-ops-role-wiring-'));
const root = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const roleSessions = path.join(tmp, 'role-sessions.json');
fs.writeFileSync(roleSessions, JSON.stringify({
  sessions: {
    'mechanics-session-1': 'mechanics',
    'hub-session-1': 'hub',
    'qa-session-1': 'qa',
  },
}), 'utf8');

Object.assign(process.env, {
  DSH_TEAM_OPS_APPROVALS: path.join(tmp, 'approvals.json'),
  DSH_TEAM_OPS_APPROVAL_AUDIT: path.join(tmp, 'approvals-audit.jsonl'),
  DSH_TEAM_OPS_LEAD_SESSION: 'lead-session-1',
  DSH_TEAM_OPS_ROLE_SESSIONS: roleSessions,
  DSH_TEAM_OPS_ROLE_AUDIT: path.join(tmp, 'role-guard-audit.jsonl'),
  DSH_QQ_OPENID: 'test-openid',
  DSH_QQ_APP_ID: 'test-appid',
  DSH_QQ_SECRET_REF: 'test-secret',
});
delete process.env.DSH_TEAM_ROLE;

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
  sessions: {
    get() { return { header: { cwd: root } }; },
  },
  webServer: {
    register(route) {
      const key = `${route.kind}:${route.path}`;
      routes.set(key, route);
      return () => routes.delete(key);
    },
  },
  effect(fn) {
    return fn();
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
const logs = [];
console.log = (...args) => { logs.push(args.join(' ')); };
console.error = () => {};
plugin.apply(ctx);
console.log = origLog;
console.error = origError;

const preExecute = (events.get('tools/pre-execute') || [])[0];
check('pre-execute-registered', typeof preExecute === 'function', Boolean(preExecute));
check('banner-member-roles-disabled', logs.some((line) => line.includes('role-guard：成员级未启用')), logs);

async function callTool(name, args, sessionId) {
  let nextCalled = false;
  const result = await preExecute(
    { name, arguments: args, agent: { session: { id: sessionId } } },
    () => { nextCalled = true; return { kind: 'next' }; },
  );
  return { result, nextCalled };
}
const isRoleDeny = (r) => r.result?.kind === 'deny' && /^role-guard:/.test(String(r.result.reason)) && !r.nextCalled;

// 1) 非 Lead 危险工具：整工具 deny
check('nonlead-spawn-deny', isRoleDeny(await callTool('spawn_teammate', {}, 'mechanics-session-1')));
check('nonlead-interrupt-deny', isRoleDeny(await callTool('interrupt_agent', { target: 'x' }, 'qa-session-1')));
check('nonlead-plugin-manager-deny', isRoleDeny(await callTool('plugin_manager', { action: 'list_bundles' }, 'qa-session-1')));
check('nonlead-qq-notify-deny', isRoleDeny(await callTool('qq_notify', { text: 'x' }, 'hub-session-1')));
check('nonlead-task-delete-deny', isRoleDeny(await callTool('team_task_update', { task_id: 't', action: 'delete' }, 'qa-session-1')));

// 2) Lead 保留能力；但按决策 Lead 不写文件（writeScopes=[]）
check('lead-spawn-allow', (await callTool('spawn_teammate', {}, 'lead-session-1')).nextCalled === true);
check('lead-interrupt-allow', (await callTool('interrupt_agent', { target: 'x' }, 'lead-session-1')).nextCalled === true);
check('lead-plugin-manager-allow', (await callTool('plugin_manager', { action: 'list_bundles' }, 'lead-session-1')).nextCalled === true);
check('lead-task-delete-allow', (await callTool('team_task_update', { task_id: 't', action: 'delete' }, 'lead-session-1')).nextCalled === true);
check('lead-edit-deny', isRoleDeny(await callTool('edit', { file_path: 'src/app/part-01.js' }, 'lead-session-1')));

// 3) mapped mechanics 写域（相对 + 绝对）
check('mechanics-src-allow', (await callTool('edit', { file_path: 'src/app/part-01.js' }, 'mechanics-session-1')).nextCalled === true);
check('mechanics-absolute-src-allow', (await callTool('write', { file_path: path.join(root, 'src', 'styles', 'a.css') }, 'mechanics-session-1')).nextCalled === true);
check('mechanics-docs-deny', isRoleDeny(await callTool('edit', { file_path: 'docs/中枢/x.md' }, 'mechanics-session-1')));
check('mechanics-outside-deny', isRoleDeny(await callTool('write', { file_path: '../outside.txt' }, 'mechanics-session-1')));

// 4) 未知 session：写域 skipped 放行，危险工具仍 deny
check('unknown-edit-skipped-allow', (await callTool('edit', { file_path: 'src/whatever.js' }, 'unknown-session-1')).nextCalled === true);
check('unknown-spawn-deny', isRoleDeny(await callTool('spawn_teammate', {}, 'unknown-session-1')));

// 5) team_task_create 原有审批门不被 role-guard 改动：hub 建单先过角色门，再被审批门拒
const hubGate = await callTool('team_task_create', { subject: '中枢区-接线测试', description: '派给 tools：x' }, 'hub-session-1');
check('task-create-approval-gate-intact', hubGate.result?.kind === 'deny' && /^approval-gate:/.test(String(hubGate.result.reason)) && !hubGate.nextCalled, hubGate);

// 6) 审计：字段白名单；deny 行 = deny 次数；skipped 1 行
const auditPath = process.env.DSH_TEAM_OPS_ROLE_AUDIT;
const audit = fs.existsSync(auditPath)
  ? fs.readFileSync(auditPath, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
  : [];
const denyResults = checks.filter((c) => c.name.includes('deny') && c.ok).length;
const denyAudit = audit.filter((entry) => entry.decision === 'deny');
const skippedAudit = audit.filter((entry) => entry.writecheck === 'skipped');
const allowedKeys = ['ts', 'sessionTail', 'role', 'tool', 'decision', 'reason', 'writecheck', 'pathPrefix'];
check('audit-deny-count', denyAudit.length === denyResults, { denyResults, denyAudit: denyAudit.length });
check('audit-skipped-once', skippedAudit.length === 1, skippedAudit);
check('audit-keys-whitelist', audit.every((entry) => Object.keys(entry).every((key) => allowedKeys.includes(key))), audit[0]);

// 7) /health 含 roleGuard；QQ 配置齐全时 200；lastAudit 非 null
const health = routes.get('exact:/api/team-ops/health');
function makeRes() {
  return {
    statusCode: 0,
    body: '',
    destroyed: false,
    writableEnded: false,
    writeHead(code) { this.statusCode = code; },
    end(body) { this.body = String(body ?? ''); this.writableEnded = true; },
  };
}
const res = makeRes();
await health.handler({ url: '/api/team-ops/health', headers: {}, socket: { remoteAddress: '127.0.0.1' } }, res);
const healthJson = JSON.parse(res.body);
check('health-200', res.statusCode === 200, res.statusCode);
check(
  'health-role-guard',
  healthJson.roleGuard?.enabled === true
    && healthJson.roleGuard?.memberRoles === 'disabled'
    && healthJson.roleGuard?.roleCount === 10
    && healthJson.roleGuard?.enforceWriteScopes === true
    && typeof healthJson.roleGuard?.lastAudit === 'string',
  healthJson.roleGuard,
);

const failed = checks.filter((c) => !c.ok).map((c) => c.name);
origLog(JSON.stringify({ ok: failed.length === 0, checks: checks.length, passed: checks.length - failed.length, failed, tmp }, null, 2));
if (failed.length) origLog(JSON.stringify(checks.filter((c) => !c.ok), null, 2));
process.exitCode = failed.length ? 1 : 0;
