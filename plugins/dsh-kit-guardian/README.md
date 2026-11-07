# dsh-kit-guardian

> DSH 清单体检 + 备份 + 回滚：装插件炸掉之前先看一眼。

版本 0.1.0 ｜ 包名 `dsh-kit-guardian` ｜ 仅宿主侧（无客户端代码）｜ MIT

## 它解决什么问题

插件清单坏一次，应用就连启动界面都进不去（裸 `JSON.parse` 直接抛错）。这三件事能在 30 秒内把状态说清楚。

体检覆盖：BOM / 尾逗号、`dependencies` 与 `bundles` 不一致、bundle 是否可解析、`cordis.patch.yml` 孤立行、最近启动崩溃。

备份与回滚都先校验清单 JSON，坏文件不会覆盖好文件。

## 安装

```powershell
plugin_manager install_bundle target="C:/Users/03/Documents/deepseek-harness/default-workspace/plugins/dsh-kit-guardian"
```

装完即可用，工具会出现在工具列表里；用 `plugin_health` 可以体检清单。要卸载就用插件页的开关。

## 工具

| 工具 | 用途 | 参数（`*` 表示必填，`?` 表示可选） |
| --- | --- | --- |
| `plugin_health` | 体检 profile：清单 JSON、依赖与 bundles 一致性、孤立补丁行、最近崩溃 | `profile?` string |
| `plugin_backup` | 备份 profile 的 package.json 与 cordis.patch.yml，返回备份 id | `profile?` string |
| `plugin_rollback` | 用备份恢复 profile（先校验备份清单，当前状态自动再备份） | `backup` string<br>`profile?` string |

### 用法示例

**示例：体检**

```
plugin_health(profile="desktop")
# → { score: 85, issues: [{ code: "recent-crash", … }], counts: { dependencies: 35, bundles: 43 } }
```

**示例：备份 → 出问题 → 回滚**

```
plugin_backup(profile="desktop")      # → 备份 id
plugin_rollback(backup="2026-11-07T14-30-00Z-desktop")   # 当前状态会先自动备份
```

## HTTP 路由（仅本机 loopback）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/dsh-kit-guardian/scan` | `?profile=<名字>`，体检清单与最近崩溃 |
| GET | `/api/dsh-kit-guardian/backups` | 列出备份 id |
| POST | `/api/dsh-kit-guardian/backup` | `body:{"profile":"desktop"}`，立即备份一份 |

## 配置

- 无需配置。备份位置：`~/.dsh/dsh-kit-guardian/backups/<时间戳>-<profile>/`。

## 数据存在哪

- 备份目录同上；每份含 `package.json` 与 `cordis.patch.yml`。

## 安全边界

- 备份/回滚只接受已知 profile 名，路径不拼接用户输入。
- 回滚前先 `JSON.parse` 备份清单，解析失败直接拒绝。
- 路由只允许 loopback。

## 已知行为

- 「最近崩溃」只看最近 6 份日志，历史崩溃会一直提示，直到日志被清理。

## 验收

- 对实机 desktop profile 体检得分 85，仅历史 crash 警告；回滚流程在副本 profile 上验证通过。

## 宿主兼容性

- Web / 桌面宿主：HTTP 路由与工具都可用。
- headless / CLI（没有 webServer 服务）：路由自动跳过，工具照常注册。
