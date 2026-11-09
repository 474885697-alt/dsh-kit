---
name: seeker-module-worker
description: 《寻神者》模块 worktree 的省 token 工作法：只改 owns、先 grep 后 read、命令验收、报告不超过 12 行、提交 module/* 不 merge。任务提到寻神者、模块 worktree、机制/美术/文案/测试区时使用。
whenToUse: 在 _worktrees 里任一模块分支干活，或收到「模块任务卡」时。
version: 0.1.0
source: local
updated: 2026-11-09
---
# 寻神者模块工人：省 token 工作法

## 铁律
1. 只改 `docs/modules/<模块>.md` 里 owns 的路径，其他文件只读。
2. 永不整份读：`index.html`、`server.js`、`dist/*`、`.exe`、`.apk`、`data/dev-content.json`、构建日志。要事实就用命令取摘要。
3. 先 `grep -n` 定位，再 `read` 带 offset/limit（每次 ≤80 行）；同一文件同轮不重复读。
4. 编辑用 `edit` 小锚点（5–20 行），不要整文件 `write`。
5. 大输出只取尾部：`| Select-Object -Last 20`；失败只看错误行。

## 读预算
- 每轮 ≤3 个文件、≤200 行新增阅读。
- 设计稿只读与任务相关的一节：先 grep 标题拿行号，再 read。
- 截图只在需要判断视觉时读 1 张，优先 390 宽。

## 验收（按 owns 选）
- `node tools/check-syntax.cjs`
- `node tools/build-all.cjs --check`（不 owns 生成物就不重建）
- `npm.cmd run check:assets` / `lint:content` / `enh:audit`
- `node tools/smoke-test.cjs`
- 三档截图仅在 UI 改动时做

## 提交
- 只提交 owns 内文件到 `module/<模块>`。
- 不 owns 生成物时，提交前 `git checkout -- index.html`。
- 不 merge，不碰 main。

## 报告（≤12 行）
- commit hash + 一行主题
- 改动文件（路径 + 行数）
- 验收命令的结果数字
- 遗留风险或未做项
- 不贴代码、不贴日志、不贴截图、不复述任务卡。
