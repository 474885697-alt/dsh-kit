#!/usr/bin/env node
/**
 * 工单标题命名校验自测（task-16 C）。
 *
 * 覆盖：合法 <成员区>-<要求> 放行；无前缀/未知前缀/过短/过长拒绝；
 * Lead 也不豁免；非 team_task_create 不受影响。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'team-ops-naming-'))
Object.assign(process.env, {
  DSH_TEAM_OPS_APPROVALS: path.join(tmp, 'approvals.json'),
  DSH_TEAM_OPS_APPROVAL_AUDIT: path.join(tmp, 'approvals-audit.jsonl'),
  DSH_TEAM_OPS_LEAD_SESSION: 'lead-naming',
  DSH_QQ_OPENID: 'test-openid',
  DSH_QQ_APP_ID: 'test-appid',
  DSH_QQ_SECRET_REF: 'test-secret',
})
delete process.env.DSH_TEAM_ROLE
delete process.env.DSH_TEAM_OPS_ROLE_SESSIONS

const checks = []
function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail })
}

const plugin = await import('../lib/index.js')

const events = new Map()
const tools = new Map()
const ctx = {
  on(name, fn) {
    events.set(name, [...(events.get(name) || []), fn])
    return () => {}
  },
  get() { return null },
  sessions: { get() { return { header: { cwd: process.cwd() } } } },
  webServer: { register() { return () => {} } },
  effect(fn) { return fn() },
  inject(_deps, fn) {
    fn({
      effect: ctx.effect,
      tools: {
        register(def) {
          tools.set(def.name, def)
          return () => tools.delete(def.name)
        },
      },
    })
  },
}

const origLog = console.log
const origError = console.error
console.log = () => {}
console.error = () => {}
plugin.apply(ctx)
console.log = origLog
console.error = origError

const preExecute = (events.get('tools/pre-execute') || [])[0]
const approvalTool = tools.get('team_approval')
const leadExec = { agent: { id: 'lead-agent', session: { id: 'lead-naming' } } }

check('pre-execute-registered', typeof preExecute === 'function', Boolean(preExecute))
check('approval-tool', Boolean(approvalTool), [...tools.keys()])

async function callCreate(subject, description, sessionId = 'lead-naming') {
  let nextCalled = false
  const result = await preExecute(
    { name: 'team_task_create', arguments: { subject, description }, agent: { session: { id: sessionId } } },
    () => { nextCalled = true; return { kind: 'allow' } },
  )
  return { result, nextCalled }
}

// 合法标题：先满足审批门，应一路放行
const created = JSON.parse(await approvalTool.execute({ action: 'request', summary: '命名校验用批准', quote: '可以继续' }, leadExec))
const apvId = created?.approval?.id
JSON.parse(await approvalTool.execute({ action: 'approve', id: apvId }, leadExec))
const approvedDraft = `approvedByUser: true\napprovalRef: ${apvId}\n工具区-命名校验合法样例`
const legal = await callCreate('工具区-命名校验合法样例', approvedDraft)
check('legal-subject-allow', legal.nextCalled === true && legal.result?.kind === 'allow', legal)

const cases = [
  ['no-prefix', '命名校验没有前缀'],
  ['unknown-prefix', '财务区-预算表'],
  ['empty', ''],
  ['too-short', '工具区-a'],
  ['too-long', '工具区-' + 'x'.repeat(41)],
]
for (const [name, subject] of cases) {
  const out = await callCreate(subject, `approvedByUser: true\napprovalRef: ${apvId}\n${subject}`)
  check(
    `deny-${name}`,
    out.nextCalled === false
      && out.result?.kind === 'deny'
      && /invalid-task-subject/.test(String(out.result.reason))
      && out.result.displayReason === '工单标题必须是“成员区-简短要求”，例如“文案区-文案的优化整理”',
    out,
  )
}

// 缺省 subject：不再沿用旧审批门，直接拒绝（不自动补名）
let missingNext = false
const missing = await preExecute(
  { name: 'team_task_create', arguments: { description: `approvedByUser: true\napprovalRef: ${apvId}\n工具区-缺省标题` }, agent: { session: { id: 'lead-naming' } } },
  () => { missingNext = true; return { kind: 'allow' } },
)
check(
  'deny-missing-subject',
  missingNext === false
    && missing?.kind === 'deny'
    && /invalid-task-subject/.test(String(missing.reason))
    && missing.displayReason === '工单标题必须是“成员区-简短要求”，例如“文案区-文案的优化整理”',
  missing,
)

// 未知前缀也覆盖一个非 Lead 会话，确认不是靠角色门误伤
const hubDeny = await callCreate('财务区-预算表', 'approvedByUser: true', 'hub-naming')
check('deny-unknown-prefix-hub', hubDeny.nextCalled === false && /invalid-task-subject/.test(String(hubDeny.result?.reason)), hubDeny)

// 非 team_task_create 不受影响
let otherNext = false
const other = await preExecute({ name: 'team_status', arguments: {}, agent: { session: { id: 'lead-naming' } } }, () => { otherNext = true; return { kind: 'allow' } })
check('other-tool-unaffected', otherNext === true && other?.kind === 'allow', other)

const failed = checks.filter((c) => !c.ok)
const out = { ok: failed.length === 0, checks: checks.length, passed: checks.length - failed.length, failed: failed.map((c) => c.name), tmp }
console.log(JSON.stringify(out, null, 2))
if (failed.length) console.log(JSON.stringify(failed, null, 2))
process.exit(failed.length ? 1 : 0)
