#!/usr/bin/env node
'use strict';

/**
 * dsh-team-ops / QQ 投递核心（自包含）。
 *
 * 优先走 dsh-im HTTP，失败时回退到 QQ SDK 直发。
 * 只负责发送与回执日志，不做去重。
 * 不依赖仓库内其他脚本；插件被 link 到任意 profile 时也能工作。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = process.env.DSH_TEAM_ROOT
  ? path.resolve(process.env.DSH_TEAM_ROOT)
  : path.resolve(__dirname, '..', '..', '..');
const LOG_PATH = process.env.DSH_QQ_DELIVERY_LOG
  || path.join(ROOT, 'docs', 'tmp', 'qq-delivery-log.jsonl');
const BOT_ID = process.env.DSH_QQ_BOT_ID || 'qq_baab4124a569925dc7602b8b';
const TARGET_ID = process.env.DSH_QQ_TARGET_ID || 'owner';

// 插件不内置 openid / AppID / secretRef：缺一个就明确报错，绝不回落到真实账号。
const REQUIRED_QQ_ENV = [
  ['DSH_QQ_OPENID', 'QQ 用户 openid'],
  ['DSH_QQ_APP_ID', 'QQ 机器人 AppID'],
  ['DSH_QQ_SECRET_REF', '凭据文件里的密钥引用名'],
];

function requiredConfig() {
  const found = {};
  const missing = [];
  for (const [envName, label] of REQUIRED_QQ_ENV) {
    const value = String(process.env[envName] || '').trim();
    if (value) found[envName] = value;
    else missing.push(`${envName}（${label}）`);
  }
  if (missing.length) {
    throw new Error(
      `missing required QQ config: ${missing.join(', ')}；请先设置对应环境变量（插件不内置 openid/AppID/secretRef）`,
    );
  }
  return {
    openid: found.DSH_QQ_OPENID,
    appId: found.DSH_QQ_APP_ID,
    secretRef: found.DSH_QQ_SECRET_REF,
  };
}

function webBase() {
  return (process.env.DSH_WEB_URL || 'http://127.0.0.1:64595').replace(/\/+$/, '');
}

function deliveryEndpoint() {
  return process.env.DSH_QQ_DELIVERY_URL || `${webBase()}/api/dsh-im/delivery/messages`;
}

function appendLog(entry) {
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + '\n', 'utf8');
  } catch {
    // 日志失败不影响投递
  }
}

/**
 * 归类一次 HTTP 投递结果。
 * 注意：dsh-im 桥接的 {sent:true} 只是“桥已受理”，不是平台 messageId；
 * 只有拿到 messageId 才算 verified，调用方不得只凭 sent 标记记成功。
 */
function classifyHttpDelivery(responseOk, status, parsed) {
  const messageId = parsed?.messageId || parsed?.message_id || parsed?.id || parsed?.data?.messageId || null;
  const ok = Boolean(responseOk) && parsed?.sent === true;
  return {
    ok,
    status,
    messageId,
    verified: ok && Boolean(messageId),
    evidence: ok ? (messageId ? 'messageId' : 'sent-flag') : 'error',
  };
}

async function sendHttp(text, { format = 'text', botId = BOT_ID, targetId = TARGET_ID } = {}) {
  const payload = { botId, targetId, text };
  if (format === 'markdown') payload.format = 'markdown';
  const started = Date.now();
  try {
    const response = await fetch(deliveryEndpoint(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await response.text();
    let parsed = null;
    try { parsed = JSON.parse(body); } catch { /* keep raw */ }
    const verdict = classifyHttpDelivery(response.ok, response.status, parsed);
    const entry = {
      at: new Date().toISOString(),
      mode: 'dsh-im',
      ok: verdict.ok,
      verified: verdict.verified,
      delivery: verdict.verified ? 'verified' : (verdict.ok ? 'bridge-accepted' : 'failed'),
      status: response.status,
      ...(verdict.messageId ? { messageId: verdict.messageId } : {}),
      botId,
      targetId,
      ms: Date.now() - started,
      preview: text.slice(0, 80),
      error: verdict.ok ? undefined : (parsed?.error || body.slice(0, 200)),
    };
    appendLog(entry);
    return { ...entry, body: parsed ?? body };
  } catch (error) {
    const entry = {
      at: new Date().toISOString(),
      mode: 'dsh-im',
      ok: false,
      status: 0,
      botId,
      targetId,
      ms: Date.now() - started,
      preview: text.slice(0, 80),
      error: error?.message || String(error),
    };
    appendLog(entry);
    return { ...entry, errorObject: error };
  }
}

function readSecret(secretRef) {
  const credPath = process.env.DSH_QQ_CREDENTIALS
    || path.join(os.homedir(), '.dsh', '.credentials.yaml');
  const yaml = fs.readFileSync(credPath, 'utf8');
  const match = yaml.match(new RegExp(`${secretRef}:\\s*["']?([^"'\\s,]+)`));
  if (!match) throw new Error(`secret ref not found: ${secretRef}`);
  return match[1];
}

function latestSeenMessageId() {
  const statePath = process.env.DSH_QQ_STATE
    || path.join(os.homedir(), '.dsh', 'integrations', 'dsh-qq', 'bots', BOT_ID, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const seen = Array.isArray(state.seenMessageIds) ? state.seenMessageIds : [];
  return seen.filter((id) => typeof id === 'string').at(-1) || null;
}

async function loadQqBot(appId, secretRef) {
  const sdkPath = process.env.DSH_QQ_SDK
    || path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', '@tencent-connect', 'qqbot-nodejs', 'dist', 'index.js');
  const { QQBot } = await import(pathToFileURL(sdkPath).href);
  return new QQBot({ appId, appSecret: readSecret(secretRef) });
}

async function sendDirect(text, { passive = false } = {}) {
  const started = Date.now();
  let bot = null;
  try {
    const { openid, appId, secretRef } = requiredConfig();
    bot = await loadQqBot(appId, secretRef);
    const msgId = passive ? latestSeenMessageId() : null;
    if (passive && !msgId) throw new Error('no recent inbound message id for passive reply');
    const opts = msgId ? { msgId } : undefined;
    const result = await bot.messageApi.sendMessage('c2c', openid, text, bot.creds, opts);
    const entry = {
      at: new Date().toISOString(),
      mode: passive ? 'sdk-passive' : 'sdk-proactive',
      ok: true,
      status: 200,
      botId: BOT_ID,
      targetId: TARGET_ID,
      ms: Date.now() - started,
      preview: text.slice(0, 80),
      refIdx: result?.ext_info?.ref_idx,
      messageId: result?.id,
    };
    appendLog(entry);
    return { ...entry, result };
  } catch (error) {
    const entry = {
      at: new Date().toISOString(),
      mode: passive ? 'sdk-passive' : 'sdk-proactive',
      ok: false,
      status: 0,
      botId: BOT_ID,
      targetId: TARGET_ID,
      ms: Date.now() - started,
      preview: text.slice(0, 80),
      error: error?.message || String(error),
      code: error?.code,
    };
    appendLog(entry);
    return { ...entry, errorObject: error };
  } finally {
    try { await bot?.close?.(); } catch { /* ignore */ }
  }
}

function configStatus() {
  try {
    const cfg = requiredConfig();
    return { ready: true, openidTail: cfg.openid.slice(-4), appId: cfg.appId, secretRef: cfg.secretRef };
  } catch (error) {
    return { ready: false, error: String(error?.message || error) };
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 0.2.0 自动镜像专用：SDK 直发 owner，必须拿到平台 messageId 才算成功。
 * 失败重试一次；finally 关闭 SDK 客户端。
 */
async function sendSdkRequired(text, options = {}) {
  const started = Date.now();
  const injected = typeof options.send === 'function' ? options.send : null;
  const retryDelayMs = Number.isFinite(options.retryDelayMs) ? options.retryDelayMs : 1500;
  const { openid, appId, secretRef } = injected ? {} : requiredConfig();
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let bot = null;
    try {
      let result;
      if (injected) {
        result = await injected(text);
      } else {
        bot = await loadQqBot(appId, secretRef);
        result = await bot.messageApi.sendMessage('c2c', openid, text, bot.creds);
      }
      const messageId = result?.id || result?.message_id || result?.data?.id;
      if (!messageId) throw new Error('QQ SDK returned no messageId');
      const entry = {
        at: new Date().toISOString(),
        mode: 'sdk-mirror',
        ok: true,
        verified: true,
        delivery: 'verified',
        messageId,
        attempt,
        chars: text.length,
        ms: Date.now() - started,
        preview: text.slice(0, 80),
      };
      appendLog(entry);
      return { ok: true, verified: true, messageId, attempt, ms: entry.ms };
    } catch (error) {
      lastError = error;
      try { await bot?.close?.(); } catch { /* ignore */ }
      bot = null;
      if (attempt < 2 && retryDelayMs > 0) await sleep(retryDelayMs);
    }
  }
  const entry = {
    at: new Date().toISOString(),
    mode: 'sdk-mirror',
    ok: false,
    chars: text.length,
    ms: Date.now() - started,
    preview: text.slice(0, 80),
    error: lastError?.message || String(lastError),
    code: lastError?.code,
  };
  appendLog(entry);
  return { ok: false, error: entry.error, code: entry.code };
}

async function deliver(text, { format = 'text', passive = false, fallback = true } = {}) {
  if (passive) {
    const direct = await sendDirect(text, { passive: true });
    if (direct.ok || !fallback) return direct;
    return sendHttp(text, { format });
  }
  const first = await sendHttp(text, { format });
  if (first.ok || !fallback) return first;
  return sendDirect(text, { passive: false });
}

function recentLog(limit = 20) {
  try {
    const lines = fs.readFileSync(LOG_PATH, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-limit).map((line) => {
      try { return JSON.parse(line); } catch { return { raw: line }; }
    });
  } catch {
    return [];
  }
}

module.exports = {
  BOT_ID,
  LOG_PATH,
  ROOT,
  appendLog,
  classifyHttpDelivery,
  configStatus,
  deliver,
  deliveryEndpoint,
  recentLog,
  requiredConfig,
  sendDirect,
  sendHttp,
  sendSdkRequired,
};
