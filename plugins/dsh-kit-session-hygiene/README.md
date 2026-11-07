# dsh-kit-session-hygiene

> 会话存储体检与清理：先统计、再归档、最后才谈删除。

版本 0.1.0 ｜ 包名 `dsh-kit-session-hygiene` ｜ 仅宿主侧（无客户端代码）｜ MIT

## 它解决什么问题

会话文件会悄悄长到几十 MB。先看清楚谁在占地方（按项目分组、列最大的几个），再决定归档或删除。

归档是**移动**到 `~/.dsh/sessions-archive/<日期>/`（可随时移回），删除才是真删。

两个破坏性操作都默认演练：`dry_run` 默认 true，`session_delete` 还要 `confirm="DELETE"` 且只允许删 7 天以上的。

## 安装

```powershell
plugin_manager install_bundle target="C:/Users/03/Documents/deepseek-harness/default-workspace/plugins/dsh-kit-session-hygiene"
```

装完即可用，工具会出现在工具列表里；用 `plugin_health` 可以体检清单。要卸载就用插件页的开关。

## 工具

| 工具 | 用途 | 参数（`*` 表示必填，`?` 表示可选） |
| --- | --- | --- |
| `session_report` | 统计会话数量、体积、按项目分组与最大的几个 | `days?` integer |
| `session_archive` | 把 N 天前的会话移动到归档目录（默认演练） | `older_than_days` integer<br>`dry_run?` boolean |
| `session_delete` | 永久删除 N 天前的会话（需 confirm="DELETE"，最少 7 天） | `older_than_days` integer<br>`confirm` string<br>`dry_run?` boolean |

### 用法示例

**示例：先看**

```
session_report(days=30)
# → { total: 26, totalMb: 88.6, groups: [...], largest: [...] }
```

**示例：归档（演练 → 执行）**

```
session_archive(older_than_days=90)                  # 演练
session_archive(older_than_days=90, dry_run=False)   # 真移动
```

## HTTP 路由（仅本机 loopback）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/dsh-kit-session-hygiene/report` | `?days=30`，会话数量/体积/分组 |

## 配置

- 无需配置；归档目录 `~/.dsh/sessions-archive/`。

## 数据存在哪

- 只操作 `~/.dsh/sessions`；不读会话内容，只算大小和时间。

## 安全边界

- 删除要求 `confirm="DELETE"` 且 `older_than_days ≥ 7`。
- 默认 `dry_run=true`，先看清单再执行。
- 只删 `session.v4.jsonl.zstd` 所在会话目录，不碰其它文件。

## 已知行为

- 归档不会更新 DSH 的会话索引，应用内可能会短暂看到「会话缺失」；需要时手动移回。

## 验收

- 实测 26 个会话 / 88.6 MB / 4 组；dry-run 与真实归档在临时目录验证一致。

## 宿主兼容性

- Web / 桌面宿主：HTTP 路由与工具都可用。
- headless / CLI（没有 webServer 服务）：路由自动跳过，工具照常注册。
