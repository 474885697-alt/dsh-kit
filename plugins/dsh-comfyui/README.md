# dsh-comfyui

把本机 ComfyUI / Stable Diffusion 接进 DeepSeek Harness 的侧栏生图工作台。不内置模型，只负责提交工作流、轮询结果和管理输出。

## 安装

插件已经以本地 link 方式加入 `desktop` profile：

```powershell
dsh plugin --profile desktop add C:\path\to\dsh-comfyui
```

随后**重启 DeepSeek Harness 桌面应用**。重启后左侧栏「新会话」下方会出现「本地生图」。

## ComfyUI 与自动启动

本机已安装在 `D:\ComfyUI\ComfyUI`，使用独立 Python。双击 `D:\ComfyUI\启动ComfyUI.cmd` 即可启动，或手动运行：

```powershell
Set-Location D:\ComfyUI\ComfyUI
D:\ComfyUI\Python312\python.exe main.py --listen 127.0.0.1 --port 8188
```

`/system_stats` 探测不到 ComfyUI 时，插件会自动用配置里的 `pythonPath` 和 `comfyDir` 启动它，最多等 90 秒。默认值：

- `pythonPath`：`D:\ComfyUI\Python312\python.exe`
- `comfyDir`：`D:\ComfyUI\ComfyUI`
- `autoStart`：`true`

插件默认连接 `http://127.0.0.1:8188`。只接受本机回环地址，避免把生图接口暴露到局域网。

## Agent 工具

插件会注册全局工具 `generate_comfyui`。在对话里直接让 Agent「用本地 ComfyUI 画一张……」即可；工具会自动启动 ComfyUI、生成图片、保存到输出目录，并把图片作为附件显示在工具调用旁。

参数：`prompt`、`negative`、`width`、`height`、`steps`、`cfg`、`batch`、`checkpoint`、`lora`、`lora_strength`、`seed`。不传 `checkpoint` 时使用面板里保存的默认模型；`lora` 填 `models/loras` 中的文件名，不传则不加载 LoRA。

## 使用

1. 点侧栏「本地生图」。
2. 「ComfyUI 地址」保持默认，或填写实际端口。
3. 点「测试连接」确认在线。
4. 点「刷新模型」，选择 ComfyUI 里实际存在的 checkpoint。
5. 填写正向/负向提示词、尺寸、步数、CFG、batch；需要风格 LoRA 时在「LoRA」里选择文件并设置强度（默认 0.8），点「生成」。
6. 结果会出现在「最近生成」，点击缩略图可新窗口放大；「打开目录」打开输出文件夹。

本机模型目录：`D:\ComfyUI\ComfyUI\models\checkpoints\Juggernaut-XL_v9_RunDiffusionPhoto_v2.safetensors`（7.1GB，SDXL）。

默认参数：

- checkpoint：`Juggernaut-XL_v9_RunDiffusionPhoto_v2.safetensors`
- 尺寸：1344×768
- steps：28
- CFG：5.5
- 输出：`~/Pictures/DSH-ComfyUI`

checkpoint 和输出目录都可以在面板里改，保存后写入 `~/.dsh/dsh-comfyui/config.json`。

## 风格 LoRA

训练好的 LoRA 放在 `D:\ComfyUI\ComfyUI\models\loras`，面板「刷新模型」后会出现在「LoRA」下拉框。当前项目有两套：

- **寻神者环境lora（env）**（文件：`wolrang_env_v1.safetensors`）：沃壤写实奇幻环境风格，适合海港、矿道、雪山、遗迹等场景。
- **寻神者墨线风角色lora（ink）**（文件：`wolrang_ink_v1.safetensors`）：沃壤墨线漫画 / 羊皮纸地图风格，适合分镜、插画、地图素材。

提示词里同时保留 LoRA 训练时的触发词（环境：`dark teal and warm gold palette, cinematic 2.5D fantasy concept art`；墨线：`wolrang_ink`），效果更稳定。强度 0.6–0.9 适合场景，1.0 左右适合明确的墨线稿；过强会压掉模型本身的细节。

## 故障排查

- **测试连接失败**：确认 ComfyUI 正在运行，地址和端口一致；浏览器/DSH 与 ComfyUI 在同一台机器。
- **刷新模型为空**：ComfyUI 的 `models/checkpoints` 里没有可选模型，或 `/object_info` 不可访问。
- **生成报 checkpoint 不存在**：面板里的名称必须和 ComfyUI 模型文件名完全一致，包括扩展名。
- **403 / 只允许本机**：插件拒绝非 loopback 请求；这是有意的安全边界。
- **面板高度不足**：面板主体可独立滚动，顶部关闭按钮和底部输出路径固定。

## 卸载

```powershell
dsh plugin --profile desktop remove dsh-comfyui
```

然后重启桌面应用。
