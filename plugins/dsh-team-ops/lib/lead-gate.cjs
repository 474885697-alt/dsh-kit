'use strict';

/**
 * 唯一的 Lead 判定：DSH_TEAM_OPS_LEAD_SESSION 指到的会话才是 Lead。
 *
 * team_mirror 与 qq_notify 必须共用这一份判定：
 *   - 未配置 env  → 一律拒绝（fail closed）
 *   - 会话 id 不匹配 → 拒绝
 *   - 只有完全相等 → 允许
 *
 * 只依赖 process.env，不读文件、不发网络。
 */

const ENV = 'DSH_TEAM_OPS_LEAD_SESSION';

function leadSession() {
  return (process.env[ENV] || '').trim();
}

function configured() {
  return leadSession().length > 0;
}

function tail(value) {
  const text = String(value || '');
  return text ? text.slice(-8) : null;
}

function isLead(sessionId) {
  const lead = leadSession();
  const id = String(sessionId || '').trim();
  if (!lead) return { allowed: false, status: 403, reason: 'no-lead', error: `${ENV} is not configured; QQ sending is disabled` };
  if (!id) return { allowed: false, status: 403, reason: 'no-session', error: 'no calling session id available' };
  if (id !== lead) return { allowed: false, status: 403, reason: 'other', error: 'QQ sending is restricted to the Lead session' };
  return { allowed: true, status: 200, reason: 'lead' };
}

function describe() {
  const lead = leadSession();
  return { configured: lead.length > 0, leadSessionTail: tail(lead) };
}

module.exports = { ENV, configured, describe, isLead, leadSession, tail };
