# dsh-secret-audit

> 扫本地工作区的明文 API Key，输出永远打码。

版本 0.1.0 ｜ 包名 `dsh-secret-audit` ｜ 仅宿主侧（无客户端代码）｜ MIT

## 它解决什么问题

Key 常常散落在配置文件、脚本、笔记里，自己都忘了哪份带明文。

识别 DeepSeek / OpenAI / GitHub / AWS / Bearer / 赋值语句，并额外识别 `ai-configs.json` 这类「Key 共享」配置，汇总每个 Key 的 `shareMode`。

结果只保留前 6 后 4，聊天记录和日志里都不会出现完整 Key。

## 安装

```powershell
plugin_manager install_bundle target="C:/Users/03/Documents/deepseek-harness/default-workspace/plugins/dsh-secret-audit"
```

装完即可用，工具会出现在工具列表里；用 `plugin_health` 可以体检清单。要卸载就用插件页的开关。

## 工具

| 工具 | 用途 | 参数（`*` 表示必填，`?` 表示可选） |
| --- | --- | --- |
| `secret_scan` | 扫描工作区里的明文 API Key 与 Key 共享配置（结果始终打码） | `roots?` string |

### 用法示例

**示例：扫默认范围**

```
secret_scan()
# → { scanned: 15, findings: [{ file, line, kind: "deepseek", masked: "sk-a1c***37cd" }], sharedConfigs: [...] }
```

**示例：只扫某个目录**

```
secret_scan(roots="C:/proj/data,C:/proj/config")
```

## HTTP 路由（仅本机 loopback）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/dsh-secret-audit/scan` | `?roots=a,b`，扫描明文密钥（结果始终打码） |

## 配置

- 无需配置；默认根目录 = 当前工作目录 + `~/.dsh`。

## 数据存在哪

- 不落盘，只在返回里给路径/行号/打码值。

## 安全边界

- 跳过 `node_modules`、`.git`、`dist`；只读 ≤2 MB 的文本文件。
- 输出始终打码，不提供「显示明文」的开关。
- 在 git 仓库内的命中会标记 `gitExposed`（提醒你它可能已经被提交）。

## 已知行为

- 16 进制长串会被当成 `assigned` 类命中，可能包含非密钥的哈希值，需要人工判断。

## 验收

- 扫 `data` 目录 15 个文件命中 13 处，全部打码；两个 Key 的 `shareMode` 均为 `closed`。

## 宿主兼容性

- Web / 桌面宿主：HTTP 路由与工具都可用。
- headless / CLI（没有 webServer 服务）：路由自动跳过，工具照常注册。
