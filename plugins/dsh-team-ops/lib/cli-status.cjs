#!/usr/bin/env node
'use strict';

/**
 * dsh-team-ops / team-status CLI 实现。
 * 由 tools/team-status.cjs 薄封装调用，参数、输出、退出码与旧版一致。
 *
 * 用法：
 *   node tools/team-status.cjs --snapshot docs/tmp/team-status.json
 *   node tools/team-status.cjs --print
 */

const fs = require('node:fs');
const path = require('node:path');
const {
  DEFAULT_SNAPSHOT,
  OUTPUT,
  readSnapshot,
  readDeliveries,
  render,
  summary,
  writeStatus,
} = require('./status.cjs');

function main(argv = process.argv.slice(2)) {
  const args = argv;
  const snapshotPath = args.includes('--snapshot')
    ? args[args.indexOf('--snapshot') + 1]
    : DEFAULT_SNAPSHOT;
  const printOnly = args.includes('--print');

  const snapshot = readSnapshot(snapshotPath);
  const deliveries = readDeliveries();

  if (printOnly) {
    console.log(JSON.stringify(summary(snapshot, deliveries), null, 2));
    process.exit(0);
  }

  const result = writeStatus(snapshot, deliveries);
  console.log(JSON.stringify({ ...result, snapshot: snapshotPath }));
}

module.exports = { main };
