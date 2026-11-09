# dsh-kit-session-hygiene

会话存储清理：先看清楚再动手。

- `session_report`：按项目目录统计会话数、总大小、最早/最新、最大的几个。
- `session_archive`：把 N 天前的会话移动到 `~/.dsh/sessions-archive/<日期>/`（默认 dry-run）。
- `session_delete`：真正删除，必须传 `confirm: "DELETE"`，且默认 dry-run。

它只碰 `~/.dsh/sessions` 与会话归档目录，不读写会话内容本身。

## 宿主兼容性

- Web / 桌面宿主：HTTP 路由与工具都可用。
- headless / CLI（没有 webServer 服务）：路由自动跳过，工具照常注册——inject 不再依赖 webServer，ctx.inject(['webServer'], …) 只在服务存在时执行。
