/**
 * A-lite resume-candidates 测试（假 ctx）：
 *  - 连续两次扫描稳定、无重复
 *  - 输出文件字段齐全，blocked 只标 needs-human
 *  - 路由 GET 200 / 非 loopback 403，且路由不写盘
 *  - 静态检查：无 spawn / QQ / turn 调用
 */
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const tmp = mkdtempSync(join(tmpdir(), 'team-ops-resume-'));
const snapshot = join(tmp, 'team-status.json');
const out = join(tmp, 'resume-candidates.json');
writeFileSync(snapshot, JSON.stringify({
  tasks: {
    items: [
      { id: 't-1', owner: 'tools', status: 'in_progress', sessionId: 's-1', lastTurnId: 3 },
      { id: 't-2', owner: 'mechanics', status: 'blocked', blockedBy: ['t-1'] },
      { id: 't-3', owner: 'qa', status: 'done' },
    ],
  },
}), 'utf8');

process.env.DSH_TEAM_SNAPSHOT = snapshot;
process.env.DSH_TEAM_OPS_HANDOFF = join(tmp, 'missing-handoff.json');
process.env.DSH_TEAM_OPS_RESUME_OUT = out;

const resume = require('../lib/resume-candidates.cjs');
const plugin = await import('../lib/index.js');

const checks = [];
function check(name, ok, detail) { checks.push({ name, ok: !!ok, detail }); }

const first = resume.scan();
const second = resume.scan();
check('stable-count', first.count === second.count && first.count === 2, { first: first.count, second: second.count });
check('stable-candidates', JSON.stringify(first.candidates) === JSON.stringify(second.candidates), first.candidates);
check('no-duplicate', new Set(first.candidates.map((c) => `${c.sessionId}:${c.lastTurnId}:${c.taskId}`)).size === first.candidates.length, first.candidates.length);
check('done-excluded', !first.candidates.some((c) => c.taskId === 't-3'), first.candidates.map((c) => c.taskId));

const blocked = first.candidates.find((c) => c.taskId === 't-2');
check('blocked-needs-human', blocked?.recommendedAction === 'needs-human' && blocked.reason === 'blocked', blocked);
const resumed = first.candidates.find((c) => c.taskId === 't-1');
check('resume-action', resumed?.recommendedAction === 'resume-after-restart' && resumed.sessionId === 's-1' && resumed.lastTurnId === 3, resumed);
const fields = ['sessionId', 'lastTurnId', 'taskId', 'owner', 'reason', 'blockedBy', 'recommendedAction'];
check('fields-complete', first.candidates.every((c) => fields.every((f) => f in c)), fields);
check('null-session-not-guessed', blocked.sessionId === null && blocked.lastTurnId === null, blocked);

const written = resume.writeResult(first);
check('write-ok', written.ok && existsSync(out), written);
const stored = JSON.parse(readFileSync(out, 'utf8'));
check('file-count', stored.count === 2 && stored.candidates.length === 2, stored.count);
check('file-not-auto-resume', String(stored.note).includes('不是自动恢复'), stored.note);

// 假 ctx：路由只读，不写盘
let routes = new Map();
const errors = [];
const origError = console.error;
console.error = (...args) => errors.push(args.join(' '));
const ctx = {
  on() {},
  get() { return null; },
  effect(fn) { fn(); },
  webServer: { register(route) { routes.set(`${route.kind}:${route.path}`, route); return () => {}; } },
  inject(_names, fn) { fn({ effect() {}, tools: { register(def) { return () => { void def; }; } } }); },
};
plugin.apply(ctx);
console.error = origError;

const route = routes.get('exact:/api/team-ops/resume-candidates');
check('route-registered', !!route, [...routes.keys()]);
const before = statSync(out).mtimeMs;
const res = { destroyed: false, writableEnded: false, writeHead(code, headers) { this.code = code; this.headers = headers; }, end(body) { this.body = body; this.writableEnded = true; } };
await route.handler({ method: 'GET', url: '/api/team-ops/resume-candidates', socket: { remoteAddress: '127.0.0.1' } }, res);
const payload = JSON.parse(res.body);
check('route-200', res.code === 200 && payload.count === 2 && payload.written === false, { code: res.code, count: payload.count });
const res2 = { destroyed: false, writableEnded: false, writeHead(code) { this.code = code; }, end(body) { this.body = body; } };
await route.handler({ method: 'GET', url: '/api/team-ops/resume-candidates', socket: { remoteAddress: '10.1.2.3' } }, res2);
check('route-403', res2.code === 403, res2.code);
check('route-no-write', statSync(out).mtimeMs === before, { before, after: statSync(out).mtimeMs });

// 静态：无进程/QQ/turn 调用（扫描本模块与路由片段）
const libSource = readFileSync(join(import.meta.dirname, '..', 'lib', 'resume-candidates.cjs'), 'utf8');
const indexSource = readFileSync(join(import.meta.dirname, '..', 'lib', 'index.js'), 'utf8');
const routeBlock = indexSource.slice(indexSource.indexOf("path: `${PREFIX}/resume-candidates`"), indexSource.indexOf("path: `${PREFIX}/command`"));
check('no-spawn', !/child_process|\bspawn\(|execFile\b/.test(libSource), 'lib spawn');
check('no-qq', !/qq_notify|sendSdkRequired|sendHttp\b/.test(libSource), 'lib qq');
check('no-turn', !/turn\/(start|end)/.test(libSource), 'lib turn');
check('route-readonly', routeBlock.length > 0 && !/writeResult|spawn|sendHttp|qq_notify/.test(routeBlock), routeBlock.length);

const failed = checks.filter((c) => !c.ok);
console.log(JSON.stringify({ ok: failed.length === 0, checks: checks.length, failed: failed.map((c) => c.name), tmp }));
if (failed.length) console.log(JSON.stringify(failed, null, 2));
process.exit(failed.length ? 1 : 0);
