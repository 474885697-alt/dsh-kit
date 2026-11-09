---
name: seeker-copy-world
description: 《寻神者》文案/世界观模块的省 token 流程：dev-source.json codex 结构、dev-content.json 同步、300 问规则、去 AI 味语域、lint/docs:check 验收。任务是润色世界观、写设定/图鉴/市场文案时使用。
whenToUse: 在 _worktrees\_copy 的 module/copy 上改文案与世界设定。
version: 0.1.0
source: local
updated: 2026-11-09
---
# 寻神者文案模块（copy）

## owns
`docs/`（除 `docs/tmp/qa`、`docs/测试`）、`README.md`、`src/app/dev-source.json`。
不改 `src/` 其他文件、生成物、`docs/协作/`；不加 `codex.customRaces` 条目。

## 数据结构
- `src/app/dev-source.json` → `codex`：`intro`、`facts`、`strata`（11）、`powers`（11）、`cosmology`（7）、`bestiary`（6）、`anomalies`（9）、`glossary`（6）。
- 运行时服务端读 `data/dev-content.json`（同样结构）；改完 `dev-source.json` 必须同步该文件（打包/服务用）。
- `data/world300.json`（未跟踪，`data/` 被 gitignore）：300 条 `{q,a}`，只改 `a`，保留条数/问题/顺序；改前备份 `.bak-<ts>`。

## 写作规则
- 世界观百问：保留问题与编号，只重写答案；一条一叙事，不写百科腔。
- 去 AI 味（小说/随笔语域）：删填充与套话、破公式化排比、长短句交替、少用「不是…而是」「值得注意的是」「综上所述」、不堆形容词、不写空洞升华。
- 英文只用于标题/术语；属性用 躯/感/魂/遇 + 12 子属性；不把旧稿「8 职业 / implants / 07 增强页」写回来。
- 变异类文案必须写「随机结果，不保证良性」。

## 验收
`npm.cmd run lint:content`（0 error）、`npm.cmd run docs:check`；提交 `module/copy`，不 merge。

## 报告（≤10 行）
commit、改了哪几个文件/章节、字数变化、验收数字、未同步项（如 docx 需重建）。