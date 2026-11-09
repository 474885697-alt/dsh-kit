# dsh-cost-gate

派活前的成本闸门。规则来自用户 2026-11-08：

> 峰时单任务成本在 0.5 元左右，或者完全可以依靠本地运行，才允许放行；
> 谷时只给预估，不拦截任何运行。

补充规则（2026-11-08 晚）：

> 周末没有峰时，周六/周日全天按谷时；
> 不同模型可以有不同的峰谷方案，按任务实际使用的模型决定拦不拦。

## 判定

| 时段 | 条件 | 结果 |
| --- | --- | --- |
| 周末（周六/周日，`Asia/Shanghai`） | 任意，除非模型显式关闭 `weekendValley` | 放行，只记录预估 |
| 谷时（默认 00:30–08:30，可按模型覆盖） | 任意 | 放行，只记录预估 |
| 峰时 | `local: true` 或零价模型，且无 media | 放行 |
| 峰时 | 估算 ≤ 该模型 `thresholdCNY`（默认 0.5） | 放行 |
| 峰时 | 估算 > 该模型阈值 | 拦截，提示等到该模型的谷时或拆小 |

一个计划里可以有多个模型：谷时模型的任务放行，峰时模型且超阈值的任务拦截，输出 `phase: "mixed"`。

## 任务卡成本门（C10，0.2.1）

`team_task_create` 之前先过同一套判定：pre-execute 读任务卡 `description`，缺字段直接拒绝，不再只告警。

| 条件 | 结果 |
| --- | --- |
| 任务卡没有 `上限 ¥x` / `预算 ¥x` | 拒绝 `missing-budget`（缺预算不得当 0） |
| 任务卡没有 `估算 ¥x` / `成本 ¥x` | 拒绝 `missing-estimate` |
| 模型不在 `prices.json` | 拒绝 `unknown-model` |
| 估算 > 上限（含谷时、周末） | 拒绝 `over-cap`，输出模型/上下限/估算 |
| 峰时、估算 ≤ 上限、未写 `用户已批`/`approvedByUser: true` | 拒绝 `peak-unapproved` |
| 谷时或周末、估算 ≤ 上限 | 放行（只预估） |
| 峰时、已批、估算 ≤ 上限 | 放行 |
| 估算 = 上限 | 放行（相等不算超） |

## 峰时预算硬上限（¥10/日）

2026-11-09 起，每个 `Asia/Shanghai` 自然日的峰时窗口（08:30–24:00）累计放行估算不得超过 ¥10。

- 账本：`~/.dsh/dsh-cost-gate/peak-spend.json`，字段 `{ window, spentCNY, entries: [{ ts, planId, totalPeakCNY }] }`；跨日按新窗口逻辑重置。
- `cost_gate` 新增 `status: true`：只读返回 `{ window, spentCNY, capCNY, remainingCNY, resetAt }`，不估价、不写放行。
- `approve: true` 且准备写放行前，先调用 `peak-budget.charge(totalPeakCNY)`；命中上限时返回 `blockedByCap: true`，**不写放行**，并写交接单。
- 交接单：`~/.dsh/dsh-cost-gate/handoffs/<window>-<ts>.json`，字段 `{ window, capCNY, spentCNY, tasks, reason, createdAt, status: 'unfinished' }`；若当前目录存在 `docs/tmp/hub`，同时复制到 `docs/tmp/hub/cost-handoffs/`。
- `spawn_teammate` / `generate_audio` / `generate_comfyui` 的 pre-execute 在预算用完后返回 `kind: 'deny'`，reason 为 `cost-gate: peak-cap — 峰时预算 ¥10 已用完`，并提示“已保存交接单，等中枢区下个窗口重新投递”。
- 口径：只统计 `cost_gate` 批准的估算额，**不追溯已经跑起来的任务**；达到上限后新任务不启动，已在跑的由 Lead 按交接单 interrupt。

单卡自检：

```bash
node plugins/dsh-cost-gate/cost-gate.cjs --check-task docs/tmp/tools/task-card.md
node plugins/dsh-cost-gate/cost-gate.cjs --check-task - --json < task-card.md
```

退出码：`0` 放行、`1` 拦截、`2` 用法错误；`--now` 可指定时间复现峰谷。任务卡建议统一写：

```text
模型：deepseek-flash
估算 ¥0.05、上限 ¥0.10
```


## 推荐流程

1. **解析**需求，拆成任务卡（只读文本，几乎不花钱）。
2. 调 `cost_gate({ plan })`。每个任务按自己的 `model` 判定，返回**现在可派 / 等谷时 / 拆成 N 段**。
3. 只派 `advice.now` 里的任务；`advice.later` 进等待队列。
4. 到对应模型的谷时（或用户 override）重估一次再派。

## 按模型配置峰谷方案

`prices.json` 的关键字段：

```json
{
  "defaultModel": "deepseek-flash",
  "timezone": "Asia/Shanghai",
  "thresholdCNY": 0.5,
  "weekendValley": true,
  "valley": { "start": "00:30", "end": "08:30", "multiplier": 0.5 },
  "phasePlans": {
    "default": {
      "valley": [{ "start": "00:30", "end": "08:30" }],
      "weekendValley": true,
      "multiplier": 0.5
    },
    "night": {
      "valley": [{ "start": "22:00", "end": "08:30" }],
      "weekendValley": true,
      "multiplier": 0.5
    }
  },
  "models": {
    "deepseek-flash": { "inCNY": 2, "outCNY": 3, "phasePlan": "default" },
    "deepseek-pro": { "inCNY": 4, "outCNY": 8, "phasePlan": "default" },
    "local": { "inCNY": 0, "outCNY": 0, "phasePlan": "always", "thresholdCNY": 0 }
  }
}
```

- `phasePlan`：模型挂哪套峰谷方案；不写时用 `default`，再回退到全局 `valley`。
- 模型也可以不挂方案，直接覆盖：
  - `valley`: `{ start, end }` 或 `[{ start, end }, ...]`（支持跨午夜，如 `22:00-08:30`）；
  - `weekendValley`: `false` 表示这个模型周末也按峰时；
  - `thresholdCNY`: 这个模型自己的单任务阈值；
  - `valleyMultiplier`: 这个模型自己的谷时折扣。
- 优先级：模型字段 > `phasePlan` 字段 > 全局字段。
- 周末规则默认对所有模型生效；只有显式 `weekendValley: false` 的模型例外。

**当前配置**：`deepseek-flash` 和 `deepseek-pro` 都挂 `default`（00:30–08:30 + 周末全天）；`local` 挂 `always`。要给 `deepseek-pro` 单独的夜间窗口，把它的 `phasePlan` 改成 `"night"` 即可，不需要改代码。

## Agent 工具 `cost_gate`

```json
{
  "plan": {
    "tasks": [
      { "id": "BUG-1", "name": "支线块堵主线", "model": "deepseek-flash", "turns": 6, "inTokens": 40000, "outTokens": 10000 },
      { "id": "ONLINE-1", "name": "联机体检", "model": "deepseek-pro", "turns": 4, "inTokens": 30000, "outTokens": 8000, "member": "online" }
    ]
  }
}
```

- `plan.tasks[].inTokens/outTokens` 是**每轮**的量，估价乘 `turns`。
- 纯本地任务写 `"local": true, "model": "local"`。
- `approve: true` 只在计划里**没有**被拦截任务时写入放行；被拦任务要放行必须 `force: true`（需用户明确同意）。
- `approve_tools` 默认 `spawn_teammate`/`generate_audio`/`generate_comfyui`；可填 `["*"]`。
- `minutes` 默认 30 分钟。
- 返回的每行带 `[峰时]` / `[谷时]`、模型、方案、阈值，混合计划一眼能看出哪条被拦。

## 命令行

```powershell
node plugins/dsh-cost-gate/cost-gate.cjs --plan plugins/dsh-cost-gate/plan.sample.json
node plugins/dsh-cost-gate/cost-gate.cjs --plan my-plan.json --now 2026-11-08T02:00:00+08:00 --json
node plugins/dsh-cost-gate/cost-gate.cjs --plan my-plan.json --prices prices.test.json
node plugins/dsh-cost-gate/cost-gate.cjs --plan my-plan.json --advise
node plugins/dsh-cost-gate/cost-gate.cjs --queue
```

- `--now` 用于测试峰谷判定；`--prices` 指定另一份价格表。
- 有拦截时 `exit 1`；全部放行（含周末/谷时）`exit 0`。
- `--advise` 按成员分组，输出「现在可派」与「挂起，至少拆 N 段」。

## 等待队列

拦截时调用方会收到 `ask`（审批 never 时即拒绝）和一句原因，同时追加到：

```
~/.dsh/dsh-cost-gate/blocked.jsonl
```

查看：

```powershell
node plugins/dsh-cost-gate/cost-gate.cjs --queue
```

输出会列出各模型当前峰谷；全部谷时提示可直接重跑，否则提示还有哪些模型在峰时。

任务级的等待队列建议另记在 `docs/协作/等待队列.md`（任务 id / 归属模块 / 模型 / 估价 / 挂起原因 / 状态），因为被拦的是工具调用，不是任务本身。

## 峰谷相位监视

```powershell
node plugins/dsh-cost-gate/phase-watch.cjs --once
node plugins/dsh-cost-gate/phase-watch.cjs --once --now 2026-11-08T23:00:00+08:00
node plugins/dsh-cost-gate/phase-watch.cjs --watch --interval 60
node plugins/dsh-cost-gate/phase-watch.cjs --state
```

相位变化时写 `~/.dsh/dsh-cost-gate/state.json`、`events.jsonl`，并生成 `PAUSE.md` / `RESUME.md`。

- `state.json` 里 `phases` 是每个模型的相位；
- `PAUSE.md` 会列出峰时模型和谷时模型，只要求暂停峰时模型的高估价任务；
- 监视器只负责发现变化，不直接暂停成员（脚本拿不到 Team 工具）；暂停/续做由会话按操作单执行，协议见 `docs/协作/峰时暂停与进度快照.md`。

## 测试

```powershell
node plugins/dsh-cost-gate/test/phase.test.cjs
```

覆盖：周末全天谷时、周中峰谷、跨午夜窗口、单模型关闭周末谷时、混合计划只拦峰时模型、模型独立阈值、`nextValleyMinutes` 落点、CLI 退出码、`phase-watch` 状态文件。

## 两种用法

### 1. Agent 工具 `cost_gate`（装成插件后可用）

见上文「Agent 工具」。

### 2. 命令行（不重启也能用）

见上文「命令行」。插件进程内的 `prices.json` 在启动时读取；改了 `prices.json` 或 `lib/*` 后，**host 插件需要重启 DSH 才生效**，CLI 和测试始终读最新文件。

## 强制拦截

插件在 `tools/pre-execute` 拦三个工具：`spawn_teammate`、`generate_audio`、`generate_comfyui`。

- 全部模型谷时/周末：不拦。
- 有任一计费模型峰时：没有有效放行记录 → 返回 `ask`（审批策略为 never 时等于硬拦截，调用不会执行）。
- 放行记录由 `cost_gate` 的 `approve` 写入，进程内有效，重启失效。
- 守卫无法知道一次 `spawn_teammate` 最终用哪个模型，所以保守地按「任一计费模型峰时」拦截；具体任务能不能派，用 `cost_gate` 按模型估价。

## 安装 / 回滚

已加入桌面 profile：`package.json` 的 `dependencies`（`link:.../plugins/dsh-cost-gate`）与 `dsh.profile.bundles`，重启应用后生效。

本地 link 依赖还需要在 profile 的 `node_modules` 里有指向本目录的链接；已建 junction：
`C:\Users\03\.dsh\profiles\desktop\node_modules\dsh-cost-gate -> ...\plugins\dsh-cost-gate`。
若 `plugin_health` 报 `bundle-unresolved`，重建这个 junction 即可。

回滚：删除这两处（备份在 `C:\Users\03\.dsh\profiles\desktop\package.json.manual-20261108-164518`），或直接恢复该备份后重启。

## 待办

- [ ] 用 `token-meter` 实际值校准 `turns/tokens` 系数（连续偏差 >30% 时）。
- [ ] `send_message` 是否纳入拦截（会启动成员回合，但难估价）。
- [ ] 账本与侧边栏：今日花费、最近拦截、override 记录。
