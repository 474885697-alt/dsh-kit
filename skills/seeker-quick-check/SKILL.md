---
name: seeker-quick-check
description: 《寻神者》项目常驻快检。改动后先跑 dsh-project-checkup 的 quick（语法/服务/素材），需要时加 full（UI 审计与数据检查）；检查项只在 dsh-checkup.json 维护。
version: 0.1.0
source: local
updated: 2026-11-09
---

# 寻神者快检（薄封装）

唯一执行源是 `dsh-project-checkup` 的 `scan()`。**所有检查项只维护项目根的 `dsh-checkup.json`**（`quick` / `full` 两个数组）；本技能不复制清单、不写第二套检查逻辑。

## 1. 跑

在寻神者检出根目录执行：

```powershell
node C:\Users\03\.dsh\skills\seeker-quick-check\quick.mjs          # quick：1–3 分钟最小体检
node C:\Users\03\.dsh\skills\seeker-quick-check\quick.mjs --full   # full：追加 UI 审计与数据检查
node C:\Users\03\.dsh\skills\seeker-quick-check\quick.mjs --json   # 原始 JSON（给脚本/对比用）
```

- 插件定位：从 cwd 向上找 `plugins/dsh-project-checkup`；也可以 `--plugin <插件目录>` 或环境变量 `DSH_PROJECT_CHECKUP_PLUGIN`。
- 退出码：任一项 `fail`/`error` → 1；`warn`/`skip` 不算失败。
- 输出：每项一行 `[status] id · 标签 — 详情`，末尾是计数与项目路径。

## 2. 改检查项

只改 `dsh-checkup.json`：

- `quick`：每次改动后的最小体检（存在性、语法、本地服务、素材数量等）。
- `full`：需要更多时间或外部条件的检查（UI 审计、数据文件、残留扫描）。

改完用 `quick.mjs --json` 核对 id 与结果；不要在本文档或脚本里再写一份清单。

## 3. full 里的寻神者特有部分

`full` 的 `ui-audit` 项会跑 `tools/ui-audit.cjs --strict`（需要本地服务；新增区块/弹窗/固定控件时必跑）：

- 三档 1440×900、390×844、320×720 必须全部 PASS，退出码 0。
- 覆盖：关键容器横向溢出、固定控件出屏/相交、弹窗超视口或不可滚动、模式卡状态被裁、320 账号表单顺序、页面异常。
- 新增弹窗/固定层后同步 `tools/ui-audit.cjs` 的 `modals` 与固定选择器列表，否则新内容不在审计范围内。

UI 契约（full 审阅时对照）：

- 弹窗高度只用 `calc(var(--ui-vh, 100vh) - …)`，不写裸 `vh`。
- 固定控件只占左下（缩放/DEV）、右上（功能）、顶部（快速定位）三个锚点之一，不用 `z-index` 压旧控件。
- 新横向区块必须有内部滚动容器；320 下导航用短标签或内部滑动。
- 模式卡编号/标题/描述/状态完整落在卡片内；新页面同时接入桌面四列、≤760px 两列、≤340px 短标签与 `data-action`。
- 修改过的面板截图留证到 `docs/previews/`。

## 4. 输出

短清单：

- 通过项：命令/页面/数量（用 wrapper 的计数与 ids）。
- 失败项：id、详情、复现命令、修复建议。
- 不能确认的项写“未验证”，不写“应该没问题”。

## 5. 边界

- 不改业务代码，只诊断并给最小修复建议。
- 不重启用户正在使用的桌面 DSH；需要重启时先说明原因。
- 不删除用户数据；测试账号/测试店铺先确认可回滚。
