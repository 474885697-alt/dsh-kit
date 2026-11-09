# dsh-auto-approve

把指定工具的“审批询问”确定性地转成“本次放行”，不弹给用户，也不依赖模型审查。

## 解决什么问题

成员会话的审批策略是 `never`。`generate_comfyui`、`create_skill` 这类工具需要审批，`never` 会在请求派发前就拒绝，成员侧表现为：

```
the user rejected tool "generate_comfyui"
```

把会话改成 `ask` 能避免直接拒绝，但请求会转给用户，变成消息打扰。本插件在 `tools/pre-execute` 瀑布上包住 `next()`：先让 role-guard、cost-gate、auto-review 和工具自身的判定跑完，**只把最终的 `ask` 改成 `allow`**。审批服务因此不会被调用，`never` 无法拒绝，用户也收不到询问。

## 不会做什么

- 不覆盖 `deny`。
- 不绕过 role-guard / cost-gate：`cost-gate:` 开头的 ask 原样保留。
- 不放行危险工具（即使写进 allowlist）：`spawn_teammate`、`interrupt_agent`、`plugin_manager`、`team_approval`。
- 不写模型、不烧 token。

## 默认放行范围

```
generate_comfyui, create_skill, generate_audio
```

覆盖：art 的本地出图、copy/tools 的建技能、音频生成。cost-gate 仍会在峰时挡住对应工具。

## 配置（环境变量）

| 变量 | 作用 |
| --- | --- |
| `DSH_AUTO_APPROVE_TOOLS` | 逗号分隔，覆盖默认 allowlist；硬 deny 仍生效 |
| `DSH_AUTO_APPROVE_OFF=1` | 完全关闭 |
| `DSH_AUTO_APPROVE_AUDIT` | 审计文件路径，默认 `~/.dsh/dsh-auto-approve/audit.jsonl` |

审计每行一条：`{ts, tool, sessionTail, decision:"allowed-once", reason}`，不记参数正文、token、密钥。

## 安装

```powershell
# 桌面 profile（需重启）
dsh plugin install "link:C:\Users\03\Documents\deepseek-harness\default-workspace\plugins\dsh-auto-approve" --profile desktop
```

或用 `plugin_manager install_bundle`。副本 profile 可先验：

```powershell
dsh --profile <copy> --host 127.0.0.1 --port 6430 --no-open
```

## 验证

```powershell
node test/auto-approve.test.mjs
```

覆盖：allowlist 命中、未命中、cost-gate 保留、deny 不覆盖、硬 deny、审计行、apply 接线、关闭开关。

## 边界

- 这是“防打扰”通道，不是安全边界；`pwsh` 本身不受审批约束。
- 放行发生在代价/角色门之后，所以不会绕过它们。
- 若某工具的 ask 不是“要许可”而是“要信息”，不要加入 allowlist。
