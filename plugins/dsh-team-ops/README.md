# dsh-team-ops 0.3.4

把团队协作里的四件事做成 DSH 宿主插件：**成员角色定义**、**QQ 回执投递**、**团队状态快照页**、**最终回答镜像**，外加四个快捷工具。流程规则（谁批准、用户确认门、qa 验收）不在这里，仍在 `docs/中枢` 与 `docs/协作`。

## 成员角色（0.3.1）

> **角色定义唯一来源是 `lib/roles.cjs`**：改角色（职责、边界、写域、权限）只改这一处，README、status、命令都从它读取，不要复制角色表。

10 个角色：`lead`、`hub`、`mechanics`、`art-audio`、`copy`、`tools`、`test`、`bug`、`qa`、`online`。每个角色含 `id / label / description / systemPrompt / writeScopes / reads / canSpawn / canMerge / canAccept / defaultModel / constraints`；`canSpawn`/`canMerge`/`canAccept` 仅 lead 为 true，`defaultModel` 统一 `deepseek-flash`。数据来自 `docs/协作/成员与模块.md` 与 `module.config.json`，`ROLES` 已 `Object.freeze`，`getRole(id)` 未知返回 `null`。

## 工单审批门（0.3.2）

> 目的：用户还没明确同意时，不允许建卡/派发。审批单是唯一依据，状态 `pending → approved → rejected/withdrawn`。

- `team_approval` 工具：`request` 记录用户原话摘要/时间/来源并生成 `approvalId`（默认 24h 有效期）；`list`/`get` 查询；`approve`/`reject`/`withdraw` 只允许 Lead 会话调用（`DSH_TEAM_OPS_LEAD_SESSION`）。
- `tools/pre-execute` 拦截 `team_task_create`：`description` 必须同时含 `approvedByUser: true` 与有效 `approvalRef: apv-...`；缺失、pending、驳回、撤回、过期都拒绝，并通过 `displayReason` 给出原因。
- 放行/拒绝都写审计日志（`DSH_TEAM_OPS_APPROVAL_AUDIT`，默认 `docs/tmp/team-ops-approvals-audit.jsonl`），含 `approvalId`。
- 未 approved 时只能写分析单草稿，不要调用 `team_task_create`；撤回 approval 后立即失效。

## 提问卡与待答队列（0.3.4）

> 用途：Lead 需要用户确认时发一张提问卡（2–4 个选项 + 截止时间），回答后自动写回审批单状态。

- `/提问 摘要 | 选项1 | 选项2 [| 选项3] [| 选项4] [--分钟 30] [--approval apv-...]`：仅 Lead 会话可发起；生成 `q-xxxxxx` 待答 id（同一 approvalId + 同问题 + 同选项去重）。
- `/回答 <id> <选项序号或文本>`：仅 Lead 会话可回答；选项 1 写回 `approved`、最后一项写回 `rejected`，中间项只记录；重复回答同选项幂等。回答前先校验审批单有效态，审批已过期/已驳回时拒绝，问题状态与审批单都不变。
- `/待答`：待答表（id/摘要/剩余时间/状态）；到期自动标 `expired`，并只提醒一次。
- `/关闭 <id>`：仅 Lead；关闭并写回 `withdrawn`。
- 回执纪律：拿到平台 `messageId` 才算送达；发送失败时 `delivery.mode='pending'` 并附 `error`，不声称已送达。

**0.3.4 安全修正**：`/回答` 与 `/提问`、`/关闭` 同门，仅 Lead 会话可调用；HTTP `command` 路由不再信任 `body/query` 里的 `sessionId`，只有携带 `x-team-ops-token`（`DSH_TEAM_OPS_BRIDGE_TOKEN`）的桥接请求才会注入身份，否则一律按无人会话处理（特权命令 403）。

## 重启候选清单（A-lite，0.3.4）

- 只读扫描 `docs/tmp/team-status.json`（任务板快照）与可选的 `docs/tmp/team-ops-handoff.json`，输出 `docs/tmp/team-ops-resume-candidates.json`；每项含 `sessionId / lastTurnId / taskId / owner / reason / blockedBy / recommendedAction`。
- 去重键 `sessionId + lastTurnId`；没有 session 映射时字段写 `null`，并在 `sources.sessionMapping` 里注明来源不足，不猜。
- `blocked` 任务只标 `recommendedAction: needs-human`，不得列为可续。
- **不是自动恢复**：不 spawn 进程、不跑 turn、不发 QQ；真实续跑仍需用户/Lead 手动 `dsh --profile headless --session-id <id>`。
- 路由 `GET /api/team-ops/resume-candidates` 只读、仅 loopback，不写盘；写文件用 `resumeCandidates.writeResult(resumeCandidates.scan())`（带文件锁）。

## 能力

| 类型 | 名称 | 说明 |
| --- | --- | --- |
| 路由 | `GET /api/team-ops/health` | `{ok,name,version,time,qq,mirror}`，仅 loopback；QQ 配置缺失时 503 |
| 路由 | `GET /api/team-ops/status` | 渲染团队状态页；`?format=json` 返回汇总 JSON（含 `roles:{count,ids}` 与 `allowlist`） |
| 路由 | `GET /api/team-ops/mirror` | 镜像状态：发送/失败/跳过原因、最近 messageId、状态文件 |
| 路由 | `GET /api/team-ops/resume-candidates` | A-lite 重启候选只读清单（仅 loopback；不写盘、不 spawn、不发 QQ） |
| 路由 | `GET /api/team-ops/roles` | `{count:10,roles:[...]}`；`?full=1` 返回完整字段 |
| 路由 | `GET /api/team-ops/roles?id=hub` | 查询式单角色；未知 id 404；仅 loopback |
| 路由 | `GET /api/team-ops/roles/hub` | 路径式单角色（10 条 exact 路由）；未知 id 由 prefix 兜底 404；仅 loopback |
| 路由 | `GET\|POST /api/team-ops/command` | 入站快捷命令：`/状态 /队列 /任务 /角色 /待批 /汇总 /提问 /回答 /待答 /关闭 /帮助`（`?text=` 或 `{"text":"...","sessionId":"..."}`；`/提问`、`/关闭` 需要 Lead 的 `sessionId`） |
| 工具 | `team_status` | 读快照并汇总；`write=true` 时刷新 `docs/team-status/index.html` |
| 工具 | `qq_notify` | 仅 Lead 会话可调用；发一条 QQ 消息，非 Lead/未配置白名单返回 403 且不投递；`dryRun=true` 只预演 |
| 工具 | `team_mirror` | 读镜像状态（只读，不触发发送） |
| 工具 | `team_approval` | 审批单 request/list/get + Lead 专用 approve/reject/withdraw；`team_task_create` 由 pre-execute 门强制校验 |

投递顺序：优先 `POST {DSH_WEB_URL}/api/dsh-im/delivery/messages`，失败回退 QQ SDK 直发（被动回复需要最近一条入站消息 id）。每次投递写 `docs/tmp/qq-delivery-log.jsonl`。

## 安装（本地 link）

本包自带 `cordis.patch.yml`，可作为 bundle 安装。本机验证时不要直接改桌面 profile：

```powershell
# 1) 用插件页 / plugin_manager 安装（link 到本目录）
#    target 用包名 dsh-team-ops，来源为本目录的 link
# 2) 启用后重启宿主，确认插件页出现 dsh-team-ops
# 3) 验证路由（loopback）
curl.exe http://127.0.0.1:<port>/api/team-ops/health
```

手工安装时清单三处需一致（`dependencies` 的 `link:`、`dsh.profile.bundles`、`cordis.patch.yml` 的 `- id: team-ops`）。改清单前先备份，且一次只装一个。

## 配置（全部走环境变量，不写仓库）

| 变量 | 默认 | 用途 |
| --- | --- | --- |
| `DSH_TEAM_ROOT` | 本包向上三级 | 团队仓库根（快照、日志、状态页输出） |
| `DSH_TEAM_SNAPSHOT` | `<ROOT>/docs/tmp/team-status.json` | 快照路径 |
| `DSH_QQ_DELIVERY_LOG` | `<ROOT>/docs/tmp/qq-delivery-log.jsonl` | 投递日志 |
| `DSH_WEB_URL` | `http://127.0.0.1:64595` | dsh-im HTTP 基址 |
| `DSH_QQ_DELIVERY_URL` | 由 `DSH_WEB_URL` 派生 | 直接覆盖投递端点 |
| `DSH_QQ_OPENID` / `DSH_QQ_APP_ID` | 必填（无默认） | QQ 目标 openid 与 AppID；缺失时发送直接报错 |
| `DSH_QQ_SECRET_REF` | 必填（无默认） | 凭据文件里的密钥引用名 |
| `DSH_QQ_CREDENTIALS` | `~/.dsh/.credentials.yaml` | 凭据文件路径 |
| `DSH_QQ_STATE` / `DSH_QQ_SDK` | `~/.dsh/integrations/dsh-qq/bots/<botId>/state.json` / 桌面 profile 的 qqbot SDK | 被动回复状态与 SDK 路径 |
| `DSH_TEAM_OPS_DRY_RUN` | 未设置 | `1` 时镜像不联网，发送返回 `dry-<sha1>` 并照常记状态 |
| `DSH_TEAM_OPS_LEAD_SESSION` | 未设置 | **唯一白名单**：只有该会话 id 的最终回答会发 QQ；未设置时全部跳过（默认拒绝） |
| `DSH_TEAM_OPS_MIRROR_STATE` | `<ROOT>/docs/tmp/team-ops-mirror.json` | 镜像状态文件 |
| `DSH_TEAM_OPS_MIRROR_LOG` | `<ROOT>/docs/tmp/team-ops-mirror.jsonl` | 镜像日志 |
| `DSH_TEAM_OPS_APPROVALS` | `<ROOT>/docs/tmp/team-ops-approvals.json` | 审批单状态文件 |
| `DSH_TEAM_OPS_APPROVAL_AUDIT` | 同目录 `team-ops-approvals-audit.jsonl` | 审批审计日志（含 approvalId） |
| `DSH_TEAM_OPS_QUESTIONS` | `<ROOT>/docs/tmp/team-ops-questions.json` | 提问卡/待答状态文件 |
| `DSH_TEAM_OPS_BRIDGE_TOKEN` | 未设置 | `command` 路由的桥接 token；未设置时 HTTP 不注入任何 `sessionId`（body/query 里的身份被忽略） |

`DSH_QQ_OPENID` / `DSH_QQ_APP_ID` / `DSH_QQ_SECRET_REF` 均为必填、无回落值：缺失时 SDK 直发返回 `missing required QQ config: ...`，不会使用任何真实账号。

密钥只从凭据文件读取，插件与日志都不保存明文；`docs/tmp/qq-delivery-log.jsonl` 只存 80 字符预览。

## 最终回答镜像（0.2.0）

宿主加载本插件并重启后生效（本包不自动安装/重启）：

- 监听 `ctx.on('session/event')`：`assistant/message` 缓冲本回合的 `text` 块；`turn/end` 且 `reason.kind === 'completed'` 时把最终回答直发 owner。
- 发送走 QQ SDK（`messageApi.sendMessage('c2c', openid, ...)`），**必须拿到平台 `messageId`** 才算成功；失败重试 1 次（间隔 1.5s），仍失败记 `mirror.failures` 与日志。
- 白名单（2026-11-08 硬规则）：**只镜像 `DSH_TEAM_OPS_LEAD_SESSION` 指定的 Lead 会话**；未设置或 sessionId 不匹配时一律跳过（默认拒绝，其他成员/中枢/子会话绝不发 QQ）。`/health`、`/mirror` 与 `/status?format=json` 都返回 `leadSessionConfigured` / `leadSessionTail` 供核对。
- 防回环：已绑定 IM 的会话跳过（`dsh-im/session-pre-bind` 或 `ctx.get('dshIm').describeConversationSync()` 命中），交给 dsh-im 的 sessionSync 回发；`origin === 'subagent'` 或带 `parentSession` 的子会话默认不镜像。
- 去重：键为 `sessionId:turn`，成功发送后写入状态文件，重复的 `turn/end` 不会重发。
- 限制：单条上限 4,000 字符、按 1,800 字符分片；只发 `text`，不发 `reasoning`；**QQ 入站的自动回复不归本插件**。
- 状态：`docs/tmp/team-ops-mirror.json`（发送数/失败数/跳过原因/最近 messageId，原子写）；日志：`docs/tmp/team-ops-mirror.jsonl`。
- 心跳：`GET /api/team-ops/health` 与 `/mirror` 的 `mirror.updatedAt / sends / failures / lastMessageId` 可判断镜像是否在跑；没有独立的外部心跳包。

入站快捷命令（供桥接脚本调用，不直接连 QQ）：

```powershell
curl.exe "http://127.0.0.1:<port>/api/team-ops/command?text=/状态"
curl.exe -X POST -H "content-type: application/json" -d '{\"text\":\"/任务\"}' http://127.0.0.1:<port>/api/team-ops/command
```

## 5 行报告（C05）

最终回答、镜像发送与 hub 汇总统一使用 5 行格式：

```
结论：一句话结论
交付：改了什么/产出了什么
证据：命令、数字或文件
需审核：需要用户确认的事项（无则写“无”）
遗留：未做项或风险（无则写“无”）
```

- 固定段顺序；缺段、乱序、空段或超过 8 行都会被拒绝，返回 `{code,message,totalLines,missing}`，不静默截断。
- 镜像只发通过校验的文本；不合格计入 `mirror.skippedFormat` 与 `lastFormatError`，日志事件 `mirror-skip-format`。
- `/汇总` 无参数时用快照 + 待批生成 5 行；带参数时校验并回显结果。
- 校验与生成在同一模块 `lib/report.cjs`（`validate` / `formatReport`），hub 汇总复用同一份格式。

## 兼容的 CLI

`tools/qq-delivery.cjs`、`tools/qq-notify.cjs`、`tools/team-status.cjs` 保留为薄封装，参数、输出与退出码不变：

```powershell
node tools/qq-notify.cjs --dry-run "文本"
node tools/qq-notify.cjs --status
node tools/team-status.cjs --snapshot docs/tmp/team-status.json
node tools/team-status.cjs --print
```

## 卸载

在插件页停用并移除 `dsh-team-ops`，然后重启宿主；本包不写 profile 之外的状态。删掉 `docs/team-status/index.html` 与 `docs/tmp/qq-delivery-log.jsonl` 即可清掉产物。

## 不做什么

- 不在插件里自动派发任务或修改任务板。
- 不内置 openid / AppID / secret；不把密钥写进日志。
- 不含客户端 bundle（状态页用 host 路由 + 30s 自动刷新；后续如需侧边栏入口再加）。
- QQ 入站消息的自动回复由 dsh-im sessionSync 负责；本插件对已绑定会话静默，避免双发。
- 安装、启用、重启宿主都不由本包自动进行。
