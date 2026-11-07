# dsh-rulebook

> 把 docx/txt/md 规则书抽成结构化数据：章节、条目编号、数值、表格。

版本 0.1.0 ｜ 包名 `dsh-rulebook` ｜ 仅宿主侧（无客户端代码）｜ MIT

## 它解决什么问题

规则书动辄几十页，手抄数值又慢又错。这里直接读 `.docx`（自己解 zip + `word/document.xml`，不依赖 Word）或纯文本。

输出 `{ title, chapters, clauses, numbers, tables }`，`numbers` 会把「先攻：+2」这类键值对单独拎出来，方便直接进游戏数值表。

`rulebook_check` 顺手查三类常见问题：重复条目、属性取值过多、缺章节或缺数值。

## 安装

```powershell
plugin_manager install_bundle target="C:/Users/03/Documents/deepseek-harness/default-workspace/plugins/dsh-rulebook"
```

装完即可用，工具会出现在工具列表里；用 `plugin_health` 可以体检清单。要卸载就用插件页的开关。

## 工具

| 工具 | 用途 | 参数（`*` 表示必填，`?` 表示可选） |
| --- | --- | --- |
| `rulebook_extract` | 从 docx / txt / md 规则书抽取章节、条目、数值、表格 | `path` string |
| `rulebook_check` | 检查规则书：重复条目、属性取值过多、缺章节或缺数值 | `path` string |

### 用法示例

**示例：抽取**

```
rulebook_extract(path="D:/docs/规则书.docx")
# → { ok: true, rules: { title, chapters: [{ title, index }], clauses: [...], numbers: [...], tables: [...] } }
```

**示例：体检**

```
rulebook_check(path="D:/docs/规则书.docx")
# → { ok: true, issues: [], stats: { chapters: 6, clauses: 42, numbers: 88, tables: 3 } }
```

## HTTP 路由（仅本机 loopback）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/dsh-rulebook/extract` | `?path=<docx\|txt\|md>`，抽取章节/条目/数值/表格 |

## 配置

- 无需配置；支持 `.docx`、`.txt`、`.md`。

## 数据存在哪

- 只读文档，不落盘。

## 安全边界

- 解 zip 时只读 `word/document.xml`，限制条目数量，避免超大文档卡死。

## 已知行为

- 文件不存在时直接抛 `ENOENT`（结构化错误待后续版本补）；中文数字标题（「一、」）按章节识别，阿拉伯数字标题不算章节。

## 验收

- 对实机测试文档抽取 1 章 1 条数值；`node --check` 与假 ctx 单测通过。

## 宿主兼容性

- Web / 桌面宿主：HTTP 路由与工具都可用。
- headless / CLI（没有 webServer 服务）：路由自动跳过，工具照常注册。
