# dsh-build-ship

一键「构建 → 收产物 → 自检」，把发布前的机械步骤固化。

- `ship_build`：在 `cwd` 执行 `build_cmd`，超时保护，返回退出码与输出尾部。
- `ship_collect`：列出 `out_dir` 里的产物（大小 + sha256），可校验 `expect` 文件名列表。
- `ship_report`：读取最近一次报告。
- 报告存 `~/.dsh/dsh-build-ship/reports/<时间戳>.json`。

只执行你给定的命令，不擅自改项目文件。

## 宿主兼容性

- Web / 桌面宿主：HTTP 路由与工具都可用。
- headless / CLI（没有 webServer 服务）：路由自动跳过，工具照常注册——inject 不再依赖 webServer，ctx.inject(['webServer'], …) 只在服务存在时执行。
