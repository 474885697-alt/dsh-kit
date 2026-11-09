# dsh-audio-post

用本机 ffmpeg 做音频后期，避免「生成—试听—再生成」的手工循环。

- `audio_info`：时长、码率、采样率、声道。
- `audio_convert`：转 mp3/wav/m4a，可指定采样率与码率。
- `audio_preset`：`game-sfx`（裁静音 + 响度 −16 LUFS + mp3 192k）、`netease-ai-music`（−14 LUFS + mp3 320k）、`voice-clean`（高通 + 降噪 + −16 LUFS）。
- `audio_batch`：整个目录按预设批处理。

ffmpeg 查找顺序：环境变量 `DSH_FFMPEG` → `~/.dsh/tools/ffmpeg/ffmpeg.exe` → PATH。

## 宿主兼容性

- Web / 桌面宿主：HTTP 路由与工具都可用。
- headless / CLI（没有 webServer 服务）：路由自动跳过，工具照常注册——inject 不再依赖 webServer，ctx.inject(['webServer'], …) 只在服务存在时执行。
