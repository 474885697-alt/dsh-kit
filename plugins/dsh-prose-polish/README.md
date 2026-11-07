# dsh-prose-polish

> 中文文本润色：保事实、去 AI 味、按模式改写，附侧栏面板与流式输出。

版本 0.1.0 ｜ 包名 `dsh-prose-polish` ｜ 仅宿主侧（无客户端代码）｜ MIT

## 它解决什么问题

润色最容易犯的错是「改着改着把剧情改了」。这里把规则写死：只改表达，不新增事实、人物、视角。

五种模式各管一件事：`novel`（小说正文）、`tighten`（收紧）、`expand`（扩写）、`hook`（强化开头/章末）、`copy`（通用文案）。

面板在左栏「✎实时润色」：粘贴文本 → 选模式/力度 → 流式看到逐字结果 → 复制，或写回面板自己的文本框（不碰对话栏）。

## 安装

```powershell
plugin_manager install_bundle target="C:/Users/03/Documents/deepseek-harness/default-workspace/plugins/dsh-prose-polish"
```

装完即可用，工具会出现在工具列表里；用 `plugin_health` 可以体检清单。要卸载就用插件页的开关。

## 工具

| 工具 | 用途 | 参数（`*` 表示必填，`?` 表示可选） |
| --- | --- | --- |
| `polish_text` | 润色一段中文小说或文案（保事实、去 AI 味、按模式改写） | `text` string<br>`mode?` `novel` / `tighten` / `expand` / `hook` / `copy`<br>`strength?` `light` / `medium` / `deep`<br>`style?` string<br>`instruction?` string<br>`max_tokens?` integer |

### 用法示例

**示例：工具调用**

```
polish_text(text="雨下得很大。他走进码头，看见灯还亮着。", mode="novel", strength="light", style="黑暗奇幻、第三人称限知")
# → "他走进码头。雨很大，斜着抽在水泥地上。灯还亮着。"
```

**示例：HTTP（SSE）**

```
POST /api/dsh-prose-polish/optimize
{"text":"…","mode":"novel","strength":"light","stream":true}
# event: start → event: delta {"text":"雨"} … → event: done {"ok":true,"text":"…"}
```

## HTTP 路由（仅本机 loopback）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/dsh-prose-polish/config` | 返回模式、力度、规则说明，供面板渲染 |
| POST | `/api/dsh-prose-polish/optimize` | 润色接口，`stream:true` 时用 SSE 逐字返回（`event: start/delta/done/error`） |
| POST | `/api/dsh-prose-polish/diag` | 客户端启动探针（记录挂载到哪一步） |
| GET | `/api/dsh-prose-polish/health` | 健康检查，同时回显当前使用的 provider / model |

## 配置

- 模型来源：读设置里的 `agent-default-model`（provider + model），没有配置就会在 `/health` 里报 `provider:null`。
- 请求参数：`temperature`、`maxTokens`（工具参数 `max_tokens` 可覆盖）、`style`（风格提示）、`instruction`（额外指令）。

## 数据存在哪

- 面板状态只存内存；启动探针写入 `~/.dsh/prose-boot.log`（可用 `POST /api/dsh-prose-polish/diag` 查看）。

## 安全边界

- 路由只接受 loopback（127.0.0.1 / ::1）。
- 改写结果不会自动写进会话，只有你点「替换原文」才写回面板自己的 textarea。
- 客户端挂载用有界轮询（800ms、最多约 2 分钟）+ 整体 try/catch，失败不会拖死界面。

## 已知行为

- 需要 DSH 里已配置可用的默认模型；没有凭据时返回明确错误而不是空结果。

## 验收

- 亲测非流式与 SSE 两条路径；面板流式逐字输出正常。

## 宿主兼容性

- Web / 桌面宿主：HTTP 路由与工具都可用。
- headless / CLI（没有 webServer 服务）：路由自动跳过，工具照常注册。
