#!/usr/bin/env node
'use strict';

/**
 * dsh-team-ops / role-guard 策略表（v1，单一来源）。
 *
 * v1 边界：只做 Lead / 非 Lead 二元 + 明确工具 deny + 已映射 session 的
 * edit/write 写域校验。宿主没有向成员 session 注入稳定角色 id；本文件只提供
 * 策略常量，角色身份由调用方（或 resolveRole）解析，未映射时跳过写域校验。
 *
 * 写域只覆盖 edit/write 的 file_path，是「防误写」而非强安全边界：
 * pwsh / ship_build / 脚本仍可绕过，工单与 health 里不得宣称强隔离。
 */

const POLICY = Object.freeze({
  version: '1.0.0',

  /** 宿主若注入角色，优先读这个环境变量（角色 id，例如 mechanics）。 */
  roleEnv: 'DSH_TEAM_ROLE',

  /** session -> role 映射文件；由接线单（task-12）在 spawn 后维护。 */
  roleSessionsFile: '~/.dsh/team-role-sessions.json',

  /** 审计 JSONL，相对项目根；只记元数据，不记参数正文/token/密钥。 */
  auditFile: 'docs/tmp/tools/role-guard-audit.jsonl',

  /** 写域校验开关；false 时仍保留工具 deny 与审计。 */
  enforceWriteScopes: true,

  /** 只有这些工具的参数里带 file_path，需要写域校验。 */
  writeTools: Object.freeze(['edit', 'write']),

  /**
   * 非 Lead 一律 deny 的工具。plugin_manager 含只读 action= list，
   * v1 按整工具拦截，避免非 Lead 通过 install/remove 改变宿主状态。
   */
  memberDeniedTools: Object.freeze([
    'spawn_teammate',
    'interrupt_agent',
    'plugin_manager',
    'qq_notify',
  ]),

  /** 工具内再按 action 收窄的 Lead 专属动作。 */
  leadOnlyToolActions: Object.freeze({
    team_task_update: Object.freeze(['delete']),
  }),

  /** 工具 -> roles.cjs 能力位；用于复用 canSpawn/canMerge/canAccept。 */
  capabilityTools: Object.freeze({
    spawn_teammate: 'canSpawn',
    interrupt_agent: 'canSpawn',
  }),
});

module.exports = { POLICY };
