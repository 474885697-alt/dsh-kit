# dsh-kit-guardian

启动健康体检 + 备份回滚。给 profile 清单做四项检查：

1. 清单 JSON 是否合法（尾逗号、BOM、编码）；
2. `dependencies` / `dsh.profile.bundles` / `cordis.patch.yml` 的 `- id:` 三处是否一致；
3. 每个 bundle 在 `node_modules` 里是否真的能解析；
4. 最近的 crash 日志是哪一类（清单 JSON 写坏 / welcome 认证失败 / 其他）。

工具：`plugin_health`、`plugin_backup`、`plugin_rollback`；HTTP：`GET /api/dsh-kit-guardian/scan`、`GET /api/dsh-kit-guardian/backups`、`POST /api/dsh-kit-guardian/backup`。

## 宿主兼容性

- Web / 桌面宿主：HTTP 路由与工具都可用。
- headless / CLI（没有 webServer 服务）：路由自动跳过，工具照常注册——inject 不再依赖 webServer，ctx.inject(['webServer'], …) 只在服务存在时执行。
