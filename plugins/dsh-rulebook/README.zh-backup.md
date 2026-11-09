# dsh-rulebook

把规则书（.docx / .txt / .md）抽成结构化 JSON，避免手工抄数值。

- `rulebook_extract`：返回 `{title, chapters[], clauses[], numbers[], tables[]}`，.docx 自动解 zip 读 `word/document.xml`。
- `rulebook_check`：找重复条目、缺数值的属性、层级断裂。

只读文件、不写回原文；输出可再喂给 `game-rulebook-to-code` 技能。

## 宿主兼容性

- Web / 桌面宿主：HTTP 路由与工具都可用。
- headless / CLI（没有 webServer 服务）：路由自动跳过，工具照常注册——inject 不再依赖 webServer，ctx.inject(['webServer'], …) 只在服务存在时执行。
