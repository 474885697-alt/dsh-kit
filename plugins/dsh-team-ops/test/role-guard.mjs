/**
 * role-guard v1 单测：判定 + 写域 + 审计（纯逻辑，不启动宿主）。
 * 运行：node tools/team-ops-plugin/test/role-guard.mjs
 */
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const guard = require('../lib/role-guard.cjs');

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const checks = [];
function check(name, ok, detail) { checks.push({ name, ok: Boolean(ok), detail }); }

function expectAllow(name, input, options = {}, writecheck) {
  const out = guard.check(input, { projectRoot: root, ...options });
  const ok = out.allow === true && out.kind !== 'deny' && (writecheck ? out.writecheck === writecheck : true);
  check(name, ok, out);
  return out;
}

function expectDeny(name, input, options = {}, reason) {
  const out = guard.check(input, { projectRoot: root, ...options });
  const ok = out.kind === 'deny' && out.allow === false && Boolean(out.displayReason)
    && (reason ? out.reason === reason : true);
  check(name, ok, out);
  return out;
}

// 1) Lead：可 spawn/merge 类工具，但不直接写文件（writeScopes 为空）。
expectDeny('lead-write-src-denied', { role: 'lead', tool: 'edit', arguments: { file_path: 'src/app/part-01.js' } }, {}, 'write-denied');
expectAllow('lead-spawn-allowed', { role: 'lead', tool: 'spawn_teammate', arguments: {} }, {}, 'n/a');
expectAllow('lead-task-delete-allowed', { role: 'lead', tool: 'team_task_update', arguments: { action: 'delete' } }, {}, 'n/a');

// 2) mechanics：写域内允许，越界拒绝。
expectAllow('mechanics-write-src-allowed', { role: 'mechanics', tool: 'edit', arguments: { file_path: 'src/app/part-01.js' } }, {}, 'checked');
expectAllow('mechanics-write-dir-scope', { role: 'mechanics', tool: 'write', arguments: { file_path: 'src/styles/main.css' } }, {}, 'checked');
const hubDenied = expectDeny('mechanics-write-hub-denied', { role: 'mechanics', tool: 'write', arguments: { file_path: 'docs/中枢/task.md' } }, {}, 'write-denied');
check('deny-reason-mentions-scope', String(hubDenied.displayReason).includes('src/styles'), hubDenied.displayReason);
expectDeny('mechanics-write-non-scope-file', { role: 'mechanics', tool: 'edit', arguments: { file_path: 'src/app/part-99.js' } }, {}, 'write-denied');
expectDeny('mechanics-plugin-manager-denied', { role: 'mechanics', tool: 'plugin_manager', arguments: { action: 'list_plugins' } }, {}, 'tool-denied');

// 3) hub：可建工单，不可 spawn。
expectAllow('hub-task-create-allowed', { role: 'hub', tool: 'team_task_create', arguments: { subject: 'x' } });
expectDeny('hub-spawn-denied', { role: 'hub', tool: 'spawn_teammate', arguments: {} }, {}, 'tool-denied');

// 4) qa：不可 delete 工单、不可装插件。
expectDeny('qa-task-delete-denied', { role: 'qa', tool: 'team_task_update', arguments: { action: 'delete', task_id: 'task-1' } }, {}, 'lead-only-action');
expectDeny('qa-plugin-manager-denied', { role: 'qa', tool: 'plugin_manager', arguments: { action: 'install_bundle' } }, {}, 'tool-denied');

// 5) 未映射角色：跳过写域，但仍 deny 危险工具。
expectAllow('unknown-write-skipped', { role: 'unknown', tool: 'edit', arguments: { file_path: 'src/app/part-01.js' } }, {}, 'skipped');
expectDeny('unknown-spawn-denied', { role: 'unknown', tool: 'spawn_teammate', arguments: {} }, {}, 'tool-denied');
expectAllow('unknown-read-tool-allowed', { role: 'unknown', tool: 'read', arguments: { file_path: 'src/app/part-01.js' } });

// 6) 路径归一化：.. 越界 / 绝对路径出项目 / Windows 大小写不敏感。
expectDeny('relative-traversal-denied', { role: 'mechanics', tool: 'edit', arguments: { file_path: '../outside.js' } }, {}, 'path-traversal');
expectDeny('absolute-outside-denied', { role: 'mechanics', tool: 'edit', arguments: { file_path: 'C:/Windows/Temp/x.js' } }, {}, 'path-outside-project');
expectAllow('case-insensitive-scope', { role: 'mechanics', tool: 'edit', arguments: { file_path: 'SRC/APP/PART-01.JS' } }, {}, 'checked');
expectAllow('absolute-inside-allowed', { role: 'mechanics', tool: 'edit', arguments: { file_path: join(root, 'src/app/part-01.js') } }, {}, 'checked');
expectAllow('tools-exact-file-scope', { role: 'tools', tool: 'write', arguments: { file_path: 'package.json' } }, {}, 'checked');
expectAllow('tools-dir-scope', { role: 'tools', tool: 'write', arguments: { file_path: 'tools/team-ops-plugin/lib/x.cjs' } }, {}, 'checked');

// 7) resolveRole：env 优先，其次映射文件；拿不到返回 unknown。
check('resolve-env-role', (() => {
  const out = guard.resolveRole({ sessionId: 'sess-env' }, { env: { DSH_TEAM_ROLE: 'mechanics' } });
  return out.role === 'mechanics' && out.mapped === true && out.source === 'env';
})(), 'env');
const tmp = mkdtempSync(join(tmpdir(), 'team-ops-role-guard-'));
const sessionsFile = join(tmp, 'team-role-sessions.json');
writeFileSync(sessionsFile, JSON.stringify({
  sessions: { 'sess-file-1234567890': { role: 'hub' }, 'sess-string-1234567890': 'qa' },
}), 'utf8');
const fromFile = guard.resolveRole({ sessionId: 'sess-file-1234567890' }, { env: {}, roleSessionsFile: sessionsFile });
check('resolve-file-role', fromFile.role === 'hub' && fromFile.mapped === true && fromFile.source === 'file', fromFile);
const fromString = guard.resolveRole({ sessionId: 'sess-string-1234567890' }, { env: {}, roleSessionsFile: sessionsFile });
check('resolve-file-string-entry', fromString.role === 'qa' && fromString.source === 'file', fromString);
const none = guard.resolveRole({ sessionId: 'sess-missing' }, { env: {}, roleSessionsFile: sessionsFile });
check('resolve-unknown', none.role === 'unknown' && none.mapped === false, none);

// 8) 审计：deny 与 skipped 各一行；普通放行不写；字段白名单、不落 token。
const auditFile = join(tmp, 'role-guard-audit.jsonl');
const auditInputs = [
  { role: 'mechanics', tool: 'edit', sessionId: 'aaaaaaaabbbbbbbb', arguments: { file_path: 'docs/中枢/x.md', token: 'sk-secret-value' } },
  { role: 'hub', tool: 'spawn_teammate', sessionId: 'ccccccccdddddddd', arguments: { name: 'x' } },
  { role: 'qa', tool: 'plugin_manager', sessionId: 'eeeeeeeeffffffff', arguments: { action: 'remove_bundle' } },
  { role: 'unknown', tool: 'write', sessionId: 'gggggggghhhhhhhh', arguments: { file_path: 'src/x.js' } },
  { role: 'mechanics', tool: 'edit', sessionId: 'iiiiiiiijjjjjjjj', arguments: { file_path: 'src/app/part-01.js' } },
  { role: 'lead', tool: 'spawn_teammate', sessionId: 'kkkkkkkkllllllll', arguments: {} },
];
const decisions = auditInputs.map((input) => guard.checkAndAudit(input, { projectRoot: root, auditFile }));
const denyCount = decisions.filter((d) => d.kind === 'deny').length;
const skippedCount = decisions.filter((d) => d.writecheck === 'skipped').length;
const lines = readFileSync(auditFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const auditDenies = lines.filter((line) => line.decision === 'deny').length;
const auditSkips = lines.filter((line) => line.writecheck === 'skipped').length;
check('audit-deny-count-equals', auditDenies === denyCount && denyCount === 3, { auditDenies, denyCount });
check('audit-skip-count-equals', auditSkips === skippedCount && skippedCount === 1, { auditSkips, skippedCount });
check('audit-total-lines', lines.length === 4, lines.length);
check('audit-no-token', !readFileSync(auditFile, 'utf8').includes('sk-secret'), 'audit file must not contain arguments');
check('audit-no-full-args', lines.every((line) => !('arguments' in line) && !('name' in line)), lines[0]);
const expectedFields = ['ts', 'sessionTail', 'role', 'tool', 'decision', 'reason', 'writecheck', 'pathPrefix'];
check('audit-field-whitelist', lines.every((line) => JSON.stringify(Object.keys(line).sort()) === JSON.stringify([...expectedFields].sort())), Object.keys(lines[0] || {}));
check('audit-session-tail', lines.every((line) => line.sessionTail === null || line.sessionTail.length === 8), lines.map((l) => l.sessionTail));
check('audit-skip-line', lines.some((line) => line.decision === 'allow' && line.writecheck === 'skipped' && line.role === 'unknown'), lines);

// 9) 审计失败不阻断（传入不可写路径），deny 仍生效。
const bad = guard.checkAndAudit({ role: 'hub', tool: 'qq_notify', sessionId: 'z' }, {
  projectRoot: root,
  auditFile: join(tmp, 'missing-dir', '\0bad', 'audit.jsonl'),
});
check('audit-failure-does-not-hide-deny', bad.kind === 'deny' && bad.audited === false && Boolean(bad.auditError), { kind: bad.kind, audited: bad.audited, auditError: bad.auditError });

const failed = checks.filter((item) => !item.ok);
for (const item of checks) {
  if (!item.ok) console.log(`FAIL ${item.name} :: ${JSON.stringify(item.detail)}`);
}
console.log(`\nrole-guard: ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) process.exit(1);
