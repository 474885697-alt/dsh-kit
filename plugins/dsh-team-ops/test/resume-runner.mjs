/**
 * A2 resume-runner 测试（假 spawn，不真跑 dsh）：
 *  - 默认关 / 空 allowlist 不动作
 *  - dryRun 只审计不 spawn
 *  - 过滤：非 user、子会话、cwd/preset 不一致、turn/end、在途 tool
 *  - 真跑：参数/cwd 正确、幂等（同 lastTurnId 只一次）、失败不重试
 *  - lock busy / 过期锁、timeout kill、并发固定 1
 *  - zstd 会话文件、health 字段与 index.js 接线
 */
import { createRequire } from 'node:module';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';

const require = createRequire(import.meta.url);
const tmp = mkdtempSync(join(tmpdir(), 'team-ops-runner-'));
const TEST_CWD = join(tmp, 'worktree');
const NOW = () => new Date('2026-11-09T12:00:00.000Z');

const runner = require('../lib/resume-runner.cjs');

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail });
  return !!ok;
}

function header(id, overrides = {}) {
  return {
    type: 'session',
    version: 4,
    id,
    createdAt: 1794000000000,
    cwd: TEST_CWD,
    isSeeded: false,
    delegationDepth: 0,
    agentPreset: 'standard',
    ...overrides,
  };
}

function normalEvents(turn = 1) {
  return [
    { type: 'turn/start', seq: 1, data: { turn } },
    { type: 'step/start', seq: 2, data: { turn, step: 1 } },
    { type: 'assistant/message', seq: 3, data: { turn, step: 1, message: { role: 'assistant', content: [] } } },
    { type: 'step/end', seq: 4, data: { turn, step: 1 } },
  ];
}

function scenario(name) {
  const dir = join(tmp, name);
  const sessions = join(dir, 'sessions');
  mkdirSync(sessions, { recursive: true });
  return {
    dir,
    sessionsRoot: sessions,
    statePath: join(dir, 'state.json'),
    auditFile: join(dir, 'audit.jsonl'),
    locksDir: join(dir, 'locks'),
  };
}

function writeSession(sc, id, options = {}) {
  const dir = join(sc.sessionsRoot, 'hash-dir', id);
  mkdirSync(dir, { recursive: true });
  const events = options.events || normalEvents(options.turn || 1);
  const lines = [header(id, options.header), ...events].map((event) => JSON.stringify(event));
  const file = join(dir, options.zstd ? 'session.v4.jsonl.zstd' : 'session.v4.jsonl');
  const text = `${lines.join('\n')}\n`;
  writeFileSync(file, options.zstd ? zstdCompressSync(Buffer.from(text, 'utf8')) : text);
  return file;
}

function pathsOf(sc) {
  return {
    sessionsRoot: sc.sessionsRoot,
    statePath: sc.statePath,
    auditFile: sc.auditFile,
    locksDir: sc.locksDir,
  };
}

function baseConfig(overrides = {}) {
  return {
    enabled: true,
    dryRun: true,
    allowlist: [],
    timeoutMs: 500,
    lockTtlMs: 60000,
    concurrency: 1,
    cwd: TEST_CWD,
    agentPreset: 'standard',
    command: 'dsh',
    ...overrides,
  };
}

function fakeSpawn(options = {}) {
  const calls = [];
  const kills = [];
  const fn = (command, args, spawnOptions, callback) => {
    calls.push({ command, args, spawnOptions });
    const child = { kill: (signal) => kills.push({ signal }) };
    if (options.hang) return child;
    const code = options.code ?? 0;
    const error = options.error || null;
    setImmediate(() => callback(code, null, error));
    return child;
  };
  return { fn, calls, kills };
}

async function run(sc, config, spawn, extra = {}) {
  return runner.execute({
    config,
    ...pathsOf(sc),
    spawnFn: spawn.fn,
    now: NOW,
    ...extra,
  });
}

function auditLines(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function stateOf(sc) {
  return JSON.parse(readFileSync(sc.statePath, 'utf8'));
}

// 1) 默认配置：关、dryRun、allowlist 空、并发 1
const missingConfig = join(tmp, 'no-config.json');
const defaults = runner.loadConfig(missingConfig);
check('default-disabled', defaults.enabled === false && defaults.dryRun === true, defaults);
check('default-allowlist-empty', Array.isArray(defaults.allowlist) && defaults.allowlist.length === 0, defaults.allowlist);
check('default-concurrency-1', defaults.concurrency === 1, defaults.concurrency);
check('default-not-found', defaults.found === false, defaults.found);

const scDefault = scenario('default');
const defaultSpawn = fakeSpawn();
const defaultResult = await run(scDefault, defaults, defaultSpawn);
check('default-no-spawn', defaultSpawn.calls.length === 0, defaultSpawn.calls.length);
check('default-skip-disabled', (defaultResult.skipped || []).some((s) => s.reason === 'disabled'), defaultResult.skipped);
check('default-health-shape', ['enabled', 'dryRun', 'allowlistCount', 'lastRunAt', 'lastResult', 'skipped']
  .every((key) => key in runner.defaultHealth()), runner.defaultHealth());

// 2) enabled=true 但 allowlist 空
const scEmpty = scenario('empty');
const emptySpawn = fakeSpawn();
const emptyResult = await run(scEmpty, baseConfig(), emptySpawn);
check('empty-allowlist-no-spawn', emptySpawn.calls.length === 0, emptySpawn.calls.length);
check('empty-allowlist-skip', emptyResult.skipped.some((s) => s.reason === 'allowlist-empty'), emptyResult.skipped);

// 3) 过滤：每种拒绝理由
const scFilter = scenario('filter');
writeSession(scFilter, 's-ok', { events: normalEvents(7) });
writeSession(scFilter, 's-not-user', { header: { origin: 'scheduled' } });
writeSession(scFilter, 's-child', { header: { origin: 'subagent', parentSession: 'session-parent' } });
writeSession(scFilter, 's-cwd', { header: { cwd: join(tmp, 'other-cwd') } });
writeSession(scFilter, 's-preset', { header: { agentPreset: 'other' } });
writeSession(scFilter, 's-ended', {
  events: [...normalEvents(3), { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } }],
});
writeSession(scFilter, 's-tool', {
  events: [
    { type: 'turn/start', data: { turn: 5 } },
    { type: 'tool/call', data: { turn: 5, step: 1, callId: 'call-x', name: 'bash' } },
  ],
});
const filterSpawn = fakeSpawn();
const filterConfig = baseConfig({
  allowlist: ['s-ok', 's-not-user', 's-child', 's-cwd', 's-preset', 's-ended', 's-tool', 's-missing'],
});
const filterResult = await run(scFilter, filterConfig, filterSpawn);
const reasons = Object.fromEntries((filterResult.skipped || []).map((s) => [s.sessionId, s.reason]));
check('filter-not-user', reasons['s-not-user'] === 'origin-not-user', reasons);
check('filter-child', reasons['s-child'] === 'child-session', reasons);
check('filter-cwd', reasons['s-cwd'] === 'cwd-mismatch', reasons);
check('filter-preset', reasons['s-preset'] === 'preset-mismatch', reasons);
check('filter-ended', reasons['s-ended'] === 'turn-ended', reasons);
check('filter-tool-in-flight', reasons['s-tool'] === 'tool-in-flight', reasons);
check('filter-not-found', reasons['s-missing'] === 'session-not-found', reasons);
check('filter-only-ok-selected', filterResult.candidates === 1, filterResult.candidates);
check('filter-dryrun-no-spawn', filterSpawn.calls.length === 0, filterSpawn.calls.length);
check('filter-dryrun-result', filterResult.lastResult?.sessionId === 's-ok' && filterResult.lastResult?.dryRun === true, filterResult.lastResult);
check('filter-dryrun-audit', auditLines(scFilter.auditFile).some((line) => line.action === 'dry-run' && line.sessionId === 's-ok'), auditLines(scFilter.auditFile));
check('filter-dryrun-state-planned', stateOf(scFilter).sessions['s-ok'].status === 'planned', stateOf(scFilter));

// 4) 真跑：参数、cwd、幂等
const scReal = scenario('real');
writeSession(scReal, 's-real', { events: normalEvents(4) });
const realSpawn = fakeSpawn({ code: 0 });
const realConfig = baseConfig({ dryRun: false, allowlist: ['s-real'] });
const realResult = await run(scReal, realConfig, realSpawn);
check('real-spawn-once', realSpawn.calls.length === 1, realSpawn.calls.length);
const call = realSpawn.calls[0] || {};
check('real-command', call.command === 'dsh', call.command);
check('real-args', JSON.stringify(call.args) === JSON.stringify(['--profile', 'headless', '--session-id', 's-real', '--json']), call.args);
check('real-cwd', call.spawnOptions?.cwd === TEST_CWD, call.spawnOptions);
check('real-result', realResult.lastResult?.ok === true && realResult.lastResult?.dryRun === false, realResult.lastResult);
check('real-state', stateOf(scReal).sessions['s-real'].status === 'resumed', stateOf(scReal));
check('real-audit', auditLines(scReal.auditFile).some((line) => line.action === 'resume' && line.sessionId === 's-real'), auditLines(scReal.auditFile));

const secondSpawn = fakeSpawn({ code: 0 });
const secondResult = await run(scReal, realConfig, secondSpawn);
check('idempotent-no-spawn', secondSpawn.calls.length === 0, secondSpawn.calls.length);
check('idempotent-skip', (secondResult.skipped || []).some((s) => s.reason === 'already-resumed'), secondResult.skipped);

// 5) 失败不重试
const scFail = scenario('fail');
writeSession(scFail, 's-fail', { events: normalEvents(2) });
const failSpawn = fakeSpawn({ code: 1 });
const failConfig = baseConfig({ dryRun: false, allowlist: ['s-fail'] });
const failResult = await run(scFail, failConfig, failSpawn);
check('fail-result', failResult.lastResult?.ok === false && failResult.lastResult?.exitCode === 1, failResult.lastResult);
check('fail-state', stateOf(scFail).sessions['s-fail'].status === 'failed', stateOf(scFail));
const failRetrySpawn = fakeSpawn({ code: 0 });
const failRetry = await run(scFail, failConfig, failRetrySpawn);
check('fail-no-retry', failRetrySpawn.calls.length === 0 && (failRetry.skipped || []).some((s) => s.reason === 'previous-failed-no-retry'), failRetry.skipped);

// 6) lock：活锁跳过，过期锁可接管
const scLock = scenario('lock');
writeSession(scLock, 's-lock', { events: normalEvents(9) });
const lockConfig = baseConfig({ dryRun: false, allowlist: ['s-lock'] });
mkdirSync(scLock.locksDir, { recursive: true });
const lockPath = join(scLock.locksDir, 's-lock', 'resume.lock');
mkdirSync(join(scLock.locksDir, 's-lock'), { recursive: true });
writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: NOW().toISOString() }));
const lockSpawn = fakeSpawn({ code: 0 });
const lockResult = await run(scLock, lockConfig, lockSpawn);
check('lock-busy-skip', lockSpawn.calls.length === 0 && (lockResult.skipped || []).some((s) => s.reason === 'lock-busy'), lockResult.skipped);
rmSync(lockPath, { force: true });
writeFileSync(lockPath, JSON.stringify({ pid: 999999, ts: '2020-01-01T00:00:00.000Z' }));
const staleSpawn = fakeSpawn({ code: 0 });
const staleResult = await run(scLock, lockConfig, staleSpawn);
check('lock-stale-taken', staleSpawn.calls.length === 1 && staleResult.lastResult?.ok === true, staleResult.lastResult);

// 7) timeout：kill 且只失败一次
const scTimeout = scenario('timeout');
writeSession(scTimeout, 's-timeout', { events: normalEvents(1) });
const timeoutSpawn = fakeSpawn({ hang: true });
const timeoutConfig = baseConfig({ dryRun: false, allowlist: ['s-timeout'], timeoutMs: 20 });
const timeoutResult = await run(scTimeout, timeoutConfig, timeoutSpawn);
check('timeout-failed', timeoutResult.lastResult?.ok === false && String(timeoutResult.lastResult?.reason).includes('timeout'), timeoutResult.lastResult);
check('timeout-killed', timeoutSpawn.kills.length === 1, timeoutSpawn.kills);
check('timeout-no-retry', stateOf(scTimeout).sessions['s-timeout'].status === 'failed', stateOf(scTimeout));

// 8) zstd 会话文件
const scZstd = scenario('zstd');
writeSession(scZstd, 's-zstd', { zstd: true, events: normalEvents(2) });
const zstdSpawn = fakeSpawn({ code: 0 });
const zstdResult = await run(scZstd, baseConfig({ dryRun: false, allowlist: ['s-zstd'] }), zstdSpawn);
check('zstd-spawn', zstdSpawn.calls.length === 1 && zstdResult.lastResult?.ok === true, zstdResult.lastResult);

// 9) health / createRunner 更新
const healthRunner = runner.createRunner({ config: baseConfig({ allowlist: ['s-ok'] }) });
const initialHealth = healthRunner.health();
check('health-initial', initialHealth.enabled === true && initialHealth.dryRun === true && initialHealth.allowlistCount === 1, initialHealth);
check('health-keys', ['enabled', 'dryRun', 'allowlistCount', 'lastRunAt', 'lastResult', 'skipped'].every((key) => key in initialHealth), initialHealth);
const healthSpawn = fakeSpawn();
const healthRun = await healthRunner.run({ ...pathsOf(scFilter), spawnFn: healthSpawn.fn, now: NOW });
const afterHealth = healthRunner.health();
check('health-after-run', afterHealth.lastRunAt === healthRun.lastRunAt && afterHealth.lastResult?.sessionId === 's-ok', afterHealth);
check('health-no-concurrency-field', !('concurrency' in afterHealth), Object.keys(afterHealth));

// 10) index.js 接线：health.resumeRunner 默认安全档 + 横幅
process.env.DSH_TEAM_SNAPSHOT = join(tmp, 'team-status.json');
process.env.DSH_TEAM_OPS_HANDOFF = join(tmp, 'missing-handoff.json');
process.env.DSH_TEAM_OPS_RESUME_OUT = join(tmp, 'resume-candidates.json');
process.env.DSH_TEAM_RESUME_CONFIG = missingConfig;
process.env.DSH_TEAM_RESUME_STATE = join(tmp, 'index-state.json');
process.env.DSH_TEAM_RESUME_AUDIT = join(tmp, 'index-audit.jsonl');
process.env.DSH_TEAM_RESUME_LOCKS = join(tmp, 'index-locks');
writeFileSync(process.env.DSH_TEAM_SNAPSHOT, JSON.stringify({ tasks: { items: [] } }));

const plugin = await import('../lib/index.js');
const routes = new Map();
const logs = [];
const errors = [];
const origLog = console.log;
const origError = console.error;
console.log = (...args) => logs.push(args.join(' '));
console.error = (...args) => errors.push(args.join(' '));
const ctx = {
  on() {},
  get() { return null; },
  effect(fn) { fn(); },
  webServer: { register(route) { routes.set(`${route.kind}:${route.path}`, route); return () => {}; } },
  inject(_names, fn) { fn({ effect() {}, tools: { register() { return () => {}; } } }); },
};
let threw = false;
try { plugin.apply(ctx); } catch { threw = true; }
await new Promise((resolve) => setTimeout(resolve, 30));
console.log = origLog;
console.error = origError;
check('index-apply-no-throw', !threw, threw);
check('index-banner', logs.some((line) => line.includes('resume-runner：enabled=false')), logs);
const healthRoute = routes.get('exact:/api/team-ops/health');
const healthRes = { destroyed: false, writableEnded: false, writeHead(code, headers) { this.code = code; this.headers = headers; }, end(body) { this.body = body; } };
await healthRoute.handler({ method: 'GET', url: '/api/team-ops/health', socket: { remoteAddress: '127.0.0.1' } }, healthRes);
const health = JSON.parse(healthRes.body);
check('health-has-resume-runner', !!health.resumeRunner, health.resumeRunner);
check('health-runner-defaults', health.resumeRunner?.enabled === false && health.resumeRunner?.dryRun === true && health.resumeRunner?.allowlistCount === 0, health.resumeRunner);
check('health-runner-skipped-disabled', (health.resumeRunner?.skipped || []).some((s) => s.reason === 'disabled'), health.resumeRunner?.skipped);

// 静态：不安装/不重启/不发 QQ/不 merge
const libSource = readFileSync(join(import.meta.dirname, '..', 'lib', 'resume-runner.cjs'), 'utf8');
for (const pattern of [/sendHttp\b/, /qq_notify/, /sendSdkRequired/, /git\s+merge/, /npm\s+install/]) {
  check(`static-${pattern.source}`, !pattern.test(libSource), pattern.source);
}

const failed = checks.filter((c) => !c.ok);
console.log(JSON.stringify({ ok: failed.length === 0, checks: checks.length, failed: failed.map((c) => c.name), tmp }));
if (failed.length) console.log(JSON.stringify(failed, null, 2));
process.exit(failed.length ? 1 : 0);
