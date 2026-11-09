# dsh-kit-config-sync

把「这台机器上的技能 + 插件配置」做成快照，换设备时一键拉回来。
支持自动快照（技能或清单一变就存）和手动快照；后端可选本机、GitHub Gist 或自建 HTTP 服务。

## 存什么

- **技能**：`~/.dsh/skills/*` 的 frontmatter、文件清单、sha256；文本文件（≤200 KB）连内容一起存，换机器可直接恢复。
- **插件**：当前 profile 的 `dsh.profile.bundles`、`dependencies`（`link:` 本地路径会标出来），以及 `cordis.patch.yml` 里每个 `- id:` 行与 `disabled` 状态。
- **设备信息**：主机名、平台、DSH_HOME、快照时间与备注。

## 脱敏

以下内容**不会**进快照：

- 键名命中 `api_key / apikey / secret / token / password / passwd / credential / authorization / auth_key` 的值，一律替换成 `"<redacted>"`；
- `channelSecrets:`、`secrets:` 这类嵌套块下面的值；
- 长得就像密钥的值（`sk-…`、`ghp_…`、`AKIA…`、`xox?-…`、`eyJ…`、`Bearer …`），即使键名不敏感也会替换。

恢复后的 `cordis.patch.yml` 里这些位置是占位符，需要在新设备上重新填一次（默认不会覆盖这一层，见下）。

## 工具

| 工具 | 作用 |
| --- | --- |
| `config_snapshot` | 手动存一份快照并按当前后端推送；返回 id 与统计 |
| `config_list` | 列出本机快照（时间、备注、技能数、bundle 数） |
| `config_push` | 把指定快照（默认 latest）推到后端，可先 `create: true` 新建 |
| `config_pull` | 从后端拉最新快照（不落盘），返回摘要与将要恢复的清单 |
| `config_apply` | 恢复快照；**默认 dry-run**，`apply: true` 才写文件 |
| `config_auto` | 开/关自动快照，`interval_sec` 最小 60（默认 300） |
| `config_backend` | 切换 local / gist / http 与填 token |
| `config_status` | 后端、自动开关、技能数、快照数、最近快照 |

### config_apply 的规则

- 默认 `apply: false`，只报告「会创建哪些技能目录、会补哪些 bundle」，不改任何文件。
- 技能目录已存在时跳过；`force: true` 才覆盖。
- profile 的 `package.json` 只**合并**缺失的 bundle，写前备份成 `package.json.manual-<时间戳>`，写后重新解析校验，失败自动回滚。
- `cordis.patch.yml` 默认**不覆盖**（里面有渠道密钥、字号等本机偏好），需要显式 `apply_patch: true`。
- 目标机器上没安装的 bundle 会在 `warnings` 里列出来，需要先 `npm i` 或 `link:` 再重启。

## 三种后端

| 后端 | 存哪 | 需要什么 |
| --- | --- | --- |
| `local`（默认） | `~/.dsh/dsh-kit-config-sync/snapshots/` | 无 |
| `gist` | 你的 GitHub Gist（私有） | GitHub token，scope 至少 `gist` |
| `http` | 你自己的服务：`POST <url>` 收快照，`GET <url>/latest` 返回 | 可选 Bearer token |

### 用 Gist 做跨设备同步

```text
config_backend backend=gist gist_token=<GitHub token>
config_snapshot note="第一次"
# 新设备上
config_backend backend=gist gist_token=<同一个 token> gist_id=<第一次返回的 id>
config_pull
config_apply apply=true
```

首次 `config_snapshot` 会自动把新建的 gist id 记到本机配置里，之后就不用再填。

### 用自建 HTTP 服务

服务端只要两件事：`POST /` 收 JSON 覆盖保存；`GET /latest` 返回最后一次保存的 JSON。
如果服务端要求鉴权，配置 `http_token`，插件会用 `Authorization: Bearer <token>`。

## HTTP 接口（宿主内，仅 loopback）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/dsh-kit-config-sync/status` | 状态 |
| GET | `/api/dsh-kit-config-sync/list` | 快照列表 |
| GET | `/api/dsh-kit-config-sync/latest` | 拉取最新（按后端）并返回摘要 |
| POST | `/api/dsh-kit-config-sync/snapshot` | `{note?, profile?}` 新建并推送 |
| POST | `/api/dsh-kit-config-sync/apply` | `{id?, apply?, apply_patch?, force?, profile?}` |

## 自动快照

宿主启动时若有 `autoEnabled`，会按 `autoIntervalSec` 定时比对指纹（技能文件哈希 + bundles + patch 文本）；
指纹没变就什么都不做，变了才存一份（后端不是 local 时顺便推送）。定时器上限保护，宿主退出时清理。

## 已知边界

- 只同步 `~/.dsh/skills` 与一个 profile 的清单，不同步 `node_modules` 里的包本体（换设备仍需 `npm i` / `link:`）。
- 技能里的二进制文件只记录哈希与大小，不存内容，恢复时跳过并给 warning。
- 快照是明文 JSON（已脱敏），不要把它放进公开仓库。

## 宿主兼容性

- Web / 桌面宿主：HTTP 路由与工具都可用。
- headless / CLI（没有 webServer 服务）：路由自动跳过，工具照常注册——inject 不再依赖 webServer，ctx.inject(['webServer'], …) 只在服务存在时执行。
