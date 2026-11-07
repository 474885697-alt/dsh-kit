# dsh-audio-post

> ffmpeg 音频后期：转码、按预设压响度、批量处理。

版本 0.1.0 ｜ 包名 `dsh-audio-post` ｜ 仅宿主侧（无客户端代码）｜ MIT

## 它解决什么问题

AI 生成的音频经常响度忽大忽小、首尾有静音；游戏音效要短促干净，网易云上传要 -14 LUFS。

四个预设把常用参数固定下来：`game-sfx`（去首尾静音 + -16 LUFS）、`netease-ai-music`（-14 LUFS / 320k）、`voice-clean`（高通 + 降噪 + -16 LUFS）、`voice-loud`（-14 LUFS / 192k）。

同格式批量处理时会自动加 `.post` 后缀，不会覆盖源文件，也不会把上一轮产物再处理一遍。

## 安装

```powershell
plugin_manager install_bundle target="C:/Users/03/Documents/deepseek-harness/default-workspace/plugins/dsh-audio-post"
```

装完即可用，工具会出现在工具列表里；用 `plugin_health` 可以体检清单。要卸载就用插件页的开关。

## 工具

| 工具 | 用途 | 参数（`*` 表示必填，`?` 表示可选） |
| --- | --- | --- |
| `audio_info` | 查看音频文件的时长、码率、采样率、声道、编码 | `path` string |
| `audio_convert` | 转码为 mp3 / wav / m4a，可指定采样率与码率 | `input` string<br>`output?` string<br>`format?` `mp3` / `wav` / `m4a`<br>`sample_rate?` integer<br>`bitrate?` string |
| `audio_preset` | 套用后期预设：game-sfx / netease-ai-music / voice-clean / voice-loud | `input` string<br>`preset` `game-sfx` / `netease-ai-music` / `voice-clean` / `voice-loud`<br>`output?` string |
| `audio_batch` | 对整个目录的音频批量套预设 | `dir` string<br>`preset` `game-sfx` / `netease-ai-music` / `voice-clean` / `voice-loud` |

### 用法示例

**示例：看信息 → 套预设**

```
audio_info(path="D:/sfx/hit.mp3")
audio_preset(input="D:/sfx/hit.mp3", preset="game-sfx", output="D:/sfx/hit.clean.mp3")
```

**示例：整目录批量**

```
audio_batch(dir="D:/sfx", preset="game-sfx")
```

## HTTP 路由（仅本机 loopback）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/dsh-audio-post/recipes` | 返回四个预设的参数说明 |
| GET | `/api/dsh-audio-post/info` | `?path=<音频文件>`，返回时长/码率/采样率 |

## 配置

- ffmpeg 查找顺序：环境变量 `DSH_FFMPEG` → `~/.dsh/tools/ffmpeg/ffmpeg.exe` → PATH。
- `audio_convert` 支持 `mp3|wav|m4a`，可指定 `sample_rate` 与 `bitrate`。

## 数据存在哪

- 不保存中间状态；产物写到指定路径或源文件同目录。

## 安全边界

- 只调用本机 ffmpeg/ffprobe，不联网；`audio_batch` 只处理目录第一层的音频文件。

## 已知行为

- 批量时同格式输出会变成 `<名字>.post.<ext>`；再跑一次会跳过 `.post.*`。

## 验收

- 用真实 ffmpeg 生成 440Hz 正弦波跑 `game-sfx`，1.04s / 197kbps 结果正常。

## 宿主兼容性

- Web / 桌面宿主：HTTP 路由与工具都可用。
- headless / CLI（没有 webServer 服务）：路由自动跳过，工具照常注册。
