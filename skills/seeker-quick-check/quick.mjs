#!/usr/bin/env node
/**
 * seeker-quick-check 薄封装（C11）
 *
 * 唯一执行源是 dsh-project-checkup 的 scan()；检查项全部来自项目根的
 * dsh-checkup.json（quick / full 两个数组），这里只做：
 *   1. 定位 dsh-project-checkup 插件；
 *   2. 调 scan(scope, dir)；
 *   3. 打印人类可读清单 / --json 原始结果；
 *   4. 有 fail/error 时 exit 1。
 *
 * 不复制、不硬编码任何检查项。
 *
 * 用法：
 *   node quick.mjs [--full] [--json] [--dir <项目根>] [--plugin <插件目录>]
 */

import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const argv = process.argv.slice(2)
function hasFlag(name) { return argv.includes(name) }
function argValue(name) {
  const i = argv.indexOf(name)
  return i > -1 ? argv[i + 1] : ''
}

const scope = hasFlag('--full') ? 'full' : 'quick'
const dir = resolve(argValue('--dir') || process.cwd())
const asJson = hasFlag('--json')
const pluginArg = argValue('--plugin') || process.env.DSH_PROJECT_CHECKUP_PLUGIN || ''

function pluginCandidates(start) {
  const list = []
  if (pluginArg) list.push(pluginArg)
  // 从 cwd 向上找 <root>/plugins/dsh-project-checkup
  let cur = start
  for (let i = 0; i < 5; i += 1) {
    list.push(join(cur, 'plugins', 'dsh-project-checkup'))
    list.push(join(cur, 'default-workspace', 'plugins', 'dsh-project-checkup'))
    const parent = dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  list.push(join(dir, 'plugins', 'dsh-project-checkup'))
  return [...new Set(list)]
}

function mainPath(candidate) {
  for (const file of [join(candidate, 'lib', 'index.js'), join(candidate, 'index.js')]) {
    if (existsSync(file)) return file
  }
  return ''
}

let entry = ''
for (const candidate of pluginCandidates(process.cwd())) {
  entry = mainPath(candidate)
  if (entry) break
}
if (!entry) {
  console.error('找不到 dsh-project-checkup 插件；用 --plugin <插件目录> 或 DSH_PROJECT_CHECKUP_PLUGIN 指定')
  process.exit(2)
}

const mod = await import(pathToFileURL(entry).href)
if (typeof mod.scan !== 'function') {
  console.error(`插件未导出 scan()：${entry}`)
  process.exit(2)
}

const result = await mod.scan(scope, dir)

if (asJson) {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
} else {
  const rows = result.checks || []
  for (const row of rows) {
    const detail = row.detail == null ? '' : String(typeof row.detail === 'string' ? row.detail : JSON.stringify(row.detail))
    console.log(`[${row.status}] ${row.id} · ${row.label}${detail ? ' — ' + detail : ''}`)
  }
  const count = (status) => rows.filter((row) => row.status === status).length
  console.log(`\n${scope}：${rows.length} 项（pass ${count('pass')} / warn ${count('warn')} / fail ${count('fail')} / error ${count('error')} / skip ${count('skip')}）`)
  console.log(`项目：${result.dir || dir}`)
}

const bad = (result.checks || []).some((row) => row.status === 'fail' || row.status === 'error')
process.exit(result.ok === false || bad ? 1 : 0)
