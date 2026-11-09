#!/usr/bin/env node
'use strict';

/**
 * dsh-team-ops / role-guard 核心判定（v1，纯逻辑，不依赖宿主）。
 *
 * check({ role, tool, arguments }) ->
 *   allow: { allow:true, role, tool, writecheck, pathPrefix }
 *   deny : { kind:'deny', allow:false, reason, displayReason, ... }
 *
 * v1 边界：
 *   - 只做 Lead / 非 Lead 二元；非 Lead（含未映射）硬 deny 指定工具。
 *   - 写域校验只针对 edit/write 的 file_path，且只对已映射角色生效；
 *     未映射 -> writecheck=skipped 并审计，不猜角色。
 *   - 写域是「防误写」，pwsh / ship_build 可绕过，不是强安全边界。
 *   - 审计行只含 sessionTail/role/tool/decision/reason/pathPrefix，
 *     绝不记录 arguments 正文、token 或密钥。
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { getRole } = require('./roles.cjs');
const { POLICY } = require('./guard-policy.cjs');

const NO_ROLE_LABEL = '未映射角色（unknown）';

function tail(value) {
  const text = String(value || '');
  return text ? text.slice(-8) : null;
}

function expandHome(file) {
  const text = String(file || '');
  if (text === '~') return os.homedir();
  if (text.startsWith('~/') || text.startsWith('~\\')) {
    return path.join(os.homedir(), text.slice(2));
  }
  return text;
}

function isAbsolutePath(value) {
  const text = String(value || '');
  return /^[A-Za-z]:[\\/]/.test(text) || text.startsWith('/') || text.startsWith('\\\\');
}

/** 词法归一化绝对路径（Windows 反斜杠 -> /，折叠 . 与 ..）。越界返回 null。 */
function normalizeAbsolute(value) {
  let text = String(value || '').replace(/\\/g, '/');
  if (!text) return null;

  let prefix = '';
  if (/^[A-Za-z]:/.test(text)) {
    prefix = text.slice(0, 2);
    text = text.slice(2);
  } else if (text.startsWith('//')) {
    prefix = '//';
    text = text.slice(2);
  } else if (text.startsWith('/')) {
    prefix = '';
  } else {
    return null;
  }

  const segments = [];
  for (const segment of text.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (!segments.length) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  if (prefix === '//') return `//${segments.join('/')}`;
  return `${prefix}/${segments.join('/')}`;
}

function relativeToRoot(absolute, rootAbsolute) {
  const target = absolute.split('/');
  const root = rootAbsolute.split('/');
  if (target.length < root.length) return null;
  for (let i = 0; i < root.length; i += 1) {
    if (target[i].toLowerCase() !== root[i].toLowerCase()) return null;
  }
  return target.slice(root.length).join('/');
}

/** 归一化待写入路径；返回 { rel } 或 { error }。 */
function resolveWritePath(raw, projectRoot) {
  const rawText = String(raw == null ? '' : raw).trim();
  if (!rawText || rawText.includes('\0')) return { error: 'invalid-path' };
  const rootAbsolute = normalizeAbsolute(path.resolve(String(projectRoot || process.cwd())));
  if (!rootAbsolute) return { error: 'invalid-project-root' };

  const unified = rawText.replace(/\\/g, '/');
  const isAbsolute = isAbsolutePath(unified);
  const absolute = isAbsolute
    ? normalizeAbsolute(unified)
    : normalizeAbsolute(`${rootAbsolute.replace(/\/$/, '')}/${unified}`);
  if (!absolute) return { error: 'path-traversal' };

  const rel = relativeToRoot(absolute, rootAbsolute);
  if (rel === null) {
    const hasParentSegment = !isAbsolute && unified.split('/').includes('..');
    return { error: hasParentSegment ? 'path-traversal' : 'path-outside-project' };
  }
  if (!rel) return { error: 'path-traversal' };
  return { rel };
}

function looksLikeFile(scope) {
  return /\.[A-Za-z0-9]+$/.test(scope);
}

function matchesWriteScope(relativeLower, scopeRaw) {
  const scope = String(scopeRaw || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '')
    .toLowerCase();
  if (!scope) return false;
  if (relativeLower === scope) return true;
  if (looksLikeFile(scope)) return false;
  return relativeLower.startsWith(`${scope}/`);
}

function pathPrefixOf(relative) {
  const segments = String(relative || '').split('/').filter(Boolean);
  if (!segments.length) return '/';
  return segments.slice(0, 3).join('/');
}

function roleLabel(role) {
  return role ? role.label : NO_ROLE_LABEL;
}

function scopesLabel(role) {
  if (!role || !role.writeScopes.length) return '（无写入权限）';
  return role.writeScopes.join('、');
}

function deny(role, tool, reason, extra = {}) {
  const label = roleLabel(role);
  const target = extra.path ? `：${extra.path}` : '';
  const displayReasons = {
    'tool-denied': `当前角色「${label}」不允许调用 ${tool}；这是统合设计区（lead）专属操作，请把需求交给 Lead。`,
    'lead-only-action': `当前角色「${label}」不允许执行 ${tool} 的 ${extra.action || '该'} 动作；这是统合设计区（lead）专属操作。`,
    'write-denied': `当前角色「${label}」的写域不包含${target || '该路径'}。允许的写域：${scopesLabel(role)}。请改到写域内，或交给对应模块。`,
    'invalid-path': `写入路径无效${target}；请给出项目内的 file_path。`,
    'path-traversal': `写入路径含越界片段（..）${target}，已拒绝。`,
    'path-outside-project': `写入路径不在项目根内${target}，已拒绝。`,
  };
  return {
    allow: false,
    kind: 'deny',
    role: role ? role.id : 'unknown',
    tool,
    reason,
    displayReason: displayReasons[reason] || `当前角色「${label}」的调用被 role-guard 拒绝（${reason}）。`,
    writecheck: extra.writecheck || 'n/a',
    pathPrefix: extra.pathPrefix || null,
  };
}

/**
 * 判定一次工具调用。
 * @param {{role?:string, tool?:string, arguments?:object, mapped?:boolean, sessionId?:string}} input
 * @param {{projectRoot?:string}} options
 */
function check(input = {}, options = {}) {
  const tool = String(input.tool || '').trim();
  const roleId = String(input.role || 'unknown').trim().toLowerCase();
  const role = getRole(roleId);
  const args = input.arguments && typeof input.arguments === 'object' ? input.arguments : {};
  const mapped = input.mapped === false ? false : Boolean(role);
  const isLead = roleId === 'lead';

  // 1) Lead / 非 Lead 二元门：成员（含未映射）硬 deny 指定工具。
  const capability = POLICY.capabilityTools[tool];
  const capabilityDenied = Boolean(capability) && (!role || role[capability] !== true);
  if (!isLead && (POLICY.memberDeniedTools.includes(tool) || capabilityDenied)) {
    return deny(role, tool, 'tool-denied');
  }

  // 2) 工具内 Lead 专属动作（目前只有 team_task_update delete）。
  const leadOnlyActions = POLICY.leadOnlyToolActions[tool];
  const action = String(args.action || '').trim().toLowerCase();
  if (!isLead && leadOnlyActions && leadOnlyActions.includes(action)) {
    return deny(role, tool, 'lead-only-action', { action });
  }

  // 3) 写域：只覆盖 edit/write；只对已映射角色生效，未映射跳过并审计。
  if (!POLICY.writeTools.includes(tool)) {
    return { allow: true, role: role ? role.id : 'unknown', tool, writecheck: 'n/a', pathPrefix: null };
  }
  if (!POLICY.enforceWriteScopes) {
    return { allow: true, role: role ? role.id : 'unknown', tool, writecheck: 'disabled', pathPrefix: null };
  }
  if (!mapped) {
    return { allow: true, role: 'unknown', tool, writecheck: 'skipped', pathPrefix: null };
  }

  const rawPath = args.file_path ?? args.filePath ?? args.path;
  const resolved = resolveWritePath(rawPath, options.projectRoot || process.cwd());
  if (resolved.error) {
    const reason = ['invalid-path', 'path-traversal', 'path-outside-project'].includes(resolved.error)
      ? resolved.error
      : 'write-denied';
    return deny(role, tool, reason, {
      writecheck: 'checked',
      path: rawPath == null ? '' : String(rawPath),
      pathPrefix: reason === 'path-traversal' ? '<escape>' : '<outside>',
    });
  }

  const relLower = resolved.rel.toLowerCase();
  const allowed = role.writeScopes.some((scope) => matchesWriteScope(relLower, scope));
  if (!allowed) {
    return deny(role, tool, 'write-denied', {
      writecheck: 'checked',
      path: rawPath == null ? '' : String(rawPath),
      pathPrefix: pathPrefixOf(resolved.rel),
    });
  }
  return {
    allow: true,
    role: role.id,
    tool,
    writecheck: 'checked',
    pathPrefix: pathPrefixOf(resolved.rel),
  };
}

/**
 * 解析 session -> role。
 * 顺序：DSH_TEAM_ROLE 环境变量 -> ~/.dsh/team-role-sessions.json。
 * 取不到返回 role:'unknown', mapped:false；绝不用任务 owner 猜角色。
 */
function resolveRole(input = {}, options = {}) {
  const sessionId = String(input.sessionId || '').trim();
  const env = options.env || process.env;
  const envRole = String(env[POLICY.roleEnv] || '').trim().toLowerCase();
  if (envRole && getRole(envRole)) return { role: envRole, mapped: true, source: 'env' };

  if (!sessionId) return { role: 'unknown', mapped: false, source: 'none' };

  const file = expandHome(options.roleSessionsFile || POLICY.roleSessionsFile);
  let data = null;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    data = null;
  }
  const table = data && typeof data === 'object'
    ? (data.sessions && typeof data.sessions === 'object' ? data.sessions : data)
    : null;
  const entry = table && Object.prototype.hasOwnProperty.call(table, sessionId) ? table[sessionId] : null;
  const roleId = typeof entry === 'string' ? entry : (entry && typeof entry === 'object' ? entry.role : '');
  const normalized = String(roleId || '').trim().toLowerCase();
  if (normalized && getRole(normalized)) return { role: normalized, mapped: true, source: 'file' };
  return { role: 'unknown', mapped: false, source: 'none' };
}

function toAuditEntry(decision, input = {}) {
  return {
    ts: new Date().toISOString(),
    sessionTail: tail(input.sessionId),
    role: decision.role || 'unknown',
    tool: decision.tool || '',
    decision: decision.kind === 'deny' ? 'deny' : 'allow',
    reason: decision.reason || null,
    writecheck: decision.writecheck || 'n/a',
    pathPrefix: decision.pathPrefix || null,
  };
}

function appendAudit(entry, options = {}) {
  const file = options.auditFile
    ? path.resolve(String(options.auditFile))
    : path.resolve(String(options.projectRoot || process.cwd()), POLICY.auditFile);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
  return file;
}

/**
 * check + 审计。deny 与 writecheck=skipped 各写一行；普通放行不写。
 * 审计失败不阻断工具调用（deny 仍然生效），只把错误挂到返回值上。
 */
function checkAndAudit(input = {}, options = {}) {
  const decision = check(input, options);
  const shouldAudit = decision.kind === 'deny' || decision.writecheck === 'skipped';
  if (shouldAudit) {
    try {
      appendAudit(toAuditEntry(decision, input), options);
      decision.audited = true;
    } catch (error) {
      decision.audited = false;
      decision.auditError = String((error && error.message) || error);
    }
  }
  return decision;
}

module.exports = {
  POLICY,
  appendAudit,
  check,
  checkAndAudit,
  normalizeAbsolute,
  resolveRole,
  resolveWritePath,
  toAuditEntry,
};
