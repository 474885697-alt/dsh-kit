# dsh-auto-skill

让技能“自动生效”：你正常说要做的事，插件自己判断该用哪个技能，把技能说明注入这一轮对话，模型照着做——不用点名、不用手动把技能插进工作内容。

## 它怎么工作

每个回合的第一步（`agent/pre-step`，`step === 1`）：

1. 取本轮真正的用户输入（跳过技能目录、运行时上下文、工作区指令这些系统消息）；
2. 从技能服务拿当前会话可见的技能清单（名称、描述、whenToUse）；
3. 用**确定性关键词匹配**打分（不调用模型，不额外花钱、不增加延迟）；
4. 只有“够强”的命中才会注入：把技能正文包装成 `<skill_content>`，和手动加载技能时一模一样；
5. 同一会话里同一个技能只注入一次，不会每轮重复烧上下文。

没命中就什么都不做，对话和平时完全一样。

## 打分规则

- 技能名整名出现在输入里：+60，直接算强命中；
- 技能名的分词命中：+8；
- 描述 / whenToUse 里的关键词命中：按稀有度加权（`max(2, round(6 / df))`），三词组再加 2；
- 至少命中 `minShared` 个关键词才算“强”，且总分 ≥ `minScore` 才注入。

词切分：英文按词（≥3 字符），中文按二元组 + 三元组，并过滤“帮我 / 一下 / 这个”这类停用词和含虚词的词组。

## 配置

在 profile 的 `cordis.patch.yml` 里给 `auto-skill` 行加 `config`：

```yaml
- id: auto-skill
  name: dsh-auto-skill
  config:
    enabled: true        # 总开关
    maxSkills: 1         # 每轮最多注入几个技能
    maxChars: 12000      # 单个技能正文上限，超出截断并注明
    minShared: 2         # 至少命中几个关键词
    minMessageChars: 8   # 太短的输入不参与匹配（“继续”“好”）
    minScore: 8          # 总分门槛，调高更保守
    debug: false         # true 时把每轮的消息清单写进日志
```

默认偏保守：宁可漏掉，也不乱加载。想更激进就把 `minScore` 降到 6、`minShared` 调到 1。

## 排查

- 日志：`%DSH_HOME%\auto-skill.log`（默认 `C:\Users\03\.dsh\auto-skill.log`），JSONL，记录 `apply` / `inject` / `no-match`；超过 512KB 自动清空。
- 诊断接口（宿主半边，仅本机）：`GET /api/dsh-auto-skill/match?text=你的任务` 返回命中打分，用来调阈值。
  - 加 `&dir=D:\某个项目` 可以按指定目录的技能清单打分。

## 已知限制

- 匹配是**关键词**，不是语义。中文换一种说法、用同义词，可能匹配不到；此时明确点名技能即可（原有的 `skill` 工具照常可用）。
- 只注入当前目录可见、且允许模型调用的技能（`invocation.modelInvocable !== false`）。
- 注入内容会进入会话记录，便于审计；它标记为 `source.kind = "auto-skill"`，不会和用户原文混淆。
- 插件本身不联网、不改文件、不注册工具，只在上下文里加一条消息；所有异常都被吞掉并原样放行，不会影响会话启动。

## 卸载

从插件页关掉，或从 profile 的 `dsh.profile.bundles` 里移除即可，不残留任何状态（除了日志文件）。

## 学习：把有效的操作回写到技能里（0.2.0+）

技能本身（`SKILL.md`）保持原样，学到的经验单独存在技能目录的 `learned.md`：

```
~/.dsh/skills/<skill-dir>/SKILL.md     # 原始技能，不动
~/.dsh/skills/<skill-dir>/learned.md   # 自动积累的有效做法
```

下次这个技能被注入时，`learned.md` 会作为 `<skill_learned>` 附在 `<skill_content>` 后面，模型能同时看到「技能怎么写」和「本机怎么做过」。

经验来源有两条：

1. **手动（高置信）**：任务做完后调用 `skill_learn(skill, method, evidence)`，把这次真正有效的做法记下来。
2. **自动（低置信）**：插件注入技能后，会观察后续的 `tools/result`；下一轮开始时，如果这一轮至少跑通了 2 个工具调用，就把调用链沉淀成一条 `[auto]` 经验（例如 `本轮任务的有效操作链：pwsh → write`）。

去重与上限：做法 + 依据取 sha256 前 12 位，重复的直接跳过；单个技能最多 `learnMaxEntries`（默认 60）条、`learnMaxBytes`（默认 48KB），超了从最旧的丢。

| 工具 | 作用 |
| --- | --- |
| `skill_learn` | 记一条有效做法（`skill`、`method` 必填，`evidence` 可选） |
| `skill_learnings` | 列出各技能累计条数与最近一条 |
| `skill_forget` | 清空某个技能的 `learned.md`，必须 `confirm: "CLEAR"` |

配置项：`learnEnabled`（默认 true）、`autoLearn`（默认 true）、`learnInjectChars`（注入上限，默认 1800）、`learnMaxEntries`（60）、`learnMaxBytes`（49152）。

诊断：`GET /api/dsh-auto-skill/learned?name=<技能名>`（仅回环地址）返回将注入的经验文本。