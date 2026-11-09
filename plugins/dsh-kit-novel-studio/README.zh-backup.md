# dsh-kit-novel-studio

长篇小说的「设定圣经 + 连续性检查」。

- 设定存在 `~/.dsh/dsh-kit-novel-studio/books/<book>.json`：人物（含别名）、世界规则、时间线、术语表、章节摘要。
- `novel_upsert` 增改条目；`novel_context` 输出可直接粘进提示词的设定摘要；`novel_check` 检查正文里是否出现未登记人名、时间线倒置、重复句、常见 AI 腔。
- 它只做「记忆与校对」，文笔润色仍交给 dsh-prose-polish。

## 宿主兼容性

- Web / 桌面宿主：HTTP 路由与工具都可用。
- headless / CLI（没有 webServer 服务）：路由自动跳过，工具照常注册——inject 不再依赖 webServer，ctx.inject(['webServer'], …) 只在服务存在时执行。
