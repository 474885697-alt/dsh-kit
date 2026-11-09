#!/usr/bin/env node
/**
 * C01：qq_notify 仅 Lead 可发，与 team_mirror 共用 lead-gate。
 *
 * 不触网：投递成功/失败路径用注入的 send / 纯函数分类器验证。
 * 用法：node test/qq-lead-only.mjs
 */
import os from 'node:os';
import path from 'node:path';

process.env.DSH_QQ_DELIVERY_LOG = path.join(os.tmpdir(), `qq-lead-only-${process.pid}-${Date.now()}.jsonl`);
const LEAD = 'lead-session-0001';
process.env.DSH_TEAM_OPS_LEAD_SESSION = LEAD;

const { apply } = await import('../lib/index.js');
const qq = (await import('../lib/qq.cjs')).default;
const leadGate = (await import('../lib/lead-gate.cjs')).default;
const { createMirror } = await import('../lib/mirror.cjs');

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail });
  if (!ok) console.error(`FAIL ${name}: ${JSON.stringify(detail)}`);
}

function makeCtx() {
  const routes = new Map();
  const tools = new Map();
  const ctx = {
    webServer: {
      register(route) {
        const key = `${route.kind || 'exact'}:${route.path}`;
        routes.set(key, route);
        return () => routes.delete(key);
      },
    },
    on() {},
    get() { return null; },
    effect(fn) { const dispose = fn(); return () => dispose?.(); },
    inject(_names, cb) {
      const tctx = {
        tools: {
          register(def) { tools.set(def.name, def); return () => tools.delete(def.name); },
        },
        effect(fn) { const dispose = fn(); return () => dispose?.(); },
      };
      cb(tctx);
    },
  };
  return { ctx, routes, tools };
}

const { ctx, routes, tools } = makeCtx();
apply(ctx);
const notify = tools.get('qq_notify');
check('tool-registered', Boolean(notify), [...tools.keys()]);
check('routes-registered', routes.size >= 4, routes.size);

async function callNotify(args, sessionId) {
  const exec = sessionId === undefined ? undefined : { agent: { id: 'agent-1', session: { id: sessionId } } };
  return JSON.parse(await notify.execute(args, exec));
}

// 1) 非 Lead（hub）→ 403 / no-send
const hub = await callNotify({ text: 'hi', dryRun: true }, 'hub-other-9999');
check('hub-403', hub.ok === false && hub.status === 403 && hub.sent === false && hub.reason === 'other', hub);
check('hub-dryrun-not-sent', hub.dryRun === undefined && hub.endpoint === undefined, hub);

// 2) 无会话 id → 拒绝
const anon = await callNotify({ text: 'hi', dryRun: true });
check('no-session-403', anon.ok === false && anon.status === 403 && anon.reason === 'no-session', anon);

// 3) Lead → dry-run 成功
const lead = await callNotify({ text: 'hi', dryRun: true }, LEAD);
check('lead-dryrun-ok', lead.ok === true && lead.dryRun === true && lead.lead === true && lead.chars === 2, lead);

// 4) 未配置白名单 → 一律拒绝
delete process.env.DSH_TEAM_OPS_LEAD_SESSION;
const noLead = await callNotify({ text: 'hi', dryRun: true }, LEAD);
check('no-lead-403', noLead.ok === false && noLead.status === 403 && noLead.reason === 'no-lead', noLead);
process.env.DSH_TEAM_OPS_LEAD_SESSION = LEAD;

// 5) SDK 缺 messageId → 失败（重试 2 次，不触网）
let attempts = 0;
const missing = await qq.sendSdkRequired('x', { send: async () => { attempts += 1; return {}; }, retryDelayMs: 0 });
check('sdk-missing-messageId-fail', missing.ok === false && /no messageId/.test(missing.error || '') && attempts === 2, { missing, attempts });

// 6) SDK 有 messageId → verified 成功
const good = await qq.sendSdkRequired('x', { send: async () => ({ id: 'msg-42' }), retryDelayMs: 0 });
check('sdk-messageid-verified', good.ok === true && good.verified === true && good.messageId === 'msg-42', good);

// 7) HTTP {sent:true} 只是桥受理，不算 verified
const bridgeOnly = qq.classifyHttpDelivery(true, 200, { sent: true });
check('http-sent-not-verified', bridgeOnly.ok === true && bridgeOnly.verified === false && bridgeOnly.evidence === 'sent-flag', bridgeOnly);
const httpVerified = qq.classifyHttpDelivery(true, 200, { sent: true, messageId: 'm-9' });
check('http-messageid-verified', httpVerified.ok === true && httpVerified.verified === true && httpVerified.messageId === 'm-9', httpVerified);
const httpFail = qq.classifyHttpDelivery(false, 500, { error: 'x' });
check('http-error-not-ok', httpFail.ok === false && httpFail.verified === false, httpFail);

// 8) team_mirror 与 qq_notify 共用同一判定
const mirror = createMirror({ statePath: path.join(os.tmpdir(), `mirror-state-${process.pid}.json`), logPath: path.join(os.tmpdir(), `mirror-log-${process.pid}.jsonl`) });
const mstatus = mirror.status();
check('mirror-shared-gate', mstatus.leadSessionConfigured === true && mstatus.leadSessionTail === LEAD.slice(-8), mstatus);
const gate = leadGate.isLead(LEAD);
check('lead-gate-direct', gate.allowed === true && gate.reason === 'lead', gate);
const denied = leadGate.isLead('hub-1');
check('lead-gate-denies-other', denied.allowed === false && denied.status === 403 && denied.reason === 'other', denied);

const failed = checks.filter((c) => !c.ok);
console.log(JSON.stringify({
  ok: failed.length === 0,
  checks: checks.length,
  passed: checks.length - failed.length,
  failed: failed.map((c) => c.name),
}, null, 2));
process.exit(failed.length === 0 ? 0 : 1);
