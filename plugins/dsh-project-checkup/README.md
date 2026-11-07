# dsh-project-checkup

> 项目体检：检查项写在 `dsh-checkup.json` 里，换项目不用改代码。

版本 0.1.0 ｜ 包名 `dsh-project-checkup` ｜ 仅宿主侧（无客户端代码）｜ MIT

## 它解决什么问题

原先的检查项是写死的（某个项目专属），换个目录就全废。现在改成声明式：检查项由 JSON 描述，插件只提供执行器。

找不到配置时自动探测：`package.json`、`index.html`、`server.js` / `src/index.js`、`.git`、`README.md`，识别不到就给一条「未识别到项目特征」的提示。

12 种检查类型：`file`、`dir`、`json`、`syntax`、`script`、`npm`、`http`、`count`、`scan`、`todo`、`command`、`note`。

## 安装

```powershell
plugin_manager install_bundle target="C:/Users/03/Documents/deepseek-harness/default-workspace/plugins/dsh-project-checkup"
```

装完即可用，工具会出现在工具列表里；用 `plugin_health` 可以体检清单。要卸载就用插件页的开关。

### 用法示例

**示例：最小配置（项目根目录 dsh-checkup.json）**

```
{
  "name": "我的项目",
  "quick": [
    { "type": "file", "path": "index.html", "message": "入口页存在" },
    { "type": "syntax", "path": "server.js" },
    { "type": "http", "url": "http://127.0.0.1:3000/api/health", "expect": 200 }
  ],
  "full": [
    { "type": "count", "path": "assets/art/generated", "pattern": "\.png$", "min": 30 }
  ]
}
```

**示例：跑一次**

```
GET /api/dsh-project-checkup/scan?scope=quick&dir=C:/path/to/project
# → { ok, name, projectDir, profileSource, summary:{pass,warn,fail,skip,total,score}, checks:[…] }
```

## HTTP 路由（仅本机 loopback）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/dsh-project-checkup/scan` | `?scope=quick\|full&dir=<绝对路径>`，返回检查项与分数 |
| GET | `/api/dsh-project-checkup/profile` | 返回解析到的配置来源与候选目录 |

## 配置

- 配置文件查找顺序：项目内 `dsh-checkup.json` / `.dsh-checkup.json` → 全局 `~/.dsh/dsh-project-checkup/checks.json` → 自动探测。
- 目录查找顺序：`?dir=` 参数 → 全局配置的 `projectDir` → 环境变量 `DSH_PROJECT_CHECKUP_DIR` → 当前工作目录 → 用户主目录。
- `npm` 类型在 Windows 上走 `cmd.exe /d /s /c npm run <name>`（避开 `spawn EINVAL`）。

## 数据存在哪

- 全局配置：`~/.dsh/dsh-project-checkup/config.json`（`projectDir`）。不写任何缓存。

## 安全边界

- 只读项目文件；`http` 检查只发 GET，超时 ≤45 秒。
- 自动探测**不会**执行 `npm build/test`，避免打开项目就编译。

## 已知行为

- `note` 类型恒为 warn，适合放「这个项目需要手动确认」的提醒。

## 验收

- quick 6 项 / full 12 项实测全 pass；临时空目录给出 pass + warn 组合。

## 宿主兼容性

- Web / 桌面宿主：HTTP 路由与工具都可用。
- headless / CLI（没有 webServer 服务）：路由自动跳过，工具照常注册。
