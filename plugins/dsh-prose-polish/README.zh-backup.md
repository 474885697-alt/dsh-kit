# dsh-prose-polish

实时中文润色插件：在 DSH 侧边栏打开「实时润色」面板，粘贴一章试读、一段场景或未来要发的文案，按「小说润色 / 收紧 / 扩写 / 强化开头与钩子 / 通用文案」五种模式流式改写。它保留原文事实、人物、视角和时间线，只改表达。

## 它解决什么

- 生成出来的小说「信息都对，但读不下去」：句子一样长、形容词堆叠、对话像同一个人、章末没有钩子。
- 想润色一段文案，却不想每次手写一大段提示词。
- 想把同一套规则同时用在 DSH 面板、Agent 工具和《寻神者》网页小说模块里。

## 使用

1. 在 DSH「设置 → 模型」中选好默认模型（插件复用 `agent-default-model`，不需要额外 API Key）。
2. 侧边栏「新会话」下方点「实时润色」。
3. 粘贴原文，选模式与力度，点「开始润色」；结果会流式出现。
4. 「复制结果」或「替换原文」继续二轮。

Agent 也可以直接调用 `polish_text`：

```json
{
  "text": "要润色的原文",
  "mode": "novel",
  "strength": "medium",
  "style": "黑暗奇幻、第三人称限知",
  "instruction": "保留冷幽默，结尾再收紧"
}
```

## 模式

| mode | 用途 |
| --- | --- |
| `novel` | 小说正文润色，默认 |
| `tighten` | 收紧、删冗余 |
| `expand` | 补有信息量的动作与感官 |
| `hook` | 强化开头 100 字和章末钩子 |
| `copy` | 游戏 / 社区 / 公告 / 产品文案 |

## 接口

- `GET /api/dsh-prose-polish/config`：默认模型与模式列表。
- `POST /api/dsh-prose-polish/optimize`：`{ text, mode, strength, style, instruction, stream }`；`stream: true` 返回 SSE（`start` / `delta` / `done` / `error`）。
- `GET /api/dsh-prose-polish/health`：连通性。

所有路由只接受 loopback 请求。

## 安装到 web profile

把本目录链接进 profile 依赖，并把 `dsh-prose-polish` 加进 `dsh.profile.bundles`，然后重新加载 DSH Web。开发时可直接使用 `link:` 依赖；发布时把 `lib/`、`cordis.patch.yml`、`README.md` 一起打包。
