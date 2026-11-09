# dsh-auto-skill

> 按任务内容自动选出合适的技能并注入，不需要在对话里手动点名。

版本 0.2.0 ｜ 包名 `dsh-auto-skill` ｜ 仅宿主侧（无客户端代码）｜ MIT

## 它解决什么问题

DSH 的技能默认要自己调用（或靠描述被模型想起来）。任务一多，经常是「明明装了却没用上」。

这个插件在每一步开始前看一眼任务文本，用**确定性关键词打分**（不是让模型猜）挑出最匹配的本机技能，把它的正文包成 `<skill_content>` 注入。

注入只发生一次：同一会话里同一个技能不会被反复塞进去，避免上下文膨胀。

用久了的技能还会积累经验：`learned.md` 记录有效做法，下次加载时一起带上（见下）。

## 安装

```powershell
plugin_manager install_bundle target="C:/Users/03/Documents/deepseek-harness/default-workspace/plugins/dsh-auto-skill"
```

装完即可用，工具会出现在工具列表里；用 `plugin_health` 可以体检清单。要卸载就用插件页的开关。

## 工具

| 工具 | 用途 | 参数（`*` 表示必填，`?` 表示可选） |
| --- | --- | --- |
| `skill_learn` | 把一条有效做法记到技能名下（写入 learned.md，不改 SKILL.md） | `skill` string<br>`method` string<br>`evidence?` string |
| `skill_learnings` | 列出各技能积累了多少条有效做法 | `skill?` string |
| `skill_forget` | 清空某技能积累的做法（需 confirm="CLEAR"） | `skill` string<br>`confirm` string |

### 用法示例

**示例：说人话就行**

```
帮我把这段中文润色一下，去掉翻译腔

# 匹配到 humanizer-zh，自动注入；你不需要写「用 humanizer-zh」
```

**示例：查看会让哪个技能生效**

```
GET /api/dsh-auto-skill/match?text=帮我写一章小说，悬疑风格，主角是侦探
# → [{ name: "chinese-novelist", score: 8 }]
```

## HTTP 路由（仅本机 loopback）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/dsh-auto-skill/match` | `?text=<任务文本>&dir=<目录>`，返回打分与入选技能（纯诊断，不注入） |
| GET | `/api/dsh-auto-skill/learned` | `?name=<技能名>`，返回该技能积累的做法摘要 |
| GET | `/api/dsh-auto-skill/health` | 返回 `version` 与生效的 `teamPolicy/teamAllow/teamExclude`，用于确认 0.3.x 已加载 |

## 配置

- 插件配置（`cordis.patch.yml` 里 `config:` 段）：`enabled`、`maxSkills`（默认 1）、`minScore`（默认 8）、`minShared`（默认 2）、`maxChars`、`debug`。
- 学习相关：`learnEnabled`、`autoLearn`、`learnInjectChars`（默认 1800）、`learnMaxEntries`（默认 60）、`learnMaxBytes`（默认 48 KB）。
- 打分规则：技能名整名命中 +60；名字分词命中 +8；描述关键词按稀有度加权（`max(2, 6/df)`）；至少命中 `minShared` 个词才算强匹配，再比 `minScore`。

## 数据存在哪

- 日志：`~/.dsh/auto-skill.log`（JSONL，超过 512 KB 自动清空，可用 `debug` 打开逐步日志）。
- 积累的做法：`~/.dsh/skills/<技能名>/learned.md`（不改 `SKILL.md`）。

## 安全边界

- 只读任务文本与本机技能目录；不改会话历史，不覆盖 `SKILL.md`。
- 注入内容带 `source.kind = "auto-skill"`，DSH 不会把它当成用户消息重复处理。
- 任何异常都被吞掉并原样返回决策，不会让一步失败拖垮整轮。

## 团队 / 子会话策略（0.3.0）

团队会话（`header.origin === "subagent"`、带 `parentSession`、或 `delegationDepth > 0`）可以关闭或收窄自动注入；普通个人会话完全不受影响。

| 配置键 | 取值 | 说明 |
| --- | --- | --- |
| `teamPolicy` | `inherit`（默认）/ `off` / `allow` / `exclude` | `inherit` 保持旧行为（`teamExclude` 仍生效，`teamAllow` 不生效）；`off` 团队会话不自动注入；`allow` 只注入 `teamAllow` 名单；`exclude` 注入除 `teamExclude` 外的技能 |
| `teamAllow` | 技能名数组 | 仅 `teamPolicy: "allow"` 时生效 |
| `teamExclude` | 技能名数组 | 团队会话中**始终排除**（含 `inherit`），优先于 `teamAllow` |

环境变量可覆盖（显式配置优先）：`DSH_AUTO_SKILL_TEAM_POLICY`、`DSH_AUTO_SKILL_TEAM_ALLOW`、`DSH_AUTO_SKILL_TEAM_EXCLUDE`（逗号或空格分隔）。

示例（团队会话完全关闭自动注入）：

```yaml
- id: auto-skill
  config:
    teamPolicy: "off"
```

显式 `/skill` 或 `skill` 工具加载不受该策略影响。团队会话的匹配、学习与日志仍照常工作，只是不把技能正文注入消息。

## 已知行为

- 本地 21 个技能参与匹配；内置技能（office 系等）只在不带 scope 的快照里可见。
- 极短消息（< `minMessageChars`，默认 8 字）不触发匹配，避免「继续」「好」这类词误命中。

## 验收

- 假 ctx 单测 18/18；真宿主 `GET /api/dsh-auto-skill/match`、`/learned` 均 200。

## 宿主兼容性

- Web / 桌面宿主：HTTP 路由与工具都可用。
- headless / CLI（没有 webServer 服务）：路由自动跳过，工具照常注册。
