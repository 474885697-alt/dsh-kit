# dsh-kit-config-sync

> 把技能与插件配置打包成快照，换台电脑一键恢复；密钥自动脱敏。

版本 0.1.0 ｜ 包名 `dsh-kit-config-sync` ｜ 仅宿主侧（无客户端代码）｜ MIT

## 它解决什么问题

换机器最痛的是重装技能、重新对一遍插件清单。这里把 `~/.dsh/skills` 与 profile 的 `package.json` / `cordis.patch.yml` 一起打包。

三层脱敏：键名匹配（`api_key`/`token`/`secret`…）、`channelSecrets:` 这类嵌套块、以及值形状（`sk-…`、`ghp_…`、Bearer、≥48 字符不透明串）。

后端三选一：`local`（本机）、`gist`（GitHub Gist，跨设备最省事）、`http`（自建服务）。

恢复永远默认演练，`apply:true` 才写文件；写前备份、写后校验，失败自动回滚。

## 安装

```powershell
plugin_manager install_bundle target="C:/Users/03/Documents/deepseek-harness/default-workspace/plugins/dsh-kit-config-sync"
```

装完即可用，工具会出现在工具列表里；用 `plugin_health` 可以体检清单。要卸载就用插件页的开关。

## 工具

| 工具 | 用途 | 参数（`*` 表示必填，`?` 表示可选） |
| --- | --- | --- |
| `config_snapshot` | 把本机技能与插件配置打包成快照（自动脱敏），并按配置推送 | `note?` string<br>`profile?` string |
| `config_list` | 列出本机保存过的快照 | `limit?` number |
| `config_push` | 把指定快照推送到当前后端（local / gist / http） | `id?` string<br>`create?` boolean<br>`note?` string<br>`profile?` string |
| `config_pull` | 从当前后端拉取最新快照（不落盘），返回摘要 | — |
| `config_apply` | 把快照恢复到本机（默认演练，apply=true 才写入） | `id?` string<br>`apply?` boolean<br>`apply_patch?` boolean<br>`force?` boolean<br>`profile?` string |
| `config_auto` | 开关自动快照与检查间隔（≥60 秒） | `enabled?` boolean<br>`interval_sec?` number |
| `config_backend` | 配置同步后端：local / gist / http 及其凭据 | `backend?` string<br>`gist_token?` string<br>`gist_id?` string<br>`http_url?` string<br>`http_token?` string |
| `config_status` | 查看同步状态：后端、自动快照、快照数、技能数 | — |

### 用法示例

**示例：本机快照**

```
config_snapshot(note="装完 9 个插件")
# → { id: "2026-11-07T14-21-50-018Z", skills: 21, bundles: 43, redactions: ["minimax"] }
```

**示例：换机器恢复**

```
config_backend(backend="gist", gist_token="ghp_…")
config_snapshot()                # 推送当前机器
# 另一台机器：
config_pull()                    # 看会恢复什么
config_apply(apply=True)         # 真正写入（技能已存在会跳过）
```

## HTTP 路由（仅本机 loopback）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/dsh-kit-config-sync/status` | 当前后端、自动快照开关、快照数量 |
| GET | `/api/dsh-kit-config-sync/list` | 快照清单（id/时间/备注/技能数） |
| GET | `/api/dsh-kit-config-sync/latest` | 最新快照摘要（先拉远端再返回） |
| POST | `/api/dsh-kit-config-sync/snapshot` | `body:{"note":"…"}`，立即生成快照 |
| POST | `/api/dsh-kit-config-sync/apply` | `body:{"apply":false}`，默认演练；`apply:true` 才真正写入 |

## 配置

- 配置文件：`~/.dsh/dsh-kit-config-sync/config.json`，默认 `{ backend:"local", autoEnabled:true, autoIntervalSec:300 }`。
- `config_auto(enabled, interval_sec)`：间隔 ≥60 秒，指纹没变就跳过，非 local 后端会自动推送。
- `config_apply` 的 `apply_patch=true` 才会覆盖 `cordis.patch.yml`（其中密钥是 `<redacted>` 占位符，恢复后要自己补）。

## 数据存在哪

- 快照：`~/.dsh/dsh-kit-config-sync/snapshots/<ISO>.json` 与 `latest.json`（含技能全文时会到 MB 级）。
- Gist 模式下首次推送会把 `gistId` 回写到配置。

## 安全边界

- 密钥三层脱敏；快照里出现 `<redacted>` 是正常的。
- 恢复前备份 `package.json.manual-<时间戳>`，写后 JSON 校验失败自动回滚。
- 技能目录已存在默认跳过（防覆盖你自己改过的技能），要覆盖必须 `force:true`。
- HTTP 路由只允许 loopback。

## 已知行为

- 快照包含技能正文，文件会比较大（本机实测 1.76 MB）；不想带正文可只存元数据（后续可加开关）。

## 验收

- 假 ctx 单测 17/17；临时 DSH_HOME 恢复测试 21 个技能全部落盘、二次 apply 全跳过；真宿主 5 条路由与 POST 均 200。

## 宿主兼容性

- Web / 桌面宿主：HTTP 路由与工具都可用。
- headless / CLI（没有 webServer 服务）：路由自动跳过，工具照常注册。
