---
name: game-rulebook-to-code
description: 当用户有一份桌游/跑团规则书（docx、txt、md），想把它变成可玩的代码系统（网页游戏、状态机、数值表、判定流程）时使用。给出「先结构化、再建模、最后校验」的流程，配合 dsh-rulebook 抽数据、dsh-novel-studio 存设定、dsh-build-ship 打包。
---

# 规则书 → 可玩系统

## 1. 先抽结构，不要直接写代码

用 `rulebook_extract`（dsh-rulebook 插件）拿到：

```
{ title, chapters[], clauses[], numbers[], tables[] }
```

人工确认三件事：

- 章节是否完整（缺章 = 后面数值对不上）
- 数值条目是否成对（「攻击：3」而不是散落的 3）
- 表格是否被识别成行（`tables[]`）

## 2. 建模（三张表打天下）

| 表 | 内容 | 落点 |
| --- | --- | --- |
| 实体表 | 角色/怪物/物品的属性 | `entities.json` |
| 规则表 | 判定公式、修正、优先级 | `rules.json` |
| 流程表 | 回合阶段、触发条件、结算顺序 | `flow.json` |

判定写成纯函数，输入 `(state, action)`，输出 `{state, log[]}`。所有随机走可注入的 `rng(seed)`，否则没法复现 bug。

## 3. 用 dsh-novel-studio 存叙事

世界观、人物、时间线放 `novel_upsert`（section=characters/rules/timeline），写剧情时 `novel_context` 取摘要，`novel_check` 查设定冲突——和数值表共用一套设定，不会两边打架。

## 4. 校验清单

- [ ] 规则书里每个「属性：数值」都能在 `entities.json` 找到字段
- [ ] 每个判定公式都有边界用例（最小/最大/非法输入）
- [ ] 回合流程能跑满 10 回合不崩
- [ ] 存档/读档后状态一致
- [ ] 用 `ship_run`（dsh-build-ship）打包并核对产物

## 5. 常见坑

- 规则书用中文冒号「：」与全角数字，抽取时先归一化。
- 「可选规则」章节不要直接进主流程，做成开关。
- 数值平衡先照抄，跑通再调；一上来就「优化」会失去对照基线。