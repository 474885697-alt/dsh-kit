#!/usr/bin/env node
/**
 * dsh-team-ops 0.2.0 假 ctx 冒烟：不安装、不连网、不碰真实 profile。
 *
 * 覆盖：
 *   1) 事件链路：assistant/message → turn/end(completed) → dry-run 发送 → 拿到 dry messageId
 *   2) 白名单：仅 DSH_TEAM_OPS_LEAD_SESSION 指定会话可发；其他会话/子会话跳过；未配置默认拒绝
 *   3) 去重：重复 turn/end 不重发；IM 已绑定会话跳过
 *   4) 入站命令路由：/状态 /任务 /帮助 + 未知命令
 *   5) 路由与工具注册、loopback 403、health/status 的 allowlist 字段
 *
 * 退出码：0 全过；1 有失败。
 */

import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const tmp = mkdtempSync(join(tmpdir(), 'team-ops-smoke-'));
const fixture = join(tmp, 'snapshot.json');
writeFileSync(fixture, JSON.stringify({
  generatedAt: '2026-11-08T12:00:00.000Z',
  members: [{ id: 'a', status: 'running' }, { id: 'b', status: 'inactive' }],
  tasks: { total: 2, done: 1, inProgress: 1, pending: 0, items: [{ id: 't1', status: 'in_progress', subject: 'demo', owner: 'a' }] },
  hub: { inbox: 1, queued: 0, executing: 1, summarizing: 0 },
}), 'utf8');

Object.assign(process.env, {
  DSH_QQ_OPENID: 'smoke-openid',
  DSH_QQ_APP_ID: 'smoke-appid',
  DSH_QQ_SECRET_REF: 'SMOKE_SECRET_REF',
  DSH_TEAM_OPS_DRY_RUN: '1',
  DSH_TEAM_OPS_LEAD_SESSION: 'lead-session',
  DSH_TEAM_SNAPSHOT: fixture,
  DSH_TEAM_OPS_MIRROR_STATE: join(tmp, 'mirror.json'),
  DSH_TEAM_OPS_MIRROR_LOG: join(tmp, 'mirror.jsonl'),
  DSH_TEAM_OPS_APPROVALS: join(tmp, 'approvals.json'),
  DSH_TEAM_OPS_APPROVAL_AUDIT: join(tmp, 'approvals-audit.jsonl'),
});

const LEAD = 'lead-session';
const REPORT = [
  '结论：C05 报告格式校验通过',
  '交付：镜像只发 5 行摘要',
  '证据：dry-run sha1 前缀',
  '需审核：无',
  '遗留：无',
].join('\n');

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail });
}

const plugin = await import('../lib/index.js');
check('plugin-name', plugin.name === 'dsh-team-ops', plugin.name);
check('plugin-inject', Array.isArray(plugin.inject) && plugin.inject.includes('webServer'), plugin.inject);

const events = new Map();
const routes = new Map();
const tools = new Map();
const disposers = [];
const fakeIm = (id) => (id === 'im-session' ? { channel: 'qq', chatType: 'c2c' } : null);

const ctx = {
  on(name, fn) {
    events.set(name, [...(events.get(name) || []), fn]);
    return () => {};
  },
  get(name) {
    return name === 'dshIm' ? { describeConversationSync: fakeIm } : null;
  },
  webServer: {
    register(route) {
      const key = `${route.kind}:${route.path}`;
      routes.set(key, route);
      return () => routes.delete(key);
    },
  },
  effect(fn) {
    const dispose = fn();
    if (typeof dispose === 'function') disposers.push(dispose);
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

function emit(session, event) {
  for (const fn of events.get('session/event') || []) fn(session, event);
}
function emitBind(name, payload) {
  for (const fn of events.get(name) || []) fn(payload);
}
const tick = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));

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
function makeReq({ url = '/', method = 'GET', ip = '127.0.0.1', body = null, headers = {} } = {}) {
  const req = { url, method, headers, socket: { remoteAddress: ip } };
  req[Symbol.asyncIterator] = async function* () {
    if (body != null) yield Buffer.from(JSON.stringify(body));
  };
  return req;
}
function readMirror() {
  return existsSync(process.env.DSH_TEAM_OPS_MIRROR_STATE)
    ? JSON.parse(readFileSync(process.env.DSH_TEAM_OPS_MIRROR_STATE, 'utf8'))
    : {};
}

const route = (path, kind = 'exact') => routes.get(`${kind}:${path}`);
const health = route('/api/team-ops/health');
const res1 = makeRes();
await health.handler(makeReq({ url: '/api/team-ops/health' }), res1);
check('health-200', res1.statusCode === 200, res1.statusCode);
const healthJson = JSON.parse(res1.body);
check('health-json', healthJson.version === '0.3.4', res1.body.slice(0, 120));
check('health-allowlist', healthJson.mirror?.leadSessionConfigured === true && healthJson.mirror?.leadSessionTail === '-session', healthJson.mirror);

const resForbidden = makeRes();
await health.handler(makeReq({ ip: '10.1.2.3' }), resForbidden);
check('health-loopback-403', resForbidden.statusCode === 403, resForbidden.statusCode);

const status = route('/api/team-ops/status');
const resHtml = makeRes();
await status.handler(makeReq({ url: '/api/team-ops/status' }), resHtml);
check('status-html', resHtml.statusCode === 200 && resHtml.body.includes('<html'), resHtml.statusCode);
const resJson = makeRes();
await status.handler(makeReq({ url: '/api/team-ops/status?format=json' }), resJson);
const statusJson = JSON.parse(resJson.body);
check('status-json', resJson.statusCode === 200 && statusJson.members === 2, resJson.body.slice(0, 160));
check('status-allowlist', statusJson.allowlist?.configured === true && statusJson.allowlist?.leadSessionTail === '-session', statusJson.allowlist);
check('status-roles', statusJson.roles?.count === 10 && Array.isArray(statusJson.roles?.ids) && statusJson.roles.ids.length === 10, statusJson.roles);

// 1) 正常回合（仅 Lead 会话可发）
emit({ header: { id: LEAD } }, {
  type: 'assistant/message',
  data: { turn: 1, message: { content: [{ type: 'reasoning', text: '内部推理' }, { type: 'text', text: REPORT }] } },
});
emit({ header: { id: LEAD } }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
await tick();
let mirrorJson = readMirror();
check('mirror-send', mirrorJson.sends === 1 && String(mirrorJson.lastMessageId || '').startsWith('dry-'), { sends: mirrorJson.sends, id: mirrorJson.lastMessageId });
const mirrorRoute = route('/api/team-ops/mirror');
const resMirror = makeRes();
await mirrorRoute.handler(makeReq({ url: '/api/team-ops/mirror' }), resMirror);
const mirrorRouteJson = JSON.parse(resMirror.body);
check('mirror-allowlist-configured', mirrorRouteJson.mirror?.leadSessionConfigured === true && mirrorRouteJson.mirror?.leadSessionTail === '-session', mirrorRouteJson.mirror);

// 2) 重复 turn/end 不重发
emit({ header: { id: LEAD } }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
await tick();
mirrorJson = readMirror();
check('mirror-dedupe', mirrorJson.sends === 1 && mirrorJson.skippedDup >= 1, { sends: mirrorJson.sends, dup: mirrorJson.skippedDup });

// 2b) 不合格的 5 行报告不发送、不静默截断（C05）
emit({ header: { id: LEAD } }, {
  type: 'assistant/message',
  data: { turn: 7, message: { content: [{ type: 'text', text: '结论：只有一行' }] } },
});
emit({ header: { id: LEAD } }, { type: 'turn/end', data: { turn: 7, reason: { kind: 'completed' } } });
await tick();
mirrorJson = readMirror();
check('mirror-skip-format', mirrorJson.sends === 1 && mirrorJson.skippedFormat >= 1 && mirrorJson.lastFormatError?.code === 'missing-sections', { sends: mirrorJson.sends, format: mirrorJson.skippedFormat, error: mirrorJson.lastFormatError });

// 3) 非 Lead 会话一律跳过（其他成员/中枢）
emit({ header: { id: 'other-session' } }, {
  type: 'assistant/message',
  data: { turn: 1, message: { content: [{ type: 'text', text: '其他成员不应发 QQ' }] } },
});
emit({ header: { id: 'other-session' } }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
await tick();
mirrorJson = readMirror();
check('mirror-skip-other', mirrorJson.sends === 1 && mirrorJson.skippedOther >= 1, { sends: mirrorJson.sends, other: mirrorJson.skippedOther });

// 4) IM 已绑定跳过（事件绑定 + describeConversationSync 两种来源）
emitBind('dsh-im/session-pre-bind', { sessionId: LEAD });
emit({ header: { id: LEAD } }, {
  type: 'assistant/message',
  data: { turn: 5, message: { content: [{ type: 'text', text: '不应回发' }] } },
});
emit({ header: { id: LEAD } }, { type: 'turn/end', data: { turn: 5, reason: { kind: 'completed' } } });
await tick();
mirrorJson = readMirror();
check('mirror-skip-im', mirrorJson.sends === 1 && mirrorJson.skippedIm >= 1, { sends: mirrorJson.sends, im: mirrorJson.skippedIm });

// 子会话跳过（即使白名单是它的父会话）
emit({ header: { id: 'child', parentSession: LEAD } }, {
  type: 'assistant/message',
  data: { turn: 1, message: { content: [{ type: 'text', text: '子会话' }] } },
});
emit({ header: { id: 'child', parentSession: LEAD } }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
await tick();
mirrorJson = readMirror();
check('mirror-skip-child', mirrorJson.sends === 1 && mirrorJson.skippedChild >= 1, mirrorJson.skippedChild);

// 5) 未配置 DSH_TEAM_OPS_LEAD_SESSION：默认拒绝，绝不发送
delete process.env.DSH_TEAM_OPS_LEAD_SESSION;
const { createMirror } = require('../lib/mirror.cjs');
let noLeadSent = 0;
const noLeadMirror = createMirror({
  statePath: join(tmp, 'no-lead.json'),
  logPath: join(tmp, 'no-lead.jsonl'),
  send: async () => { noLeadSent += 1; return { ok: true, messageId: 'should-not-send' }; },
  getImInfo: () => null,
});
noLeadMirror.handle({ header: { id: LEAD } }, {
  type: 'assistant/message',
  data: { turn: 2, message: { content: [{ type: 'text', text: '未配置白名单不应发 QQ' }] } },
});
noLeadMirror.handle({ header: { id: LEAD } }, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } });
await tick();
check('mirror-no-env-deny', noLeadSent === 0 && noLeadMirror.status().sends === 0 && noLeadMirror.status().skippedNoLead >= 1, noLeadMirror.status());
process.env.DSH_TEAM_OPS_LEAD_SESSION = LEAD;

// 6) 入站命令
const command = route('/api/team-ops/command');
async function callCommand(req) {
  const res = makeRes();
  await command.handler(req, res);
  return { status: res.statusCode, json: JSON.parse(res.body) };
}
const cmdStatus = await callCommand(makeReq({ url: '/api/team-ops/command?text=%2F%E7%8A%B6%E6%80%81' }));
check('command-status', cmdStatus.status === 200 && cmdStatus.json.reply.includes('成员 2'), cmdStatus.json.reply);
const cmdTasks = await callCommand(makeReq({ url: '/api/team-ops/command', method: 'POST', body: { text: '/任务' } }));
check('command-tasks', cmdTasks.status === 200 && cmdTasks.json.reply.includes('t1'), cmdTasks.json.reply);
const cmdQueue = await callCommand(makeReq({ url: '/api/team-ops/command?text=%2F%E9%98%9F%E5%88%97' }));
check('command-queue', cmdQueue.status === 200 && cmdQueue.json.reply.includes('受理'), cmdQueue.json.reply);
const cmdSummary = await callCommand(makeReq({ url: '/api/team-ops/command?text=%2F%E6%B1%87%E6%80%BB' }));
check('command-summary', cmdSummary.status === 200 && cmdSummary.json.reply.split('\n').length === 5 && cmdSummary.json.reply.includes('结论：'), cmdSummary.json.reply);
const cmdHelp = await callCommand(makeReq({ url: '/api/team-ops/command?text=%2F%E5%B8%AE%E5%8A%A9' }));
check('command-help', cmdHelp.status === 200 && cmdHelp.json.reply.includes('/状态'), cmdHelp.json.reply);
const cmdUnknown = await callCommand(makeReq({ url: '/api/team-ops/command?text=%2Fxxx' }));
check('command-unknown', cmdUnknown.status === 200 && cmdUnknown.json.reply.includes('没听懂'), cmdUnknown.json.reply);
const cmdForbidden = await callCommand(makeReq({ url: '/api/team-ops/command?text=%2F%E5%B8%AE%E5%8A%A9', ip: '10.0.0.9' }));
check('command-loopback-403', cmdForbidden.status === 403, cmdForbidden.status);
const cmdRoles = await callCommand(makeReq({ url: '/api/team-ops/command?text=%2F%E8%A7%92%E8%89%B2' }));
const roleLines = String(cmdRoles.json.reply || '').split('\n');
check('command-roles', cmdRoles.status === 200 && roleLines.length === 10 && roleLines.some((l) => l.startsWith('lead｜')) && roleLines.some((l) => l.startsWith('qa｜')), { lines: roleLines.length });
const cmdRolesAlias = await callCommand(makeReq({ url: '/api/team-ops/command?text=%2Froles' }));
check('command-roles-alias', cmdRolesAlias.status === 200 && String(cmdRolesAlias.json.reply || '').split('\n').length === 10, cmdRolesAlias.json.reply?.slice(0, 80));

// F3：HTTP 命令不信任 body/query 的 sessionId；只有带桥接 token 才注入身份
const forgedCmd = await callCommand(makeReq({
  url: '/api/team-ops/command', method: 'POST', body: { text: '/提问 F3 伪造 | A | B', sessionId: LEAD },
}));
check('command-forged-session-403', forgedCmd.status === 403, forgedCmd.json);
process.env.DSH_TEAM_OPS_BRIDGE_TOKEN = 'tok-test-123';
const tokenCmd = await callCommand(makeReq({
  url: '/api/team-ops/command', method: 'POST',
  body: { text: '/提问 F3 token | A | B', sessionId: LEAD },
  headers: { 'x-team-ops-token': 'tok-test-123' },
}));
delete process.env.DSH_TEAM_OPS_BRIDGE_TOKEN;
check('command-token-session-ok', tokenCmd.status === 200 && tokenCmd.json.ok === true, tokenCmd.json);

// 7) 工具
check('tools-registered', ['team_status', 'qq_notify', 'team_mirror', 'team_approval'].every((name) => tools.has(name)), [...tools.keys()]);
const leadExec = { agent: { id: 'lead-agent', session: { id: LEAD } } };
const notifyRes = JSON.parse(await tools.get('qq_notify').execute({ text: '你好', dryRun: true }, leadExec));
check('tool-notify-dryrun', notifyRes.ok === true && notifyRes.dryRun === true && notifyRes.chars === 2 && notifyRes.lead === true, notifyRes);
const notifyDenied = JSON.parse(await tools.get('qq_notify').execute({ text: '你好', dryRun: true }, { agent: { id: 'hub-agent', session: { id: 'hub-session' } } }));
check('tool-notify-non-lead-403', notifyDenied.ok === false && notifyDenied.status === 403 && notifyDenied.sent === false, notifyDenied);
const notifyEmpty = JSON.parse(await tools.get('qq_notify').execute({ text: '  ' }, leadExec));
check('tool-notify-empty', notifyEmpty.ok === false, notifyEmpty);
const mirrorTool = JSON.parse(await tools.get('team_mirror').execute({}));
check('tool-mirror', mirrorTool.ok === true && mirrorTool.mirror.sends === 1 && mirrorTool.mirror.leadSessionConfigured === true, { sends: mirrorTool.mirror?.sends, configured: mirrorTool.mirror?.leadSessionConfigured });
const statusTool = JSON.parse(await tools.get('team_status').execute({}));
check('tool-status', statusTool.ok === true && statusTool.members === 2, statusTool);

// 8) 角色数据与只读 API
const rolesData = require('../lib/roles.cjs');
const roleList = rolesData.ROLES;
const roleIds = roleList.map((r) => r.id);
check('roles-count', roleList.length === 10, roleIds);
check('roles-ids-unique', new Set(roleIds).size === 10, roleIds);
const expectedIds = ['lead', 'hub', 'mechanics', 'art-audio', 'copy', 'tools', 'test', 'bug', 'qa', 'online'];
check('roles-ids-expected', expectedIds.every((id) => roleIds.includes(id)), roleIds);
const requiredFields = ['id', 'label', 'description', 'systemPrompt', 'writeScopes', 'reads', 'canSpawn', 'canMerge', 'canAccept', 'defaultModel', 'constraints'];
const missingFields = roleList.flatMap((r) => requiredFields.filter((k) => !(k in r)).map((k) => `${r.id}.${k}`));
check('roles-fields', missingFields.length === 0, missingFields);
check('roles-constraints', roleList.every((r) => Array.isArray(r.constraints) && r.constraints.length >= 3 && r.constraints.length <= 6), roleList.map((r) => [r.id, r.constraints.length]));
check('roles-perms', roleList.every((r) => (r.id === 'lead'
  ? r.canSpawn === true && r.canMerge === true && r.canAccept === true
  : r.canSpawn === false && r.canMerge === false && r.canAccept === false)), 'only lead true');
check('roles-prompts', roleList.every((r) => typeof r.systemPrompt === 'string' && r.systemPrompt.length >= 40 && !/TODO|占位/.test(r.systemPrompt)), roleList.map((r) => [r.id, r.systemPrompt.length]));
check('roles-model', roleList.every((r) => r.defaultModel === 'deepseek-flash'), 'deepseek-flash');
check('roles-frozen', Object.isFrozen(rolesData.ROLES) && Object.isFrozen(rolesData.getRole('hub')) && Object.isFrozen(rolesData.getRole('hub').writeScopes), 'frozen');
check('roles-get-unknown', rolesData.getRole('nope') === null, rolesData.getRole('nope'));

const rolesRoute = route('/api/team-ops/roles');
const resRoles = makeRes();
await rolesRoute.handler(makeReq({ url: '/api/team-ops/roles' }), resRoles);
const rolesJson = JSON.parse(resRoles.body);
check('roles-route-200', resRoles.statusCode === 200 && rolesJson.count === 10 && Array.isArray(rolesJson.roles) && rolesJson.roles.length === 10, { code: resRoles.statusCode, count: rolesJson.count });
const resRolesFull = makeRes();
await rolesRoute.handler(makeReq({ url: '/api/team-ops/roles?full=1' }), resRolesFull);
const rolesFull = JSON.parse(resRolesFull.body);
check('roles-route-full', resRolesFull.statusCode === 200 && rolesFull.roles.every((r) => typeof r.systemPrompt === 'string' && r.systemPrompt.length > 10), rolesFull.roles?.length);
const resRolesForbidden = makeRes();
await rolesRoute.handler(makeReq({ url: '/api/team-ops/roles', ip: '10.9.9.9' }), resRolesForbidden);
check('roles-route-loopback-403', resRolesForbidden.statusCode === 403, resRolesForbidden.statusCode);

const roleRoute = route('/api/team-ops/roles', 'prefix');
const resHubRole = makeRes();
await roleRoute.handler(makeReq({ url: '/api/team-ops/roles/hub' }), resHubRole);
const hubRoleJson = JSON.parse(resHubRole.body);
check('role-id-200', resHubRole.statusCode === 200 && hubRoleJson.role?.id === 'hub', { code: resHubRole.statusCode, id: hubRoleJson.role?.id });
const resRole404 = makeRes();
await roleRoute.handler(makeReq({ url: '/api/team-ops/roles/nope' }), resRole404);
check('role-id-404', resRole404.statusCode === 404, resRole404.statusCode);
const resRoleForbidden = makeRes();
await roleRoute.handler(makeReq({ url: '/api/team-ops/roles/hub', ip: '10.9.9.8' }), resRoleForbidden);
check('role-id-loopback-403', resRoleForbidden.statusCode === 403, resRoleForbidden.statusCode);

const exactRoleKeys = [...routes.keys()].filter((key) => key.startsWith('exact:/api/team-ops/roles/'));
check('roles-exact-routes', exactRoleKeys.length === 10
  && expectedIds.every((id) => routes.has(`exact:/api/team-ops/roles/${id}`)), exactRoleKeys.length);
const resRolesQuery = makeRes();
await rolesRoute.handler(makeReq({ url: '/api/team-ops/roles?id=hub' }), resRolesQuery);
const rolesQuery = JSON.parse(resRolesQuery.body);
check('roles-route-query-id', resRolesQuery.statusCode === 200 && rolesQuery.role?.id === 'hub', { code: resRolesQuery.statusCode, id: rolesQuery.role?.id });

// 收尾
for (const dispose of disposers.reverse()) {
  try { dispose(); } catch { /* ignore */ }
}
rmSync(tmp, { recursive: true, force: true });

const failed = checks.filter((c) => !c.ok);
console.log(JSON.stringify({
  ok: failed.length === 0,
  version: '0.3.1',
  checks: checks.length,
  failed: failed.map((f) => f.name),
  detail: checks,
}, null, 2));
process.exit(failed.length === 0 ? 0 : 1);
