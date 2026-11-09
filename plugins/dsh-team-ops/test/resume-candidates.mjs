/**
 * A-lite resume-candidates 测试（假 ctx）：
 *  - 连续两次扫描稳定、无重复
 *  - 输出文件字段齐全，blocked 只标 needs-human
 *  - 路由 GET 200 / 非 loopback 403，且路由不写盘
 *  - 静态检查：无 spawn / QQ / turn 调用
 */
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
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
const startupStored = JSON.parse(readFileSync(out, 'utf8'));
check('startup-file-written', existsSync(out) && startupStored.count === 2, startupStored.count);
check('startup-file-scannedAt', typeof startupStored.scannedAt === 'string' && startupStored.scannedAt.length > 0, startupStored.scannedAt);

const healthRoute = routes.get('exact:/api/team-ops/health');
const healthRes = { destroyed: false, writableEnded: false, writeHead(code, headers) { this.code = code; this.headers = headers; }, end(body) { this.body = body; this.writableEnded = true; } };
await healthRoute.handler({ method: 'GET', url: '/api/team-ops/health', socket: { remoteAddress: '127.0.0.1' } }, healthRes);
const health = JSON.parse(healthRes.body);
check('health-feature-autoscan', health.features?.includes('resume-autoscan'), health.features);
check('health-resume-scan', health.resumeScan?.written === true && health.resumeScan?.candidates === 2 && health.resumeScan?.error === null, health.resumeScan);
check('health-resume-scan-time', typeof health.resumeScan?.lastScanAt === 'string' && health.resumeScan.lastScanAt.length > 0, health.resumeScan?.lastScanAt);

const before = statSync(out).mtimeMs;
const res = { destroyed: false, writableEnded: false, writeHead(code, headers) { this.code = code; this.headers = headers; }, end(body) { this.body = body; this.writableEnded = true; } };
await route.handler({ method: 'GET', url: '/api/team-ops/resume-candidates', socket: { remoteAddress: '127.0.0.1' } }, res);
const payload = JSON.parse(res.body);
check('route-200', res.code === 200 && payload.count === 2 && payload.written === false, { code: res.code, count: payload.count });
const res2 = { destroyed: false, writableEnded: false, writeHead(code) { this.code = code; }, end(body) { this.body = body; } };
await route.handler({ method: 'GET', url: '/api/team-ops/resume-candidates', socket: { remoteAddress: '10.1.2.3' } }, res2);
check('route-403', res2.code === 403, res2.code);
check('route-no-write', statSync(out).mtimeMs === before, { before, after: statSync(out).mtimeMs });

// 启动写盘失败：只记录 error，不抛、不阻断路由
const blockedOut = join(tmp, 'out-is-dir');
mkdirSync(blockedOut);
process.env.DSH_TEAM_OPS_RESUME_OUT = blockedOut;
const routes2 = new Map();
const errors2 = [];
const origError2 = console.error;
console.error = (...args) => errors2.push(args.join(' '));
const ctx2 = {
  on() {},
  get() { return null; },
  effect(fn) { fn(); },
  webServer: { register(route) { routes2.set(`${route.kind}:${route.path}`, route); return () => {}; } },
  inject(_names, fn) { fn({ effect() {}, tools: { register(def) { return () => { void def; }; } } }); },
};
let threw = false;
try { plugin.apply(ctx2); } catch { threw = true; }
console.error = origError2;
process.env.DSH_TEAM_OPS_RESUME_OUT = out;
check('startup-failure-silent', !threw, threw);
check('startup-failure-logged', errors2.some((line) => line.includes('resume autoscan failed')), errors2);
const healthRoute2 = routes2.get('exact:/api/team-ops/health');
const healthRes2 = { destroyed: false, writableEnded: false, writeHead(code, headers) { this.code = code; this.headers = headers; }, end(body) { this.body = body; this.writableEnded = true; } };
await healthRoute2.handler({ method: 'GET', url: '/api/team-ops/health', socket: { remoteAddress: '127.0.0.1' } }, healthRes2);
const health2 = JSON.parse(healthRes2.body);
check('startup-failure-recorded', health2.resumeScan?.written === false && typeof health2.resumeScan?.error === 'string' && health2.resumeScan.error.length > 0, health2.resumeScan);

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
