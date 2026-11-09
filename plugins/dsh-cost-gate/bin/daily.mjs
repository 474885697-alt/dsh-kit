#!/usr/bin/env node
// 用外部 node（≥22.15，能解多帧 zstd）生成日报；同时写缓存供宿主工具直接读。
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const require = createRequire(import.meta.url)
const sessionReport = require('../lib/session-report.cjs')
const days = Number(process.argv[2] ?? 1)
const result = sessionReport.dailyReport({ days })
try {
  const dir = path.join(os.homedir(), '.dsh', 'dsh-cost-gate')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'daily-cache.json'),
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      days,
      sessionsDir: sessionReport.sessionsRoot(),
      report: result,
    }),
  )
} catch {
  // 缓存写失败不影响 stdout
}
process.stdout.write(JSON.stringify(result))
