#!/usr/bin/env node
'use strict'

/**
 * C12：校验 team-ops 角色表与项目事实源是否一致（只报告，不改文件）。
 *
 * 三个来源：
 *   1. tools/team-ops-plugin/lib/roles.cjs    —— 插件读取的角色定义（id = 成员名）
 *   2. module.config.json                     —— 模块 id / member / owns 的机器可读来源
 *   3. docs/协作/成员与模块.md                 —— 人读名单（id 写在「中文名（id）」里）
 *
 * 校验项：
 *   - id 集合：roles ↔ module.config.member ↔ 文档（文档与 config 用模块 id，含 lead 例外）
 *   - writeScopes：每个模块的 owns 必须被对应角色的 writeScopes 覆盖（目录按前缀算覆盖）
 *   - reads：不得绝对路径、不得含 `..` 越界
 *   - 权限：lead 的 canSpawn/canMerge/canAccept 必须全 true，其他角色必须全 false
 *
 * 用法：node tools/team-ops-plugin/scripts/check-roles.cjs [--root <dir>] [--roles <file>]
 *        [--config <file>] [--doc <file>] [--json]
 * 退出码：0 全部一致；1 有差异（逐条打印 [code] 说明）；2 用法/读取失败。
 */

const fs = require('node:fs')
const path = require('node:path')

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) return fallback
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) return true
  return value
}

const asJson = process.argv.includes('--json')
const root = path.resolve(String(arg('root', path.resolve(__dirname, '..', '..', '..'))))
const rolesPath = path.resolve(String(arg('roles', path.join(root, 'tools/team-ops-plugin/lib/roles.cjs'))))
const configPath = path.resolve(String(arg('config', path.join(root, 'module.config.json'))))
const docPath = path.resolve(String(arg('doc', path.join(root, 'docs/协作/成员与模块.md'))))

function fail(message) {
  if (asJson) process.stdout.write(JSON.stringify({ ok: false, error: message }, null, 2) + '\n')
  else console.error(message)
  process.exit(2)
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    return fail(`无法读取 ${file}: ${error.message}`)
  }
}

function loadRoles(file) {
  try {
    const loaded = require(file)
    const list = Array.isArray(loaded) ? loaded : loaded.ROLES
    if (!Array.isArray(list)) return fail(`${file} 未导出 ROLES 数组`)
    return list
  } catch (error) {
    return fail(`无法加载 ${file}: ${error.message}`)
  }
}

/** 从「成员与模块.md」的表格行里取 id，并承认 lead 的单独一行。 */
function parseDocIds(text) {
  const ids = new Set()
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) continue
    const cells = line.split('|').map((cell) => cell.trim())
    const first = cells[1] || ''
    const match = first.match(/[（(]([a-z][a-z0-9-]*)[）)]/)
    if (match) ids.add(match[1])
  }
  if (/（lead）|\(lead\)/.test(text)) ids.add('lead')
  return ids
}

const roles = loadRoles(rolesPath)
const roleIds = roles.map((role) => String(role.id))
const config = readJson(configPath)
const modules = Array.isArray(config.modules) ? config.modules : []
const configIds = modules.map((mod) => String(mod.id))
const configMembers = modules.map((mod) => String(mod.member))
let docIds
try {
  docIds = parseDocIds(fs.readFileSync(docPath, 'utf8'))
} catch (error) {
  fail(`无法读取 ${docPath}: ${error.message}`)
}

const diffs = []
function report(code, message) {
  diffs.push({ code, message })
}

function diffSets(label, actual, expected, hint) {
  for (const id of expected) if (!actual.has(id)) report('missing-' + label, `${id}：${hint}`)
  for (const id of actual) if (!expected.has(id)) report('extra-' + label, `${id}：不在 ${label} 期望范围内`)
}

const roleSet = new Set(roleIds)
const docSet = new Set(docIds)
const expectedDoc = new Set([...configIds, 'lead'])
const expectedRole = new Set([...configMembers, 'lead'])

diffSets('role', roleSet, expectedRole, 'roles.cjs 缺少该成员（module.config.member 有）')
diffSets('config-id', new Set(configIds), new Set([...docSet].filter((id) => id !== 'lead')), 'module.config 与文档不一致')
diffSets('doc-id', docSet, expectedDoc, 'docs/协作/成员与模块.md 缺少该模块（config 有）')

const byId = new Map(roles.map((role) => [String(role.id), role]))
const covers = (scope, own) => {
  const normalized = String(scope).replace(/\/+$/, '')
  return own === normalized || own.startsWith(normalized + '/')
}

for (const mod of modules) {
  const role = byId.get(String(mod.member))
  if (!role) continue
  const scopes = Array.isArray(role.writeScopes) ? role.writeScopes : []
  for (const own of Array.isArray(mod.owns) ? mod.owns : []) {
    if (!scopes.some((scope) => covers(scope, own))) {
      report('write-scope-missing', `${mod.id}（${mod.member}）：owns "${own}" 未被 writeScopes 覆盖（现有：${scopes.join(', ') || '空'}）`)
    }
  }
}

for (const role of roles) {
  for (const read of Array.isArray(role.reads) ? role.reads : []) {
    const value = String(read)
    if (path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || value.split(/[\\/]+/).includes('..')) {
      report('reads-outside', `${role.id}：reads "${value}" 越界（绝对路径或 ..）`)
    }
  }
}

for (const role of roles) {
  const expected = role.id === 'lead'
  for (const key of ['canSpawn', 'canMerge', 'canAccept']) {
    if (Boolean(role[key]) !== expected) {
      report('permission-mismatch', `${role.id}.${key} 应为 ${expected}，实际 ${Boolean(role[key])}`)
    }
  }
}

const payload = {
  ok: diffs.length === 0,
  roles: { file: rolesPath, count: roleIds.length, ids: roleIds },
  config: { file: configPath, modules: configIds.length },
  doc: { file: docPath, ids: [...docIds] },
  diffs,
}

if (asJson) {
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n')
} else if (diffs.length === 0) {
  console.log(`check-roles OK：${roleIds.length} 角色 / ${modules.length} 模块，ids 与写域一致`)
} else {
  console.log(`check-roles 发现 ${diffs.length} 处差异：`)
  for (const item of diffs) console.log(`  [${item.code}] ${item.message}`)
}
process.exit(diffs.length === 0 ? 0 : 1)
