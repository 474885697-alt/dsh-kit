/**
 * dsh-team-ops
 *
 * 把「QQ 回执投递 + 团队状态快照 + 最终回答镜像」沉淀成宿主插件：
 *   - GET  /api/team-ops/health   健康检查（loopback；QQ 配置缺失时 503）
 *   - GET  /api/team-ops/status   团队状态页（?format=json 返回 JSON）
 *   - GET  /api/team-ops/mirror   镜像状态（发送数/失败/跳过原因）
 *   - GET|POST /api/team-ops/command  入站快捷命令（/状态 /队列 /任务 /帮助）
 *   - 工具 team_status           读取快照（可选写 docs/team-status/index.html）
 *   - 工具 qq_notify             发一条 QQ 消息（dryRun 可只预演）
 *   - 工具 team_mirror           读取 0.2.0 镜像状态
 *
 * 0.2.0 新增：监听宿主 session/event（assistant/message + turn/end），
 * 回合完成时用 QQ SDK 直发 owner，必须拿到平台 messageId；已绑定 IM 的会话跳过
 * （dsh-im sessionSync 会回发），子会话默认不镜像。
 *
 * 只依赖 Node 内置模块与同包 lib/*.cjs，可被 link 到任意 profile。
 * 不自动派发任务、不改任务板；openid / AppID / 密钥不写进插件，走环境变量。
 */

import { dirname } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import qq from './qq.cjs';
import status from './status.cjs';
import commands from './commands.cjs';
import resumeCandidates from './resume-candidates.cjs';
import approvals from './approvals.cjs';
import approvalQueue from './approval-queue.cjs';
import roles from './roles.cjs';
import leadGate from './lead-gate.cjs';
import { createMirror } from './mirror.cjs';

export const name = 'dsh-team-ops';
export const inject = ['webServer'];

const PREFIX = '/api/team-ops';
const VERSION = '0.3.4';
// 供重启后确认“新进程是否真的加载了 A-lite 路由”；旧进程的 health 里没有该字段。
const FEATURES = ['resume-candidates'];
const HERE = dirname(fileURLToPath(import.meta.url));
void HERE;

/**
 * 命令路由的会话身份只信「桥接 token」：未配置 DSH_TEAM_OPS_BRIDGE_TOKEN 时
 * HTTP 请求不注入任何 sessionId（body/query 里的值一律忽略），特权命令自然 403。
 * 工具调用（exec）与同进程注入不受影响。
 */
function trustedSessionId(req, body, url) {
  const expected = String(process.env.DSH_TEAM_OPS_BRIDGE_TOKEN || '');
  if (!expected) return '';
  const provided = String(req?.headers?.['x-team-ops-token'] || '');
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return '';
  return String(body?.sessionId ?? url.searchParams.get('sessionId') ?? '');
}

function loopback(req) {
  const addr = String(req?.socket?.remoteAddress || '');
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function sendJson(res, code, value) {
  if (res.destroyed || res.writableEnded) return;
  const body = JSON.stringify(value);
  res.writeHead(code, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
  });
  res.end(body);
}

function sendHtml(res, code, html) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(code, {
    'cache-control': 'no-store',
    'content-type': 'text/html; charset=utf-8',
    'content-length': String(Buffer.byteLength(html)),
  });
  res.end(html);
}

async function readJson(req, limit = 16384) {
  if (req?.method !== 'POST') return null;
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

function snapshotPath() {
  return process.env.DSH_TEAM_SNAPSHOT || status.DEFAULT_SNAPSHOT;
}

function statusPayload() {
  const snapshot = status.readSnapshot(snapshotPath());
  const deliveries = status.readDeliveries(status.LOG_PATH);
  return { snapshot, deliveries, summary: status.summary(snapshot, deliveries) };
}

function createImLookup(ctx) {
  return (sessionId) => {
    try {
      const svc = typeof ctx.get === 'function' ? ctx.get('dshIm') : null;
      if (!svc || typeof svc.describeConversationSync !== 'function') return null;
      return svc.describeConversationSync(sessionId) || null;
    } catch {
      return null;
    }
  };
}

function callingSessionId(exec) {
  return String(exec?.agent?.session?.id || exec?.agent?.sessionId || exec?.session?.id || '');
}

export function apply(ctx) {
  const config = qq.configStatus();
  const mirror = createMirror({ getImInfo: createImLookup(ctx) });

  if (config.ready) {
    ctx.on('session/event', (session, event) => mirror.handle(session, event));
    console.log(`[team-ops] QQ mirror enabled (openid …${config.openidTail}, appId ${config.appId})`);
  } else {
    console.error(`[team-ops] QQ mirror disabled: ${config.error}`);
  }
  try {
    ctx.on('dsh-im/session-pre-bind', (info) => mirror.bind(info?.sessionId));
    ctx.on('dsh-im/session-unbind', (info) => mirror.unbind(info?.sessionId));
  } catch { /* 宿主没有 dsh-im 时静默 */ }

  const routes = [
    {
      kind: 'exact',
      path: `${PREFIX}/health`,
      handler: (req, res) => {
        if (!loopback(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
        const payload = {
          ok: config.ready,
          name,
          version: VERSION,
          features: FEATURES,
          time: new Date().toISOString(),
          qq: config,
          mirror: mirror.status(),
        };
        return sendJson(res, config.ready ? 200 : 503, payload);
      },
    },
    {
      kind: 'exact',
      path: `${PREFIX}/status`,
      handler: (req, res) => {
        if (!loopback(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
        try {
          const { snapshot, deliveries, summary } = statusPayload();
          const url = new URL(req.url || '/', 'http://127.0.0.1');
          if (url.searchParams.get('format') === 'json') {
            return sendJson(res, 200, {
              ok: true,
              ...summary,
              deliveries: deliveries.length,
              roles: { count: roles.ROLE_IDS.length, ids: roles.ROLE_IDS },
              snapshotPath: snapshotPath(),
              allowlist: {
                configured: mirror.status().leadSessionConfigured,
                leadSessionTail: mirror.status().leadSessionTail,
              },
            });
          }
          return sendHtml(res, 200, status.render(snapshot, deliveries));
        } catch (error) {
          return sendJson(res, 500, { ok: false, error: String(error?.message || error) });
        }
      },
    },
    {
      kind: 'exact',
      path: `${PREFIX}/mirror`,
      handler: (req, res) => {
        if (!loopback(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
        return sendJson(res, 200, { ok: true, version: VERSION, configured: config.ready, config, mirror: mirror.status() });
      },
    },
    {
      kind: 'exact',
      path: `${PREFIX}/roles`,
      handler: (req, res) => {
        if (!loopback(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
        try {
          const url = new URL(req.url || '/', 'http://127.0.0.1');
          const id = url.searchParams.get('id');
          if (id) {
            const role = roles.getRole(id);
            if (!role) return sendJson(res, 404, { ok: false, error: `unknown role: ${id}` });
            return sendJson(res, 200, { ok: true, count: roles.ROLE_IDS.length, role });
          }
          const full = url.searchParams.get('full') === '1';
          return sendJson(res, 200, {
            ok: true,
            count: roles.ROLE_IDS.length,
            ids: roles.ROLE_IDS,
            roles: full ? roles.ROLES : roles.listRoles(),
          });
        } catch (error) {
          return sendJson(res, 500, { ok: false, error: String(error?.message || error) });
        }
      },
    },
    // 路径式 /roles/:id：宿主按 exact 精确匹配、prefix 按段前缀匹配，未知 id 走 prefix 404。
    ...roles.ROLE_IDS.map((roleId) => ({
      kind: 'exact',
      path: `${PREFIX}/roles/${roleId}`,
      handler: (req, res) => {
        if (!loopback(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
        const role = roles.getRole(roleId);
        return role
          ? sendJson(res, 200, { ok: true, role })
          : sendJson(res, 404, { ok: false, error: `unknown role: ${roleId}` });
      },
    })),
    {
      kind: 'prefix',
      path: `${PREFIX}/roles`,
      handler: (req, res) => {
        if (!loopback(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
        try {
          const pathname = String(req?.url || '').split('?')[0].replace(/\/+$/, '');
          const id = decodeURIComponent(pathname.slice(`${PREFIX}/roles`.length + 1));
          const role = roles.getRole(id);
          if (!role) return sendJson(res, 404, { ok: false, error: `unknown role: ${id}` });
          return sendJson(res, 200, { ok: true, role });
        } catch (error) {
          return sendJson(res, 500, { ok: false, error: String(error?.message || error) });
        }
      },
    },
    {
      kind: 'exact',
      path: `${PREFIX}/resume-candidates`,
      handler: (req, res) => {
        if (!loopback(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
        try {
          const result = resumeCandidates.scan();
          return sendJson(res, 200, { ...result, written: false });
        } catch (error) {
          return sendJson(res, 500, { ok: false, error: String(error?.message || error) });
        }
      },
    },
    {
      kind: 'exact',
      path: `${PREFIX}/command`,
      handler: async (req, res) => {
        if (!loopback(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
        try {
          const url = new URL(req.url || '/', 'http://127.0.0.1');
          const body = await readJson(req);
          const text = String(body?.text ?? url.searchParams.get('text') ?? '').slice(0, 2000);
          const sessionId = trustedSessionId(req, body, url);
          const result = await commands.handleCommand(text, { snapshotPath: snapshotPath(), sessionId });
          return sendJson(res, result.status === 403 ? 403 : 200, result);
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: String(error?.message || error) });
        }
      },
    },
  ];

  const disposers = routes.map((route) => ctx.webServer.register(route));
  ctx.effect(() => () => {
    for (const dispose of disposers) {
      try { dispose?.(); } catch { /* ignore */ }
    }
  }, 'dsh-team-ops: routes');

  // C03：工单审批门。只拦截 team_task_create；description 必须同时含
  // `approvedByUser: true` 与有效 `approvalRef`，否则拒绝并写审计日志。
  ctx.on('tools/pre-execute', async (exec, next) => {
    try {
      if (exec?.name !== 'team_task_create') return next();
      const description = exec?.arguments?.description;
      const sessionId = callingSessionId(exec);
      const verdict = approvals.gate(description);
      if (verdict.allowed) {
        const item = approvals.markUsed(verdict.approvalRef, { note: 'team_task_create' });
        approvals.appendAudit({
          action: 'allow',
          code: 'ok',
          tool: 'team_task_create',
          approvalId: verdict.approvalRef,
          sessionTail: leadGate.tail(sessionId),
          summary: item?.summary || null,
          descriptionTail: String(description || '').slice(0, 160),
        });
        return next();
      }
      approvals.appendAudit({
        action: 'deny',
        code: verdict.code,
        tool: 'team_task_create',
        approvalId: verdict.approvalRef || null,
        sessionTail: leadGate.tail(sessionId),
        descriptionTail: String(description || '').slice(0, 160),
      });
      return {
        kind: 'deny',
        reason: `approval-gate: ${verdict.code} — ${verdict.message}`,
        displayReason: `工单未获用户批准（${verdict.code}）`,
      };
    } catch (error) {
      return { kind: 'deny', reason: `approval-gate internal error: ${String(error?.message || error)}` };
    }
  });

  ctx.inject(['tools'], (scope) => scope.effect(() => {
    const output = {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    };

    const disposeStatus = scope.tools.register({
      name: 'team_status',
      description: '读取团队状态快照（docs/tmp/team-status.json）并汇总成员/任务/中枢/最近投递；write=true 时同时刷新 docs/team-status/index.html。不修改任务板。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          snapshot: {
            type: 'string',
            description: '快照文件路径；省略时用 DSH_TEAM_SNAPSHOT 或 docs/tmp/team-status.json。',
          },
          write: {
            type: 'boolean',
            description: 'true 时把渲染结果写到 docs/team-status/index.html；默认 false 只读。',
          },
        },
      },
      async execute(args) {
        try {
          const file = args?.snapshot || snapshotPath();
          const snapshot = status.readSnapshot(file);
          const deliveries = status.readDeliveries(status.LOG_PATH);
          const summary = status.summary(snapshot);
          let written = null;
          if (args?.write === true) written = status.writeStatus(snapshot, deliveries);
          return JSON.stringify({ ok: true, snapshotPath: file, ...summary, deliveries: deliveries.length, written }, null, 2);
        } catch (error) {
          return JSON.stringify({ ok: false, error: String(error?.message || error) });
        }
      },
    });

    const disposeNotify = scope.tools.register({
      name: 'qq_notify',
      description: '仅 Lead 会话可调用：向已绑定的 QQ 发一条消息（优先 dsh-im HTTP，失败回退 QQ SDK）。非 Lead/未配置白名单会返回 403 且不投递。dryRun=true 只返回将使用的端点与字数，不发送。不自动派发任务。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', description: '消息正文，最多 4000 字符。' },
          format: { type: 'string', enum: ['text', 'markdown'], description: '消息格式，默认 text。' },
          dryRun: { type: 'boolean', description: 'true 时只预演，不发送。' },
          passive: { type: 'boolean', description: 'true 时走被动回复（需要最近一条入站消息 id）。' },
          noFallback: { type: 'boolean', description: 'true 时 HTTP 失败不回退 SDK。' },
        },
        required: ['text'],
      },
      async execute(args, exec) {
        const sessionId = callingSessionId(exec);
        const gate = leadGate.isLead(sessionId);
        if (!gate.allowed) {
          return JSON.stringify({
            ok: false,
            status: 403,
            sent: false,
            error: gate.error,
            reason: gate.reason,
            sessionTail: leadGate.tail(sessionId),
            leadSessionConfigured: leadGate.configured(),
          });
        }
        const text = String(args?.text ?? '').replace(/^\uFEFF/, '').trim();
        const format = args?.format === 'markdown' ? 'markdown' : 'text';
        if (!text) return JSON.stringify({ ok: false, error: 'text is required' });
        if (text.length > 4000) return JSON.stringify({ ok: false, error: `message too long: ${text.length} chars (max 4000)` });
        if (args?.dryRun === true) {
          return JSON.stringify({
            ok: true,
            dryRun: true,
            lead: true,
            endpoint: qq.deliveryEndpoint(),
            passive: args?.passive === true,
            fallback: args?.noFallback !== true,
            format,
            chars: text.length,
          });
        }
        try {
          const result = await qq.deliver(text, {
            format,
            passive: args?.passive === true,
            fallback: args?.noFallback !== true,
          });
          const { errorObject, body, ...visible } = result;
          const output = { ...visible, verified: visible.verified === true };
          if (output.ok && !output.verified) {
            output.delivery = output.delivery || 'bridge-accepted';
            output.warning = 'bridge accepted without a platform messageId; not counted as verified success';
          }
          return JSON.stringify(output);
        } catch (error) {
          return JSON.stringify({ ok: false, error: String(error?.message || error) });
        }
      },
    });

    const disposeMirror = scope.tools.register({
      name: 'team_mirror',
      description: '读取 0.2.0 最终回答镜像状态：发送成功数、失败数、跳过原因（IM 绑定/子会话/重复）、最近 messageId。只读，不触发发送。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      async execute() {
        return JSON.stringify({ ok: true, version: VERSION, configured: config.ready, config, mirror: mirror.status() }, null, 2);
      },
    });

    const disposeApproval = scope.tools.register({
      name: 'team_approval',
      description: '工单审批状态门 + 提问队列。action=request 记录用户原话摘要并生成 approvalId（pending）；action=enqueue 入队（按 batchKey+问题去重，不推送）；action=flush 形成下一批（≤3 项，返回摘要文本，不直接发 QQ）；Lead 会话可用 approve/reject/withdraw 改状态；list/get 查询。未 approved 时不得调用 team_task_create（会被 tools/pre-execute 拒绝）。不改任务板。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['request', 'enqueue', 'flush', 'list', 'get', 'approve', 'reject', 'withdraw'], description: '默认 list。' },
          summary: { type: 'string', description: 'request 必填：用户原话/需求摘要（≤300 字）。' },
          quote: { type: 'string', description: 'request 可选：用户原话摘录。' },
          source: { type: 'string', description: 'request 可选：来源（如 lead / qq）。' },
          id: { type: 'string', description: 'get/approve/reject/withdraw 必填：approvalId。' },
          question: { type: 'string', description: 'enqueue 必填：待批问题。' },
          options: { type: 'array', items: { type: 'string' }, description: 'enqueue 可选：2–4 个选项，默认 同意/驳回。' },
          batchKey: { type: 'string', description: 'enqueue 可选：批次键，同键同题去重。' },
          priority: { type: 'string', description: 'enqueue 可选：high/normal/low 或 1/2/3。' },
          maxPerBatch: { type: 'number', description: 'flush 可选：本批最多项数，默认 3，上限 3。' },
          status: { type: 'string', enum: ['pending', 'approved', 'rejected', 'withdrawn'], description: 'list 可选：按状态过滤。' },
          ttlHours: { type: 'number', description: 'request 可选：有效期小时数，默认 24。' },
        },
      },
      async execute(args, exec) {
        const action = String(args?.action || 'list');
        const sessionId = callingSessionId(exec);
        try {
          if (['approve', 'reject', 'withdraw', 'enqueue', 'flush', 'markDelivered'].includes(action)) {
            const gate = leadGate.isLead(sessionId);
            if (!gate.allowed) {
              return JSON.stringify({ ok: false, status: 403, sent: false, error: gate.error, reason: gate.reason, sessionTail: leadGate.tail(sessionId) });
            }
          }
          if (action === 'enqueue') {
            const result = approvalQueue.enqueue({
              question: args?.question,
              options: args?.options,
              batchKey: args?.batchKey,
              priority: args?.priority,
            });
            return JSON.stringify(result);
          }
          if (action === 'flush') {
            const result = approvalQueue.flush({ maxPerBatch: args?.maxPerBatch });
            return JSON.stringify({
              ...result,
              leadMessage: result.text,
              delivery: { channel: 'station', target: 'lead', count: result.pushed ? 1 : 0, broadcast: false },
              qqSent: false,
            });
          }
          if (action === 'markDelivered') {
            const result = approvalQueue.markDelivered({
              batchId: args?.batchId,
              messageId: args?.messageId,
              itemIds: args?.itemIds,
            });
            return JSON.stringify(result);
          }
          if (action === 'request') {
            const item = approvals.create({
              summary: args?.summary,
              quote: args?.quote,
              source: args?.source || 'lead',
              ttlMs: Number(args?.ttlHours) > 0 ? Number(args.ttlHours) * 3600 * 1000 : undefined,
            });
            return JSON.stringify({ ok: true, approval: item });
          }
          if (action === 'get') {
            const item = approvals.get(args?.id);
            if (!item) return JSON.stringify({ ok: false, status: 404, error: `unknown approval: ${args?.id}` });
            return JSON.stringify({ ok: true, approval: item });
          }
          if (action === 'approve') {
            const item = approvals.approve(args?.id, { by: leadGate.tail(sessionId) });
            return JSON.stringify({ ok: true, approval: item });
          }
          if (action === 'reject') {
            const item = approvals.reject(args?.id, { by: leadGate.tail(sessionId) });
            return JSON.stringify({ ok: true, approval: item });
          }
          if (action === 'withdraw') {
            const item = approvals.withdraw(args?.id, { by: leadGate.tail(sessionId) });
            return JSON.stringify({ ok: true, approval: item });
          }
          return JSON.stringify({ ok: true, counts: approvals.counts(), approvals: approvals.list({ status: args?.status }) });
        } catch (error) {
          return JSON.stringify({ ok: false, error: String(error?.message || error) });
        }
      },
    });

    return () => {
      try { disposeStatus?.(); } catch { /* ignore */ }
      try { disposeNotify?.(); } catch { /* ignore */ }
      try { disposeMirror?.(); } catch { /* ignore */ }
      try { disposeApproval?.(); } catch { /* ignore */ }
    };
  }, 'dsh-team-ops: tools'));
}
