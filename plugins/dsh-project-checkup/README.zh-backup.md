# dsh-project-checkup

DSH 项目体检插件：侧栏入口「◎ 项目体检」，按当前项目里的配置文件跑检查，不再绑定任何具体工作区。

## 怎么决定检查哪些项

按顺序找配置，第一个命中为准：

1. 当前项目根目录的 `dsh-checkup.json`（或 `.dsh-checkup.json`）——推荐，跟仓库一起提交
2. `~/.dsh/dsh-project-checkup/checks.json`——全局默认
3. 都没有时自动探测：`package.json`、`index.html`、`server.js` / `src/index.js` / `main.js`、`.git`、`README.md`

项目目录（`dir`）按顺序取：面板请求的 `?dir=` → `~/.dsh/dsh-project-checkup/config.json` 的 `projectDir` → 环境变量 `DSH_PROJECT_CHECKUP_DIR` → 宿主进程的 `cwd`（含 `dsh-checkup.json` 或 `package.json` 时）→ 用户主目录。

## 配置格式

```json
{
  "name": "项目名",
  "quick": [ { "id": "index", "label": "首页存在", "type": "file", "path": "index.html" } ],
  "full":  [ { "id": "todo", "label": "未完成标记", "type": "todo", "path": "index.html" } ]
}
```

快检只跑 `quick`，全检跑 `quick` + `full`。每条最多 60 项。

## 检查类型

| type | 字段 | 说明 |
| --- | --- | --- |
| `file` / `dir` | `path` | 存在性；`note:"optional"` 时缺失只提醒不失败 |
| `json` | `path` | 文件存在且能 JSON.parse |
| `syntax` | `path` | `node --check` |
| `script` | `path` | 用 node 跑一个脚本，退出码 0 为通过 |
| `npm` | `script` | `npm run <script>`（Windows 走 `cmd.exe /d /s /c`） |
| `http` | `url`, `expect` | 期望状态码，默认 200，超时 ≤45s |
| `count` | `path`, `pattern`, `min` | 用正则数文件数，低于 `min` 失败 |
| `scan` | `path`, `pattern`, `when` | 正则命中即按 `when`（`warn`/`fail`）报 |
| `todo` | `path` | 统计 TODO/FIXME |
| `command` | `cmd`, `args` | 任意命令，退出码 0 通过 |
| `note` | `message`, `status` | 固定输出一条提示 |

## 接口

- `GET /api/dsh-project-checkup/scan?scope=quick|full&dir=<绝对路径>`
- `GET /api/dsh-project-checkup/profile?dir=<绝对路径>` 看当前生效的配置和候选目录列表

## 安装

```powershell
dsh plugin --profile desktop add "C:\Users\03\Documents\deepseek-harness\default-workspace\plugins\dsh-project-checkup"
```

安装后重启 DSH 桌面应用，侧栏新会话下方会出现「项目体检」。
