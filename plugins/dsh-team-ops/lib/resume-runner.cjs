#!/usr/bin/env node
'use strict';

/**
 * A2：重启后「受控续跑」执行器（不是 mid-tool 恢复）。
 *
 * 安全默认：
 *   - enabled=false：只扫描，不动作；
 *   - dryRun=true：只写「将续跑」审计，不 spawn；
 *   - allowlist 必填且为空时不跑；
 *   - 全局并发固定 1；每 session 一把带 pid+ts+TTL 的 resume.lock；
 *   - 幂等键 sessionId + lastTurnId，同一轮只续一次；失败不重试。
 *
 * 配置 ~/.dsh/team-resume.json（全部可选，缺省即安全档）：
 * {
 *   "enabled": false,
 *   "allowlist": ["<session-id>"],
 *   "dryRun": true,
 *   "timeoutMs": 120000,
 *   "lockTtlMs": 1800000,
 *   "cwd": "C:\\path\\to\\same\\cwd",
 *   "agentPreset": "standard",
 *   "command": "dsh"
 * }
 *
 * 续跑命令固定为：dsh --profile headless --session-id <id> --json，cwd 取会话 header。
 * 不发 QQ、不安装、不重启；启动扫描失败只记录，不阻断宿主。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');

const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_LOCK_TTL_MS = 30 * 60 * 1000;
const MAX_TIMEOUT_MS = 60 * 60 * 1000;

const DEFAULTS = Object.freeze({
  enabled: false,
  allowlist: [],
  dryRun: true,
  timeoutMs: DEFAULT_TIMEOUT_MS,
  lockTtlMs: DEFAULT_LOCK_TTL_MS,
  command: 'dsh',
  agentPreset: 'standard',
});

function configPath() {
  const override = String(process.env.DSH_TEAM_RESUME_CONFIG || '').trim();
  return override ? path.resolve(override) : path.join(os.homedir(), '.dsh', 'team-resume.json');
}

function statePath() {
  const override = String(process.env.DSH_TEAM_RESUME_STATE || '').trim();
  return override ? path.resolve(override) : path.join(os.homedir(), '.dsh', 'team-resume-state.json');
}

function auditPath() {
  const override = String(process.env.DSH_TEAM_RESUME_AUDIT || '').trim();
  return override ? path.resolve(override) : path.join(os.homedir(), '.dsh', 'team-resume-audit.jsonl');
}

function locksDir() {
  const override = String(process.env.DSH_TEAM_RESUME_LOCKS || '').trim();
  return override ? path.resolve(override) : path.join(os.homedir(), '.dsh', 'team-resume-locks');
}

function defaultSessionsRoot() {
  const override = String(process.env.DSH_TEAM_SESSIONS_DIR || '').trim();
  return override ? path.resolve(override) : path.join(os.homedir(), '.dsh', 'sessions');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

function loadConfig(file = configPath()) {
  const raw = readJson(file);
  const config = {
    ...DEFAULTS,
    cwd: process.cwd(),
    found: raw !== null,
    path: file,
  };
  if (raw && typeof raw === 'object') {
    if (raw.enabled === true) config.enabled = true;
    if (raw.dryRun === false) config.dryRun = false;
    if (Array.isArray(raw.allowlist)) {
      config.allowlist = [...new Set(raw.allowlist.map((id) => String(id || '').trim()).filter(Boolean))];
    }
    if (Number.isFinite(raw.timeoutMs) && raw.timeoutMs > 0) {
      config.timeoutMs = Math.min(Math.floor(raw.timeoutMs), MAX_TIMEOUT_MS);
    }
    if (Number.isFinite(raw.lockTtlMs) && raw.lockTtlMs > 0) {
      config.lockTtlMs = Math.min(Math.floor(raw.lockTtlMs), 24 * 60 * 60 * 1000);
    }
    if (typeof raw.command === 'string' && raw.command.trim()) config.command = raw.command.trim();
    if (typeof raw.cwd === 'string' && raw.cwd.trim()) config.cwd = path.resolve(raw.cwd.trim());
    if (typeof raw.agentPreset === 'string' && raw.agentPreset.trim()) config.agentPreset = raw.agentPreset.trim();
  }
  // 并发只允许 1：即使配置写了更大值也无效。
  config.concurrency = 1;
  return config;
}

function normalizeId(id) {
  return String(id || '').trim().replace(/^session-/, '');
}

function normalizeCwd(cwd) {
  const resolved = path.resolve(String(cwd || ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function listSessionFiles(root) {
  const files = [];
  const walk = (dir, depth) => {
    if (depth > 5) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (/^session\.v4\.jsonl(\.zstd)?$/.test(entry.name)) {
        files.push(full);
      }
    }
  };
  walk(root, 0);
  return files;
}

function readSessionText(file) {
  const buffer = fs.readFileSync(file);
  if (file.endsWith('.zstd')) {
    if (typeof zlib.zstdDecompressSync !== 'function') {
      throw new Error('zstd decompression is not available in this Node.js');
    }
    return zlib.zstdDecompressSync(buffer).toString('utf8');
  }
  return buffer.toString('utf8');
}

function readSessionFile(file) {
  const text = readSessionText(file);
  const events = [];
  let header = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      // 崩溃/截断的尾行是预期情况：忽略坏行，保留已解析事件。
      continue;
    }
    if (!header && event.type === 'session') {
      header = event;
      continue;
    }
    if (header) events.push(event);
  }
  return { header, events, file };
}

function indexSessions(root) {
  const index = new Map();
  for (const file of listSessionFiles(root)) {
    let parsed;
    try {
      parsed = readSessionFile(file);
    } catch {
      continue;
    }
    const id = parsed.header?.id;
    if (!id) continue;
    const alias = normalizeId(id);
    const existing = index.get(alias);
    if (!existing) {
      index.set(alias, { ...parsed, id, file });
      continue;
    }
    // 同一会话多份快照时取最新 mtime 的一份。
    try {
      if (fs.statSync(file).mtimeMs > fs.statSync(existing.file).mtimeMs) {
        index.set(alias, { ...parsed, id, file });
      }
    } catch { /* 保留先读到的 */ }
  }
  return index;
}

function lastTurnInfo(events) {
  let lastStartIndex = -1;
  let lastTurn = null;
  for (let i = 0; i < events.length; i += 1) {
    if (events[i].type === 'turn/start') {
      lastStartIndex = i;
      lastTurn = events[i].data?.turn ?? events[i].data?.id ?? null;
    }
  }
  if (lastStartIndex < 0) return { lastStartIndex, lastTurn, ended: false, pendingTools: [] };

  let ended = false;
  const pending = new Map();
  for (let i = lastStartIndex; i < events.length; i += 1) {
    const event = events[i];
    if (event.type === 'turn/end') {
      ended = true;
      continue;
    }
    if (event.type === 'tool/call') {
      const callId = event.data?.callId || event.data?.id;
      if (callId) pending.set(String(callId), true);
      continue;
    }
    if (event.type === 'tool/result') {
      const callId = event.data?.toolCallId
        || event.data?.callId
        || event.data?.message?.source?.callId
        || event.data?.message?.toolCallId;
      if (callId) pending.delete(String(callId));
    }
  }
  return { lastStartIndex, lastTurn, ended, pendingTools: [...pending.keys()] };
}

function evaluateSession(parsed, options) {
  const header = parsed.header || {};
  const sessionId = String(header.id || '');
  const skip = (reason, extra = {}) => ({ ok: false, sessionId, reason, ...extra });

  // 会话 id 会进入 spawn 参数（Windows 下 shell=true），只接受安全字符。
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(sessionId)) return skip('invalid-session-id');
  if (!options.allowlist.has(normalizeId(sessionId))) return skip('not-in-allowlist');
  if (header.parentSession) return skip('child-session');
  if (String(header.origin || 'user') !== 'user') return skip('origin-not-user');
  if (normalizeCwd(header.cwd) !== normalizeCwd(options.expectedCwd)) return skip('cwd-mismatch');
  if (String(header.agentPreset || '') !== String(options.expectedPreset || '')) return skip('preset-mismatch');

  const turn = lastTurnInfo(parsed.events || []);
  if (turn.lastStartIndex < 0 || turn.lastTurn == null) return skip('no-turn');
  if (turn.ended) return skip('turn-ended');
  if (turn.pendingTools.length) return skip('tool-in-flight', { pendingTools: turn.pendingTools });

  return {
    ok: true,
    sessionId,
    lastTurnId: turn.lastTurn,
    cwd: header.cwd,
    agentPreset: header.agentPreset || null,
    origin: header.origin || 'user',
    file: parsed.file,
  };
}

function selectCandidates(options) {
  const index = options.index || indexSessions(options.sessionsRoot);
  const allowlist = new Set(options.allowlist);
  const selected = [];
  const skipped = [];
  for (const rawId of options.allowlist) {
    const parsed = index.get(normalizeId(rawId));
    if (!parsed) {
      skipped.push({ sessionId: rawId, reason: 'session-not-found' });
      continue;
    }
    const verdict = evaluateSession(parsed, {
      allowlist,
      expectedCwd: options.expectedCwd,
      expectedPreset: options.expectedPreset,
    });
    if (verdict.ok) selected.push(verdict);
    else skipped.push(verdict);
  }
  return { selected, skipped };
}

function readState(file) {
  const raw = readJson(file);
  if (!raw || typeof raw !== 'object') {
    return { version: 1, updatedAt: null, sessions: {} };
  }
  return {
    version: 1,
    updatedAt: raw.updatedAt || null,
    sessions: raw.sessions && typeof raw.sessions === 'object' ? raw.sessions : {},
  };
}

function appendAudit(file, entry) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
    fs.appendFileSync(file, `${line}\n`, 'utf8');
  } catch {
    // 审计失败不影响主流程，也不能掩盖真实结果。
  }
}

function lockFileFor(dir, sessionId) {
  const safe = String(sessionId).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
  // 每 session 一个独立目录，里面固定叫 resume.lock，便于识别与人工清理。
  return path.join(dir, safe, 'resume.lock');
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM 说明进程存在但当前用户无权发信号，不能当成死锁。
    return error?.code === 'EPERM';
  }
}

function acquireLock(file, options = {}) {
  const ttlMs = Number(options.ttlMs) || DEFAULT_LOCK_TTL_MS;
  const now = options.now instanceof Date ? options.now : new Date();
  const payload = JSON.stringify({ pid: process.pid, ts: now.toISOString() });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tryOnce = () => fs.writeFileSync(file, payload, { encoding: 'utf8', flag: 'wx' });
  try {
    tryOnce();
    return { ok: true, file };
  } catch (error) {
    if (error?.code !== 'EEXIST') return { ok: false, file, reason: String(error?.message || error) };
  }
  let held = null;
  try {
    held = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    held = null;
  }
  const ageMs = held?.ts ? now.getTime() - Date.parse(held.ts) : Number.POSITIVE_INFINITY;
  const stale = !held || !Number.isFinite(ageMs) || ageMs > ttlMs || !pidAlive(Number(held.pid));
  if (!stale) return { ok: false, file, reason: 'lock-busy', holder: held };
  try {
    fs.unlinkSync(file);
    tryOnce();
    return { ok: true, file, stale: true };
  } catch (error) {
    return { ok: false, file, reason: String(error?.message || error) };
  }
}

function releaseLock(file) {
  try {
    fs.unlinkSync(file);
  } catch {
    // 已经被清理或从未创建：忽略。
  }
}

function spawnResume(options) {
  const spawnFn = options.spawnFn || ((command, args, spawnOptions, callback) => {
    const child = spawn(command, args, {
      ...spawnOptions,
      shell: process.platform === 'win32',
      windowsHide: true,
    });
    child.on('exit', (code, signal) => callback(code, signal, null));
    child.on('error', (error) => callback(null, null, error));
    return child;
  });
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    let child = null;
    try {
      child = spawnFn(options.command, options.args, options.spawnOptions, (code, signal, error) => {
        finish({ code, signal, error: error || null });
      });
    } catch (error) {
      finish({ code: null, signal: null, error });
      return;
    }
    timer = setTimeout(() => {
      try {
        child?.kill?.('SIGKILL');
      } catch { /* ignore */ }
      finish({ code: null, signal: null, error: new Error(`timeout after ${options.timeoutMs}ms`), timedOut: true });
    }, options.timeoutMs);
    // 不用 unref：超时计时器必须保证 runner 在子进程挂死时也能醒来并 kill。
  });
}

function defaultHealth() {
  return {
    enabled: false,
    dryRun: true,
    allowlistCount: 0,
    lastRunAt: null,
    lastResult: null,
    skipped: [],
  };
}

async function execute(options = {}) {
  const config = options.config || loadConfig(options.configPath);
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const startedAt = now().toISOString();
  const stateFile = options.statePath || statePath();
  const auditFile = options.auditFile || auditPath();
  const sessionsRoot = options.sessionsRoot || defaultSessionsRoot();
  const expectedCwd = config.cwd || process.cwd();
  const expectedPreset = config.agentPreset || DEFAULTS.agentPreset;
  const skipped = [];
  const base = {
    ok: true,
    enabled: config.enabled,
    dryRun: config.dryRun,
    allowlistCount: config.allowlist.length,
    concurrency: 1,
    lastRunAt: startedAt,
    lastResult: null,
    skipped,
    candidates: 0,
    spawned: 0,
    scanCandidates: Number(options.scanResult?.count || 0),
  };

  if (!config.enabled) {
    skipped.push({ sessionId: null, reason: 'disabled' });
    return base;
  }
  if (!config.allowlist.length) {
    skipped.push({ sessionId: null, reason: 'allowlist-empty' });
    return base;
  }

  let picked;
  try {
    picked = selectCandidates({
      allowlist: config.allowlist,
      expectedCwd,
      expectedPreset,
      sessionsRoot,
      index: options.sessionIndex,
    });
  } catch (error) {
    skipped.push({ sessionId: null, reason: `scan-failed: ${String(error?.message || error)}` });
    return base;
  }
  skipped.push(...picked.skipped);
  base.candidates = picked.selected.length;

  let state;
  try {
    state = readState(stateFile);
  } catch {
    state = { version: 1, updatedAt: null, sessions: {} };
  }

  for (const candidate of picked.selected) {
    const previous = state.sessions[candidate.sessionId];
    if (previous && String(previous.lastTurnId) === String(candidate.lastTurnId)) {
      if (previous.status === 'resumed') {
        skipped.push({ sessionId: candidate.sessionId, reason: 'already-resumed' });
        continue;
      }
      if (previous.status === 'failed') {
        skipped.push({ sessionId: candidate.sessionId, reason: 'previous-failed-no-retry' });
        continue;
      }
    }

    const lock = acquireLock(lockFileFor(options.locksDir || locksDir(), candidate.sessionId), {
      ttlMs: config.lockTtlMs,
      now: now(),
    });
    if (!lock.ok) {
      skipped.push({ sessionId: candidate.sessionId, reason: 'lock-busy' });
      continue;
    }

    try {
      if (config.dryRun) {
        const result = {
          sessionId: candidate.sessionId,
          lastTurnId: candidate.lastTurnId,
          ok: true,
          dryRun: true,
          at: now().toISOString(),
        };
        state.sessions[candidate.sessionId] = {
          lastTurnId: candidate.lastTurnId,
          status: 'planned',
          at: result.at,
        };
        appendAudit(auditFile, {
          action: 'dry-run',
          sessionId: candidate.sessionId,
          lastTurnId: candidate.lastTurnId,
          cwd: candidate.cwd,
          agentPreset: candidate.agentPreset,
          reason: 'would-resume',
        });
        base.lastResult = result;
        continue;
      }

      const args = ['--profile', 'headless', '--session-id', candidate.sessionId, '--json'];
      const outcome = await spawnResume({
        command: config.command,
        args,
        spawnOptions: { cwd: candidate.cwd, stdio: 'ignore' },
        timeoutMs: config.timeoutMs,
        spawnFn: options.spawnFn,
      });
      base.spawned += 1;
      const ok = !outcome.error && outcome.code === 0;
      const reason = ok
        ? 'resumed'
        : (outcome.error ? String(outcome.error.message || outcome.error) : `exit ${outcome.code}`);
      const at = now().toISOString();
      state.sessions[candidate.sessionId] = {
        lastTurnId: candidate.lastTurnId,
        status: ok ? 'resumed' : 'failed',
        at,
        exitCode: outcome.code,
        reason: ok ? null : reason,
      };
      base.lastResult = {
        sessionId: candidate.sessionId,
        lastTurnId: candidate.lastTurnId,
        ok,
        dryRun: false,
        at,
        exitCode: outcome.code,
        reason: ok ? 'resumed' : reason,
      };
      appendAudit(auditFile, {
        action: ok ? 'resume' : 'failed',
        sessionId: candidate.sessionId,
        lastTurnId: candidate.lastTurnId,
        cwd: candidate.cwd,
        agentPreset: candidate.agentPreset,
        reason: ok ? 'resumed' : reason,
        exitCode: outcome.code,
      });
    } catch (error) {
      skipped.push({ sessionId: candidate.sessionId, reason: `runner-error: ${String(error?.message || error)}` });
    } finally {
      releaseLock(lock.file);
      try {
        state.updatedAt = now().toISOString();
        atomicWriteJson(stateFile, state);
      } catch {
        // 状态写失败不回滚已发生的续跑；下次启动会重新评估。
      }
    }
  }

  return base;
}

function createRunner(options = {}) {
  const config = options.config || loadConfig(options.configPath);
  let health = {
    ...defaultHealth(),
    enabled: config.enabled === true,
    dryRun: config.dryRun !== false,
    allowlistCount: config.allowlist.length,
  };
  return {
    health() {
      return { ...health, skipped: [...health.skipped] };
    },
    async run(extra = {}) {
      const result = await execute({ ...options, ...extra, config: extra.config || options.config || config });
      health = {
        enabled: result.enabled,
        dryRun: result.dryRun,
        allowlistCount: result.allowlistCount,
        lastRunAt: result.lastRunAt,
        lastResult: result.lastResult,
        skipped: result.skipped || [],
      };
      return result;
    },
  };
}

module.exports = {
  DEFAULTS,
  configPath,
  statePath,
  auditPath,
  locksDir,
  defaultSessionsRoot,
  loadConfig,
  readState,
  listSessionFiles,
  readSessionFile,
  indexSessions,
  lastTurnInfo,
  evaluateSession,
  selectCandidates,
  acquireLock,
  releaseLock,
  spawnResume,
  defaultHealth,
  execute,
  createRunner,
};
