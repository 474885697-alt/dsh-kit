---
name: seeker-art-audio-assets
description: 《寻神者》美术/音频模块的素材规范与省 token 流程：命名、尺寸、WebP、预览、check:assets 验收，不读源码不读整页截图。任务是出立绘/图标/音效/预览时使用。
whenToUse: 在 _worktrees\_art-audio 的 module/art-audio 上产出或替换素材。
version: 0.1.0
source: local
updated: 2026-11-09
---
# 寻神者美术/音频素材规范

## owns
`assets/art/generated/`、`assets/audio/`、`promo/`、`docs/previews/`。不碰 `src/`、`docs/` 其他目录、生成物。

## 命名与规格（冻结，见 docs/协作/接口冻结.md）
- 种族/职业/回路：`race_*.webp`、`class_*.webp`、`cir_*.webp`，512×512，RGB 或 RGBA。
- 身体部位：`part_{head,torso,arm_l,arm_r,leg_l,leg_r,skin,internal}.webp`，128×128，RGBA 真透明。
- 生物件：`bio_{heart,moss,arm,parasite,mutation,symbiosis}.webp`，512×512。
- 预览：`docs/previews/*.png`（1440×900 / 390×844），入库副本进 `promo/`。
- 风格：米纸底 + 墨线蚀刻 + 珊瑚红点缀，与既有 `race_*` 同族。

## 工作法
1. 先 `ls assets/art/generated` 看已有命名，不猜。
2. 出图后只读 1 张缩略（390 宽）判断，不读原图；不要整页截图。
3. 替换旧图前备份到 `docs/tmp/2026-11-08/art-backup-<name>-<ts>.<ext>`（未跟踪，不入库）。
4. 生成过程不写进报告，除非失败原因会影响后续。

## 验收
- `npm.cmd run check:assets` → referenced / missing 0 / errors []。
- 只 `git add` owns 内文件；提交到 `module/art-audio`，不 merge。

## 报告（≤10 行）
commit、文件列表（名+尺寸+字节）、check:assets 数字、被替换的旧文件备份路径、遗留取舍。