---
name: cost-gate
description: 派活前的成本闸门。拆任务后、spawn/唤醒成员或调用音频/图片生成前，用本技能估算单任务人民币成本；峰时单任务超该模型阈值且非纯本地才拦，谷时和周末（周六/周日）只预估不拦；不同模型可按 phasePlan 用不同峰谷方案。任务涉及“这活多少钱/预算/花费/token 浪费/要不要派活”时使用。
---

# cost-gate：派活前先算钱

## 规则（用户 2026-11-08 定）

- **周末**（周六/周日，Asia/Shanghai）：全天按谷时，只给预估，**不拦截**；只有模型显式 `weekendValley: false` 才例外。
- **谷时**（默认 00:30–08:30 Asia/Shanghai）：只给预估，**不拦截任何运行**。
- **峰时**：单任务估算 **≤ 该模型阈值**（默认 ¥0.5），或任务**完全本地运行**（无外部模型/media 调用）→ 放行；否则**拦截**。
- **按任务实际模型判定**：不同模型可以挂不同 `phasePlan`（谷时窗口、周末规则、折扣、阈值）。一个计划里谷时模型的任务放行，峰时模型且超阈值的任务拦截。

## 什么时候跑

1. 把需求拆成任务卡之后、`team_task_create` / `spawn_teammate` / `send_message` 派活之前。
2. 调用 `generate_audio` / `generate_comfyui` 之前。
3. 用户问“这活要多少钱 / 会不会很费 token”时。

## 命令

```powershell
node plugins/dsh-cost-gate/cost-gate.cjs --plan <plan.json>
node plugins/dsh-cost-gate/cost-gate.cjs --plan <plan.json> --json
node plugins/dsh-cost-gate/cost-gate.cjs --plan <plan.json> --now 2026-11-08T17:00:00+08:00
node plugins/dsh-cost-gate/cost-gate.cjs --plan <plan.json> --prices <prices.json>
node plugins/dsh-cost-gate/cost-gate.cjs --advise --plan <plan.json>
```

项目根目录是 `C:\Users\03\Documents\deepseek-harness\default-workspace`。
有拦截时退出码为 1：**不要派被拦的任务**，先报给用户（等谷时 / 缩范围 / 改本地跑），除非用户明确 override。
插件工具 `cost_gate` 与 CLI 共用 `lib/phase.cjs`；改了价格/代码后 host 插件要重启 DSH 才生效，CLI 立即生效。

## plan.json

```json
{
  "tasks": [
    { "id": "BUG-1", "name": "一句话", "model": "deepseek-flash",
      "turns": 6, "inTokens": 40000, "outTokens": 10000, "media": [] },
    { "id": "ONLINE-1", "name": "联机体检", "model": "deepseek-pro",
      "turns": 4, "inTokens": 30000, "outTokens": 8000, "member": "online" }
  ]
}
```

- `model` 决定用哪套峰谷方案和阈值；不写时用 `defaultModel`。
- `inTokens`/`outTokens` 是**每轮**的量，估价乘 `turns`。
- 纯本地任务写 `"local": true, "model": "local"`。
- 价格表在 `plugins/dsh-cost-gate/prices.json`，按实际渠道单价改。

## prices.json 的模型方案

- `phasePlans.<name>.valley`：一个或多个 `{ start, end }` 窗口，支持跨午夜（如 `22:00-08:30`）。
- `phasePlans.<name>.weekendValley`：周末是否全天谷时，默认 `true`。
- `phasePlans.<name>.multiplier`：谷时预估折扣。
- `models.<id>.phasePlan`：挂哪套方案，缺省 `default`。
- `models.<id>` 也可直接覆盖 `valley` / `weekendValley` / `thresholdCNY` / `valleyMultiplier`；优先级：模型字段 > 方案字段 > 全局字段。
- 当前 `deepseek-flash`、`deepseek-pro` 挂 `default`；要给某个模型单独夜间窗口，把它的 `phasePlan` 改成 `night` 即可。

## 汇报格式

一行一个任务：`任务 | [峰时/谷时] 模型/方案 | 峰时 ¥x.xx / 谷时 ¥x.xx | 放行/拦截 | 理由`，最后给合计与拦截数。只报被拦的与合计，不用贴整张表。混合计划要指出哪条被拦、哪条因谷时/本地放行。
