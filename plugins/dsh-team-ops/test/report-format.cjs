#!/usr/bin/env node
'use strict';

/**
 * C05：5 行报告格式校验 + /汇总 回归（不联网、不写仓库文件）
 * 运行：node tools/team-ops-plugin/test/report-format.cjs
 */

const assert = require('node:assert');
const report = require('../lib/report.cjs');
const commands = require('../lib/commands.cjs');

let checks = 0;
const failed = [];
function check(name, fn) {
  checks += 1;
  try { fn(); console.log(`ok ${checks} - ${name}`); }
  catch (error) { failed.push(name); console.log(`not ok ${checks} - ${name}: ${error.message}`); }
}

const GOOD = [
  '结论：C05 校验通过',
  '交付：report.cjs + /汇总',
  '证据：node test/report-format.cjs',
  '需审核：无',
  '遗留：无',
].join('\n');

const NINE = ['结论：a', '交付：b', '证据：c', '需审核：d', '遗留：e', '', '补充 1', '补充 2', '补充 3'].join('\n');
const MISSING = ['结论：a', '交付：b', '证据：c', '遗留：e'].join('\n');

check('valid-five-lines', () => {
  const verdict = report.validate(GOOD);
  assert.strictEqual(verdict.ok, true);
  assert.strictEqual(verdict.lines.length, 5);
  assert.deepStrictEqual(verdict.lines.map((line) => line.split('：')[0]), report.LABELS);
});

check('nine-lines-fails', () => {
  const verdict = report.validate(NINE);
  assert.strictEqual(verdict.ok, false);
  assert.strictEqual(verdict.code, 'too-many-lines');
});

check('missing-approval-section-fails', () => {
  const verdict = report.validate(MISSING);
  assert.strictEqual(verdict.ok, false);
  assert.strictEqual(verdict.code, 'missing-sections');
  assert.deepStrictEqual(verdict.missing, ['需审核']);
});

check('missing-each-section-fails', () => {
  for (const label of report.LABELS) {
    const text = report.LABELS.filter((item) => item !== label).map((item) => `${item}：x`).join('\n');
    const verdict = report.validate(text);
    assert.strictEqual(verdict.ok, false, `${label} 缺失应失败`);
    assert.ok(verdict.missing.includes(label), `${label} 应出现在 missing`);
  }
});

check('empty-fails', () => {
  const verdict = report.validate('   ');
  assert.strictEqual(verdict.ok, false);
  assert.strictEqual(verdict.code, 'empty');
});

check('out-of-order-fails', () => {
  const verdict = report.validate(['交付：b', '结论：a', '证据：c', '需审核：d', '遗留：e'].join('\n'));
  assert.strictEqual(verdict.ok, false);
  assert.strictEqual(verdict.code, 'out-of-order');
});

async function commandChecks() {
  const result = await commands.handleCommand('/汇总');
  const lines = result.reply.split('\n');
  assert.strictEqual(lines.length, 5, result.reply);
  assert.deepStrictEqual(lines.map((line) => line.split('：')[0]), report.LABELS);

  const bad = await commands.handleCommand('/汇总 结论：只有一行');
  const badLines = bad.reply.split('\n');
  assert.strictEqual(badLines.length, 5);
  assert.ok(badLines[0].includes('报告不合格'), bad.reply);
  assert.ok(badLines[0].includes('missing-sections'), bad.reply);
  const good = await commands.handleCommand(`/汇总 ${GOOD}`);
  assert.strictEqual(good.reply.split('\n').length, 5);
}

check('format-report-joins-labels', () => {
  const text = report.formatReport(Object.fromEntries(report.LABELS.map((label) => [label, 'x'])));
  assert.strictEqual(text, report.LABELS.map((label) => `${label}：x`).join('\n'));
});

commandChecks().then(() => {
  checks += 1;
  console.log(`ok ${checks} - summary-command`);
  console.log(JSON.stringify({ ok: failed.length === 0, checks, failed }));
  process.exit(failed.length === 0 ? 0 : 1);
}).catch((error) => {
  failed.push('summary-command');
  console.log(`not ok - summary-command: ${error.message}`);
  console.log(JSON.stringify({ ok: false, checks: checks + 1, failed }));
  process.exit(1);
});
