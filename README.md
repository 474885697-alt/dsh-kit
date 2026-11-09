# dsh-kit

DSH（DeepSeek Harness）本地插件与技能合集：**16 个插件 + 12 个技能**，全部在本机实际使用中打磨，代码为纯 ESM、无运行时依赖。

- 插件：宿主侧（host-only）为主，工具 + HTTP 路由，可安装在桌面端与 headless 端。
- 技能：`SKILL.md` 标准格式，放入 `~/.dsh/skills/` 即被扫描加载。
- 许可：MIT。

## 插件

| 插件 | 作用 | 工具 |
| --- | --- | --- |
| `dsh-kit-config-sync` | 技能与插件配置快照，换机器一键恢复（本地 / Gist / HTTP），密钥自动脱敏 | `config_snapshot` `config_list` `config_push` `config_pull` `config_apply` `config_auto` `config_backend` `config_status` |
| `dsh-auto-skill` | 按任务内容自动匹配并注入最合适的技能，同会话只注入一次，可积累 `learned.md` | `skill_learn` `skill_learnings` `skill_forget` |
| `dsh-kit-guardian` | 清单体检 + 崩溃归因 + 备份 / 回滚 | `plugin_health` `plugin_backup` `plugin_rollback` |
| `dsh-secret-audit` | 扫明文密钥，结果始终打码 | `secret_scan` |
| `dsh-kit-novel-studio` | 小说设定库 + 连续性校验 | `novel_book` `novel_upsert` `novel_context` `novel_check` |
| `dsh-prose-polish` | 中文润色面板（流式）+ 润色工具 | `polish_text` |
| `dsh-project-checkup` | 项目体检，检查项写在 `dsh-checkup.json` | —（路由 `/scan`） |
| `dsh-audio-post` | ffmpeg 后期：转码、响度、静音裁剪、预设、批量 | `audio_info` `audio_convert` `audio_preset` `audio_batch` |
| `dsh-rulebook` | 规则书（docx/txt/md）→ 结构化 JSON + 校验 | `rulebook_extract` `rulebook_check` |
| `dsh-build-ship` | 构建 → 收集产物 → 校验哈希 → 出报告 | `ship_build` `ship_collect` `ship_run` |
| `dsh-kit-ai-gateway` | 本机密钥池，按用量轮询借出（仅 loopback） | `gateway_keys` `gateway_pick` `gateway_usage` |
| `dsh-kit-session-hygiene` | 会话统计 / 归档 / 删除（默认演练） | `session_report` `session_archive` `session_delete` |
| `dsh-comfyui` | 本机 ComfyUI / SDXL 生图工作台（提交工作流、轮询、管理输出） | `generate_comfyui` |
| `dsh-cost-gate` | 派活前的成本闸门：峰谷估价、阈值拦截、限时放行 | `cost_gate` |
| `dsh-round-triage` | 回合结束按规则归类新文件，只移动安全、未跟踪的新文件 | `round_triage` |
| `dsh-team-ops` | 团队工单板、10 角色、审批门、QQ 回执与待答队列 | `team_task_*` `team_approval` `team_pending_*` |

每个插件目录里都有中文 `README.md`：工具参数、路由、配置、数据位置、安全边界、验收方式。

## 技能

| 技能 | 用途 |
| --- | --- |
| `dsh-plugin-authoring` | 写 DSH 插件的脚手架与四条硬规则（避免拖垮启动） |
| `dsh-plugin-safety` | 装 / 启用 / 卸载插件前的安全检查与故障归因 |
| `windows-quiet-pc` | 风扇狂转、噪音大的取证与降噪 |
| `windows-unblock-files` | 解除下载文件的「来自其他计算机」标记 |
| `game-rulebook-to-code` | 规则书 → 可玩系统的建模流程 |
| `cost-gate` | 派活 / 生成前的成本估算与峰谷拦截规则 |
| `novel-prose` | 小说逐章执笔的写作技法 |
| `seeker-art-audio-assets` | 《寻神者》美术 / 音频素材规范与省 token 流程 |
| `seeker-copy-world` | 《寻神者》文案 / 世界观模块流程 |
| `seeker-mechanics-dev` | 《寻神者》机制与系统模块地图 |
| `seeker-module-worker` | 《寻神者》模块 worktree 的省 token 工作法 |
| `seeker-quick-check` | 《寻神者》项目常驻快检 |

说明：本机另有 dsh-audiogen 自带的音色/音乐/音效技能，以及从插件市场安装的第三方技能，**不在本仓库**，避免与上游重复或版权混淆。

## 安装

插件（本地目录方式，推荐先用副本 profile 试）：

```powershell
dsh plugin install "link:C:\path\to\dsh-kit\plugins\dsh-kit-config-sync" --profile desktop
```

或用 DSH 的 `plugin_manager install_bundle`（需要目标机器上已有该目录）。

技能：

```powershell
Copy-Item -Recurse .\skills\dsh-plugin-safety "$env:USERPROFILE\.dsh\skills\"
```

## 目录

```
plugins/   16 个插件（各自独立 npm 包，可单独发布）
skills/    12 个技能
catalog/   插件市场目录条目草稿（按官方 index.json 结构）
scripts/   本机同步脚本
```

## 同步本机新增内容

1. 新插件放进工作区 `plugins/<name>/`（team-ops 例外：`tools/team-ops-plugin`）。
2. 新技能放进 `%USERPROFILE%\.dsh\skills\<name>\`。
3. 把名字加进 `sync-manifest.json` 的 `plugins` / `skills` 数组。
4. 运行：

```powershell
$env:GH_TOKEN = '<你的 token>'   # 不要写进任何文件
powershell -ExecutionPolicy Bypass -File .\scripts\sync-local-kit.ps1
```

脚本只复制清单内的目录（跳过 `node_modules` / `.git`），提交并推送；token 只从环境变量读取或交互输入，不落盘。

## 发布状态

- GitHub：本仓库
- npm：`npm publish`（在 `plugins/<name>` 目录内执行）后可被插件市场收录
- 技能市场：SkillHub / ClawHub 需要各自账号 token
