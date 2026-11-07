# dsh-kit-novel-studio

> 小说设定库 + 连续性校验：人物、规则、时间线、术语、章节摘要。

版本 0.1.0 ｜ 包名 `dsh-kit-novel-studio` ｜ 仅宿主侧（无客户端代码）｜ MIT

## 它解决什么问题

写到第 30 章最容易忘设定：谁在第 5 章已经死了、这个词前面怎么译的、时间线有没有倒着走。

把设定存成结构化数据，写作时用 `novel_context` 生成摘要贴进提示词，写完用 `novel_check` 扫一遍。

`novel_check` 检查四件事：未登记人名、时间线倒置、重复句、常见 AI 腔词。

## 安装

```powershell
plugin_manager install_bundle target="C:/Users/03/Documents/deepseek-harness/default-workspace/plugins/dsh-kit-novel-studio"
```

装完即可用，工具会出现在工具列表里；用 `plugin_health` 可以体检清单。要卸载就用插件页的开关。

## 工具

| 工具 | 用途 | 参数（`*` 表示必填，`?` 表示可选） |
| --- | --- | --- |
| `novel_book` | 列出 / 新建 / 读取 / 删除小说项目 | `action` `list` / `create` / `get` / `delete`<br>`book?` string<br>`name?` string |
| `novel_upsert` | 向设定分区（人物/规则/时间线/术语/章节）新增或合并条目 | `book` string<br>`section` `characters` / `rules` / `timeline` / `glossary` / `chapters`<br>`entries` string<br>`replace?` boolean |
| `novel_context` | 生成设定摘要（markdown），可直接贴进写作提示词 | `book` string<br>`query?` string<br>`max_chars?` integer |
| `novel_check` | 检查一章草稿：未登记人名、时间线倒置、重复句、AI 腔词 | `book` string<br>`text` string |

### 用法示例

**示例：建书 → 记人物 → 取摘要**

```
novel_book(action="create", book="wanderer", name="流浪者")
novel_upsert(book="wanderer", section="characters", entries='[{"name":"老周","alias":["周叔"],"note":"码头看守"}]')
novel_context(book="wanderer", query="码头")
```

**示例：检查一章草稿**

```
novel_check(book="wanderer", text="……")
# → { unknownNames: [...], timeline: [...], repeats: [...], aiPhrases: [...] }
```

## HTTP 路由（仅本机 loopback）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/dsh-kit-novel-studio/books` | 列出书目 |
| GET | `/api/dsh-kit-novel-studio/context` | `?book=<id>&q=<关键词>`，返回设定摘要 |

## 配置

- 无需配置；书存在 `~/.dsh/dsh-kit-novel-studio/books/<id>.json`。

## 数据存在哪

- 每本书一个 JSON：`characters / rules / timeline / glossary / chapters` 五个分区。

## 安全边界

- 只读写上述目录；`delete` 需要显式 `action="delete"`，不会误删。

## 已知行为

- `novel_upsert` 的 `entries` 必须是 JSON **字符串**（不是数组对象），按 `name/term/title/when` 合并。

## 验收

- 假 ctx 单测覆盖新增/合并/查询/检查；真宿主 `/books` 200。

## 宿主兼容性

- Web / 桌面宿主：HTTP 路由与工具都可用。
- headless / CLI（没有 webServer 服务）：路由自动跳过，工具照常注册。
