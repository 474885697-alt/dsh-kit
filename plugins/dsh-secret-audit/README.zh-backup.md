# dsh-secret-audit

在本机工作区里找「明文密钥」并给出风险分级，**输出永远打码**（只留前 6 后 4 位）。

- 识别：`sk-…`、`sk-proj-…`、`ghp_/gho_/ghs_`、`AKIA…`、`Bearer …`、以及 `api_key = "…"` 这类赋值。
- 判定：文件是否在 git 仓库里（外泄风险高）、是否属于凭据库（风险低）、是否命中 `shareMode` 共享开关。
- 输出：扫描文件数、命中列表（文件:行、类型、打码值、风险）、以及 `ai-configs.json` 一类的共享配置摘要。

工具 `secret_scan`；HTTP `GET /api/dsh-secret-audit/scan?roots=...`。

## 宿主兼容性

- Web / 桌面宿主：HTTP 路由与工具都可用。
- headless / CLI（没有 webServer 服务）：路由自动跳过，工具照常注册——inject 不再依赖 webServer，ctx.inject(['webServer'], …) 只在服务存在时执行。
