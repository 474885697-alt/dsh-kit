#!/usr/bin/env node
'use strict';

/**
 * dsh-team-ops / qq-notify CLI 实现。
 * 由 tools/qq-notify.cjs 薄封装调用，参数、输出、退出码与旧版一致。
 *
 * 用法：
 *   node tools/qq-notify.cjs "文本"
 *   node tools/qq-notify.cjs --file path\to\text.txt
 *   node tools/qq-notify.cjs --format markdown "**加粗**"
 *   node tools/qq-notify.cjs --passive "窗口内被动回复"
 *   node tools/qq-notify.cjs --status
 *   node tools/qq-notify.cjs --dry-run "文本"
 */

const fs = require('node:fs');
const { deliver, recentLog, deliveryEndpoint } = require('./qq.cjs');

function main(argv = process.argv.slice(2)) {
  const args = argv;
  const dryRun = args.includes('--dry-run');
  const passive = args.includes('--passive');
  const noFallback = args.includes('--no-fallback');
  const status = args.includes('--status');
  const formatIndex = args.indexOf('--format');
  const format = formatIndex >= 0 ? args[formatIndex + 1] : 'text';
  const fileIndex = args.indexOf('--file');
  let text = '';

  if (status) {
    console.log(JSON.stringify({ log: recentLog(20) }, null, 2));
    process.exit(0);
  }

  if (fileIndex >= 0) {
    const file = args[fileIndex + 1];
    if (!file) {
      console.error('usage: node tools/qq-notify.cjs --file <path>');
      process.exit(2);
    }
    text = fs.readFileSync(file, 'utf8');
  } else {
    const skip = new Set(['--dry-run', '--passive', '--no-fallback', '--status', '--format', format]);
    text = args.filter((arg, index) => {
      if (skip.has(arg)) return false;
      if (index > 0 && args[index - 1] === '--format') return false;
      return !arg.startsWith('--');
    }).join(' ');
  }

  text = text.replace(/^\uFEFF/, '').trim();
  if (!text) {
    console.error('usage: node tools/qq-notify.cjs "text" | --file <path> | --status');
    process.exit(2);
  }
  if (text.length > 4000) {
    console.error(`message too long: ${text.length} chars (max 4000)`);
    process.exit(2);
  }

  if (dryRun) {
    console.log(JSON.stringify({
      dryRun: true,
      endpoint: deliveryEndpoint(),
      passive,
      fallback: !noFallback,
      format,
      chars: text.length,
    }));
    process.exit(0);
  }

  (async () => {
    const result = await deliver(text, { format, passive, fallback: !noFallback });
    const { errorObject, body, ...visible } = result;
    console.log(JSON.stringify(visible));
    if (!result.ok) process.exitCode = 1;
  })().catch((error) => {
    console.error(error?.stack || String(error));
    process.exitCode = 1;
  });
}

module.exports = { main };
