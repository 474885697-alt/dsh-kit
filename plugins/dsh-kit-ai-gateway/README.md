# dsh-kit-ai-gateway

> 本机 API Key 池：统一存放、按用量轮询、只在本机借出。

版本 0.1.0 ｜ 包名 `dsh-kit-ai-gateway` ｜ 仅宿主侧（无客户端代码）｜ MIT

## 它解决什么问题

多个 Key（DeepSeek / OpenAI / MiniMax / ElevenLabs…）散在配置文件里，用哪个全凭记忆。

这里集中存一份 `keys.json`（权限 600），每次 `gateway_pick` 借出**该 provider 下用得最少**的 Key，并把计数加一，方便观察配额消耗。

列表默认打码，`show_secrets` 才显示完整 Key——建议只在确认本机安全时用。

## 安装

```powershell
plugin_manager install_bundle target="C:/Users/03/Documents/deepseek-harness/default-workspace/plugins/dsh-kit-ai-gateway"
```

装完即可用，工具会出现在工具列表里；用 `plugin_health` 可以体检清单。要卸载就用插件页的开关。

## 工具

| 工具 | 用途 | 参数（`*` 表示必填，`?` 表示可选） |
| --- | --- | --- |
| `gateway_keys` | Key 池管理：查看（打码）/ 添加 / 移除 / 启用 / 禁用 | `action` `list` / `add` / `remove` / `enable` / `disable`<br>`id?` string<br>`key?` string<br>`provider?` string<br>`label?` string<br>`baseUrl?` string<br>`model?` string<br>`show_secrets?` boolean |
| `gateway_pick` | 借出该 provider 下最久未用的 Key，并把用量加一 | `provider?` `deepseek` / `openai` / `minimax` / `elevenlabs` / `stability` / `custom` |
| `gateway_usage` | 按 provider 查看 Key 数量与用量 | — |

### 用法示例

**示例：加 Key → 借 Key**

```
gateway_keys(action="add", provider="deepseek", key="sk-…", label="主号")
gateway_pick(provider="deepseek")   # → { key: "sk-…", id: "…", used: 1 }
```

**示例：看用量**

```
gateway_usage()
# → { providers: { deepseek: { keys: 2, used: 14 } } }
```

## HTTP 路由（仅本机 loopback）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/dsh-kit-ai-gateway/pick` | `body:{"provider":"deepseek"}`，借出一个最久未用的 key |
| GET | `/api/dsh-kit-ai-gateway/status` | key 数量与用量计数（不含明文） |

## 配置

- 无需配置；数据在 `~/.dsh/dsh-kit-ai-gateway/keys.json`（写入时 `chmod 600`）。

## 数据存在哪

- 同上；计数与 Key 存在同一份 JSON。

## 安全边界

- 列表/状态接口一律打码；只有显式 `show_secrets:true` 才返回明文，且仅在本机工具调用里。
- HTTP 路由只允许 loopback，`/pick` 需要 POST。
- 不校验 Key 是否有效、不联网测试——它只是本地仓库。

## 已知行为

- `gateway_pick` 在某个 provider 没有启用中的 Key 时返回 404。

## 验收

- 假 ctx 单测覆盖增删改查与轮询；真宿主 `/status` 200，用量计数正确。

## 宿主兼容性

- Web / 桌面宿主：HTTP 路由与工具都可用。
- headless / CLI（没有 webServer 服务）：路由自动跳过，工具照常注册。
