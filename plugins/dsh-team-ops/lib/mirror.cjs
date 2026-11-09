#!/usr/bin/env node
'use strict';

/**
 * dsh-team-ops / 0.2.0 最终回答镜像（自包含）。
 *
 * 监听宿主 `session/event`：
 *   - assistant/message：按 session 缓冲本回合最后的助手文本（只用 text 块，忽略 reasoning）
 *   - turn/end：reason=completed 且有文本时，经 QQ SDK 直发 owner（必须拿到 messageId）
 *
 * 防回环：
 *   1. 宿主 header.origin=subagent / parentSession 的子会话默认不镜像（可用 allowlist 覆盖）
 *   2. 已绑定到 IM 对话的会话跳过（dsh-im 的 sessionSync 会负责回发）
 *
 * 去重：sessionId + turn 成功发送后写内存与状态文件，重复事件不再发。
 * 不依赖仓库内其他脚本；不访问网络（发送函数由调用方注入，默认 qq.sendSdkRequired）。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const qq = require('./qq.cjs');
const leadGate = require('./lead-gate.cjs');
const report = require('./report.cjs');

const MAX_TEXT = 4000;
const CHUNK = 1800;

function extractText(content) {
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
      parts.push(block.text.trim());
    }
  }
  return parts.join('\n').trim();
}

function chunkText(text) {
  if (text.length <= CHUNK) return [text];
  const chunks = [];
  for (let i = 0; i < text.length; i += CHUNK) chunks.push(text.slice(i, i + CHUNK));
  return chunks;
}

function createMirror(options = {}) {
  const root = options.root || qq.ROOT;
  const statePath = options.statePath
    || process.env.DSH_TEAM_OPS_MIRROR_STATE
    || path.join(root, 'docs', 'tmp', 'team-ops-mirror.json');
  const logPath = options.logPath
    || process.env.DSH_TEAM_OPS_MIRROR_LOG
    || path.join(root, 'docs', 'tmp', 'team-ops-mirror.jsonl');
  const send = options.send || qq.sendSdkRequired;
  const getImInfo = options.getImInfo || (() => null);
  const now = options.now || (() => Date.now());

  const buffers = new Map();
  const sentKeys = new Set();
  const bound = new Set();

  const state = {
    version: 1,
    updatedAt: null,
    sends: 0,
    failures: 0,
    skippedIm: 0,
    skippedChild: 0,
    skippedDup: 0,
    skippedFormat: 0,
    lastFormatError: null,
    skippedEmpty: 0,
    skippedNoLead: 0,
    skippedOther: 0,
    lastSession: null,
    lastTurn: null,
    lastMessageId: null,
    lastError: null,
  };

  try {
    const loaded = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    for (const key of ['sends', 'failures', 'skippedIm', 'skippedChild', 'skippedDup', 'skippedEmpty', 'skippedNoLead', 'skippedOther', 'skippedFormat']) {
      if (Number.isFinite(Number(loaded?.[key]))) state[key] = Number(loaded[key]);
    }
    if (Array.isArray(loaded?.sentKeys)) for (const key of loaded.sentKeys) sentKeys.add(key);
    if (Array.isArray(loaded?.bound)) for (const id of loaded.bound) bound.add(id);
    for (const id of String(process.env.DSH_TEAM_OPS_BOUND_SESSIONS || '').split(',')) {
      const trimmed = id.trim();
      if (trimmed) bound.add(trimmed);
    }
  } catch { /* 首次运行 */ }

  function persist() {
    state.updatedAt = new Date().toISOString();
    state.bound = [...bound];
    state.sentKeys = [...sentKeys].slice(-200);
    try {
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      const tmp = `${statePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
      fs.renameSync(tmp, statePath);
    } catch { /* 状态写失败不影响镜像 */ }
  }

  function log(entry) {
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.appendFileSync(logPath, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n', 'utf8');
    } catch { /* 日志失败不影响镜像 */ }
  }

  // 唯一白名单：只镜像 Lead 会话；未配置时默认拒绝（与 qq_notify 共用 lead-gate）。
  function eligibility(header) {
    if (!leadGate.configured()) return { ok: false, reason: 'no-lead' };
    const id = String(header?.id || '');
    if (header?.origin === 'subagent' || header?.parentSession) return { ok: false, reason: 'child' };
    if (!leadGate.isLead(id).allowed) return { ok: false, reason: 'other' };
    return { ok: true };
  }

  function skip(reason) {
    if (reason === 'no-lead') state.skippedNoLead += 1;
    else if (reason === 'child') state.skippedChild += 1;
    else state.skippedOther += 1;
    persist();
  }

  async function sendChunks(text) {
    const chunks = chunkText(text);
    const ids = [];
    for (const chunk of chunks) {
      if (process.env.DSH_TEAM_OPS_DRY_RUN === '1') {
        ids.push(`dry-${crypto.createHash('sha1').update(chunk).digest('hex').slice(0, 12)}`);
        continue;
      }
      const result = await send(chunk);
      if (!result?.ok || !result?.messageId) return { ok: false, error: result?.error || 'send failed or no messageId', ids };
      ids.push(result.messageId);
    }
    return { ok: true, ids };
  }

  function handle(session, event) {
    try {
      const header = session?.header || {};
      const id = String(header.id || session?.id || '');
      const type = event?.type;
      if (!id || !type) return;
      if (type === 'assistant/message') {
        const gate = eligibility(header);
        if (!gate.ok) { skip(gate.reason); return; }
        const data = event.data || {};
        const text = extractText(data.message?.content);
        if (text) buffers.set(id, { turn: data.turn, text, at: now() });
        return;
      }
      if (type !== 'turn/end') return;
      {
        const gate = eligibility(header);
        if (!gate.ok) { skip(gate.reason); return; }
      }
      const data = event.data || {};
      const turn = data.turn;
      const reason = data.reason?.kind || 'unknown';
      const buffered = buffers.get(id);
      if (buffered && buffered.turn === turn) buffers.delete(id);
      if (reason !== 'completed') {
        if (reason === 'error' || reason === 'blocked') {
          state.failures += 1;
          state.lastError = `turn/${reason} (session ${id}, turn ${turn})`;
          log({ type: 'turn-failed', session: id, turn, reason });
          persist();
        }
        return;
      }
      const key = `${id}:${turn}`;
      if (sentKeys.has(key)) { state.skippedDup += 1; persist(); return; }
      const text = (buffered?.text || '').trim();
      if (!text) { state.skippedEmpty += 1; persist(); return; }
      if (bound.has(id)) { state.skippedIm += 1; log({ type: 'skip-im-bound', session: id, turn }); persist(); return; }
      let info = null;
      try { info = getImInfo(id); } catch { info = null; }
      if (info) { state.skippedIm += 1; log({ type: 'skip-im-bound', session: id, turn, channel: info.channel }); persist(); return; }
      // C05：镜像只发通过 5 行报告校验的摘要；不合格不静默截断，直接跳过并记录原因。
      const verdict = report.validate(text);
      if (!verdict.ok) {
        state.skippedFormat += 1;
        state.lastFormatError = { code: verdict.code, message: verdict.message, totalLines: verdict.totalLines, missing: verdict.missing || [] };
        log({ type: 'mirror-skip-format', session: id, turn, code: verdict.code, totalLines: verdict.totalLines, missing: verdict.missing || [] });
        persist();
        return;
      }

      state.sends += 1;
      state.lastSession = id;
      state.lastTurn = turn;
      log({ type: 'mirror-send', session: id, turn, chars: text.length, chunks: chunkText(text).length });
      sendChunks(text.slice(0, MAX_TEXT)).then((result) => {
        if (result.ok) {
          sentKeys.add(key);
          state.lastMessageId = result.ids.at(-1);
          log({ type: 'mirror-ok', session: id, turn, messageIds: result.ids });
        } else {
          state.failures += 1;
          state.lastError = String(result.error);
          log({ type: 'mirror-fail', session: id, turn, error: String(result.error) });
        }
        persist();
      }).catch((error) => {
        state.failures += 1;
        state.lastError = String(error?.message || error);
        log({ type: 'mirror-throw', session: id, turn, error: state.lastError });
        persist();
      });
      persist();
    } catch (error) {
      state.failures += 1;
      state.lastError = String(error?.message || error);
      log({ type: 'mirror-handler-error', error: state.lastError });
      persist();
    }
  }

  function bind(sessionId) {
    if (sessionId) { bound.add(String(sessionId)); persist(); }
  }

  function unbind(sessionId) {
    if (sessionId) { bound.delete(String(sessionId)); persist(); }
  }

  function status() {
    const allow = leadGate.describe();
    return {
      ...state,
      boundCount: bound.size,
      bufferedCount: buffers.size,
      statePath,
      logPath,
      leadSessionConfigured: allow.configured,
      leadSessionTail: allow.leadSessionTail,
    };
  }

  return { handle, bind, unbind, status, state, buffers, sentKeys, bound, statePath, logPath };
}

module.exports = { createMirror, extractText, chunkText, MAX_TEXT };
