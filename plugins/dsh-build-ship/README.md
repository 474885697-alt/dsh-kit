# dsh-build-ship

> 一条命令跑完「构建 → 收集产物 → 校验 → 出报告」。

版本 0.1.0 ｜ 包名 `dsh-build-ship` ｜ 仅宿主侧（无客户端代码）｜ MIT

## 它解决什么问题

打包后最常见的问题是「产物到底生成了没、多大、是不是这次编的」。

`ship_run` 把三步串起来：跑构建命令（`cmd.exe /d /s /c`，带超时）、列产物（大小 + sha256 前 16 位）、按期望文件名校验，最后写一份报告。

输出像流水账但很好查：退出码、输出尾部 40 行、每个产物的哈希。

## 安装

```powershell
plugin_manager install_bundle target="C:/Users/03/Documents/deepseek-harness/default-workspace/plugins/dsh-build-ship"
```

装完即可用，工具会出现在工具列表里；用 `plugin_health` 可以体检清单。要卸载就用插件页的开关。

## 工具

| 工具 | 用途 | 参数（`*` 表示必填，`?` 表示可选） |
| --- | --- | --- |
| `ship_build` | 在项目目录跑构建命令，返回退出码与输出尾部 | `cwd` string<br>`build_cmd` string<br>`timeout_ms?` integer |
| `ship_collect` | 列出产物的大小与短哈希，可校验期望文件名 | `out_dir` string<br>`expect?` array |
| `ship_run` | 完整流水线：构建 → 收集产物 → 校验 → 写报告 | `cwd` string<br>`build_cmd` string<br>`out_dir?` string<br>`expect?` array<br>`timeout_ms?` integer |

### 用法示例

**示例：完整流水线**

```
ship_run(cwd="D:/proj", build_cmd="npm run build", out_dir="D:/proj/dist", expect=["index.html","app.js"])
```

**示例：只看产物**

```
ship_collect(out_dir="D:/proj/dist")
# → { files: [{ name, bytes, sha256: "1a2b…" }], missing: [] }
```

## HTTP 路由（仅本机 loopback）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/dsh-build-ship/report` | 返回最近一次打包报告 |

## 配置

- 无需配置；`timeout_ms` 默认 10 分钟。

## 数据存在哪

- 报告：`~/.dsh/dsh-build-ship/reports/<时间戳>.json`。

## 安全边界

- 构建命令由你显式传入，插件不读项目脚本自动执行；超时后杀进程树并返回已捕获输出。

## 已知行为

- Windows 下走 `cmd.exe`，`&&`、`%VAR%` 语法可直接用；PowerShell 语法需自己包 `powershell -Command`。

## 验收

- 假 ctx 单测覆盖成功/失败/超时；真宿主 `/report` 200；对 `market/tarballs` 收集 10 个产物并出哈希。

## 宿主兼容性

- Web / 桌面宿主：HTTP 路由与工具都可用。
- headless / CLI（没有 webServer 服务）：路由自动跳过，工具照常注册。
