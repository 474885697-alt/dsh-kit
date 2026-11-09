---
name: seeker-mechanics-dev
description: 《寻神者》机制与系统模块地图：底层逻辑（属性/战斗/经济/进度/存档/联机）与系统设计，part-90-features.js 的 ENH_* 表、P3 生物改造三路线、存档 F1–F3 坑与验收命令。任务涉及核心逻辑、战斗经济、增强/义体/生物改造/纹身师/技能树时使用。
whenToUse: 在 _worktrees\_mechanics 的 module/mechanics 上做底层逻辑或增强系统开发。
version: 0.1.0
source: local
updated: 2026-11-09
---
# 寻神者机制与系统模块（mechanics）开发地图

## owns
核心逻辑全部归 mechanics：`src/app/bootstrap.js`、`src/app/part-01..11.js`、`src/app/part-90-features.js`、`src/styles/part-01..04.css` + `part-90-features.css`、`src/server/part-01..04.js` + `part-90-features.js`、`src/index.template.html`、`docs/设计/`。
`src/app/dev-source.json` 归 copy；生成物只由 `node tools/build-all.cjs` 产出，不直接改。

## 代码地图（part-90-features.js）
- 常量：`ENH_P1_VERSION`、`ENH_BODY_PARTS`（8 部位 head/torso/arm_l/arm_r/leg_l/leg_r/skin/internal）、`ENH_BIO_MODES`、`ENH_CIRCUIT_BASE_CAP=2`、`ENH_PROFICIENCY_MAX=10`、`ENH_PROFICIENCY_MILESTONES=[1,3,5,7,9,10]`
- 数据：`ENH_CIRCUITS`（6 回路）、`ENH_RACES`（stitcher/fitter）、`ENH_RACE_SKILLS`、`ENH_TATTOOIST`、`ENH_CYBER_PATCH`、`ENH_BIO_GEAR`、`ENH_SKILL_TREES`
- 助手：`enhInt/enhStringList/enhNormalizeCardFields/enhNormalizeRunFields/enhCircuitCap/enhTotalCircuitSlots/enhProficiencyMilestone`
- 安装：`enhInstallP1()`；`enhBaseNormalizeCharacterCard`/`enhBaseCreateRun` 包装原函数；`enhDedupeCodexRaces()` 清 codex 重复族
- 调试出口：`window.__ENH_P1__`

## 交叉点（只读）
- `VOIDNET_GEAR`：`src/app/part-07.js:935`；16 槽 `:950`；`cyber`→`cyber_eye` 迁移 `:980-984`
- `characterCardDefaults`：`src/app/part-08.js:69`；`normalizeCharacterCard` `:97-135`
- `createRun`：`src/app/part-03.js:1225`
- codex 可玩族注入：`src/app/part-04.js:2145`；`codexRaceId` `:1885`

## 存档坑（已修，勿回退）
- F1：P2 字段在存档读回时被白名单丢掉 → part-90 包装里补
- F2：纹身师整份 null（state 初始化早于 part-90）→ 顺序已修
- F3：缝合者回退 tris → 已修
- 旧档 18 字段可读、保存不丢旧字段

## P3 三路线
- 寄生 parasite：最大生命 −8%、每场 1 次主动、拆返还 0、排异 20–30
- 变异 mutation：良性/恶性都保留、不可拆、60/30/10
- 共生 symbiosis：排异 +5、不降生命、拆返还 50%
- 同部位互斥；`occupies` 与装备位冲突要提示并阻止；排异 ≥60 开场 30% 并发症；洗一件 −30 当天不能再装

## 验收
`check-syntax` → `build-all` → `--check` → `enh:audit` → `smoke`；UI 改动补三档截图（1440/390/320，scrollWidth===innerWidth）。
