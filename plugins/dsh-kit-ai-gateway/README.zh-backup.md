# dsh-kit-ai-gateway

本地 key 池：把多个厂商 key 存一处，由本机服务按「用得最少」发号，避免在十几个文件里散落明文。

- `gateway_keys`：list（默认打码）/ add / remove / enable。
- `gateway_pick`：取一个可用 key（least-used，按累计次数），并累加计数。
- `gateway_usage`：按 provider 汇总使用次数与最近使用时间。

存储：`~/.dsh/dsh-kit-ai-gateway/keys.json`（首次写入设为仅当前用户可读）。
注意：本插件**不代理请求**，只做 key 发放与计数；`GET /api/dsh-kit-ai-gateway/pick` 仅接受 loopback。

## 宿主兼容性

- Web / 桌面宿主：HTTP 路由与工具都可用。
- headless / CLI（没有 webServer 服务）：路由自动跳过，工具照常注册——inject 不再依赖 webServer，ctx.inject(['webServer'], …) 只在服务存在时执行。
