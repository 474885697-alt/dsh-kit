# dsh-round-triage

一个 DeepSeek Harness 宿主插件：在每个 Agent 回合结束前，找出本回合新产生/修改的文件，按规则分类；只把**安全的、新建的、未跟踪的**文件移动到目标目录，其余写入报告等人工处理。

## 它解决什么

- 生成图片、音频、文档、脚本后，文件散落在项目根目录或 `output/`、`generated/` 里。
- 每次手动 `mkdir`、`mv` 容易漏，也容易覆盖已有文件。
- 这个插件在回合结束时自动盘点，把“可以安全归位”的新文件送到约定目录，并留下完整 JSON 报告。

## 安全边界（重要）

自动移动只处理同时满足以下条件的文件：

1. 本回合**新建**（不是修改已有文件）；
2. 在 git 仓库里是**未跟踪**（`??`）；没有 git 时不依赖这条；
3. 来源在 `inboxDirs` 内（默认：项目根、`tmp/`、`output/`、`outputs/`、`generated/`、`generated-assets/`）；
4. 命中一条 `auto: true` 的规则；
5. 不是敏感文件（`.env`、密钥、证书等）、不是保留文件（`README`、`package.json`、`index.html` 等）、不是隐藏文件；
6. 目标在项目目录内；
7. 大小不超过 `maxFileBytes`。

目标已存在时不会覆盖，会生成 `-2`、`-3` 后缀。修改过的已跟踪文件、`src/` 里的新文件、`docs/tmp/` 里的截图，默认只报告、不移动。

## 默认归类

| 规则 | 匹配 | 目标 | 自动 |
| --- | --- | --- | --- |
| `images` | png/jpg/jpeg/webp/gif/svg/avif | `assets/art/generated/` | 是 |
| `audio` | mp3/wav/ogg/m4a/flac/aac | `assets/audio/` | 是 |
| `video` | mp4/webm/mov/mkv | `assets/video/` | 否 |
| `docs` | md/mdx/txt/rst | `docs/notes/` | 否 |
| `scripts` | cjs/mjs/js/ts/tsx/jsx/py/ps1/sh | `tools/` | 否 |
| `data` | json/jsonl/csv/tsv/yml/yaml/xml | `data/` | 否 |
| `archives` | zip/7z/tar/gz/tgz/bz2/xz | `dist/` | 否 |

`auto: false` 的规则只会出现在报告里，不会移动。你可以按项目改。

## 本项目用法（寻神者）

项目根的 `.dsh-round-triage.json` 覆盖默认规则，改这里不用动插件代码：

- 自动：images → `docs/previews`、audio → `assets/audio`、docs → `docs/notes`
- 手动：scripts → `docs/tmp/scripts`、data → `data`、video → `assets/video`、archives → `docs/tmp/archive`
- `skipDirs` 追加 `docs/tmp`、`docs/previews`、`docs/竞品研究/截图`、`docs/reminders`，减少无意义扫描
- `maxChanges: 60` 控制单次报告行数；工具输出默认只回 20 行 `changes`，附 `reasons` 计数与 `totalChanges`，完整清单仍在 JSON 报告里（apply 使用完整报告，不受显示截断影响）
- 排查「为什么没生效」：看 `status` 的 `reasons` —— `modified-not-moved`（已跟踪文件）、`rule-manual`（规则未开自动）、`not-in-inbox`（来源目录不在 `inboxDirs`）、`ignored`（隐藏/敏感/保留文件）

## 安装

本机 profile 是 `C:\Users\03\.dsh\profiles\desktop`。插件目录：

```text
C:\Users\03\Documents\deepseek-harness\default-workspace\plugins\dsh-round-triage
```

在 profile 的 `package.json` 中加依赖：

```json
"dsh-round-triage": "link:C:/Users/03/Documents/deepseek-harness/default-workspace/plugins/dsh-round-triage"
```

并把 `dsh-round-triage` 加入 `dsh.profile.bundles`。插件包自带 `cordis.patch.yml`，会插入 `round-triage` 条目。改完清单后重启应用；桌面 profile 不要用命令行直接启动。

如果只想先试运行，先把 `autoApply` 设为 `false`，重启后只生成报告。

## 配置

插件配置可以在 profile 的 `cordis.patch.yml` 中按 id 覆盖：

```yaml
- id: round-triage
  name: dsh-round-triage
  config:
    enabled: true
    autoApply: true
    maxFiles: 20000
    maxDepth: 8
    inboxDirs: ["", "tmp", "output", "outputs", "generated"]
```

也可以在项目根放 `.dsh-round-triage.json`（优先级高于插件配置）：

```json
{
  "autoApply": true,
  "rules": [
    {
      "id": "images",
      "match": "**/*.{png,jpg,jpeg,webp}",
      "to": "assets/art/generated",
      "auto": true
    },
    {
      "id": "reports",
      "match": "**/*.md",
      "to": "docs/notes",
      "auto": false
    }
  ]
}
```

项目里一旦写了 `rules`，它会整体替换默认规则；`inboxDirs`、`autoApply` 等同理。`autoApply: false` 时只做计划。

## 工具

`round_triage`：

- `action=plan`：对比上次基线，列出本回合新文件、分类、目标、是否可自动移动。
- `action=apply`：执行安全移动，写报告，并把基线更新到移动后的状态。
- `action=status`：查看最近一次报告和当前基线。
- `action=reset`：清除基线，下一次 `plan/apply` 会重新建立基线。

`project` 省略时使用进程当前工作目录；建议显式传项目根目录。

示例：

```json
{ "action": "plan", "project": "C:/Users/03/Documents/my-game" }
```

## 报告位置

```text
~/.dsh/round-triage/
  state/<project-hash>.json      # 回合开始/结束的基线
  reports/<project-hash>/*.json  # 每次回合或手动操作的完整报告
  reports/<project-hash>/latest.json
  round-triage.log               # 轻量运行日志
```

报告包含 `summary`、`changes`、`moved`、`skipped`、`errors` 和 `reportPath`。自动整理出错不会阻断回合，只写日志和 `errors`。

## 工作方式

1. `agent/pre-step`（每回合第 1 步）扫描项目，记录基线；
2. 回合正常结束前触发 `agent/turn-stopping`；
3. 对比基线，分类新文件；
4. 读取 git 状态（可用时）确认 `??`；
5. 按安全条件移动，更新基线和报告；
6. 下一回合重复。

同一项目根目录的操作会串行执行，避免主 Agent 与子 Agent 同时移动文件。

## 已知限制

- 只覆盖“回合内新建”的文件；回合开始前就存在的未跟踪文件不会自动移动。
- 默认不处理 `docs/tmp/`，避免把验收截图当素材搬走；需要时把 `docs/tmp` 加进 `inboxDirs`。
- 文件名冲突用后缀解决，不会覆盖。
- 跨盘移动使用复制 + 删除兜底。
- 不做内容识别，只按扩展名和路径规则分类；要更细的规则请改 `.dsh-round-triage.json`。
