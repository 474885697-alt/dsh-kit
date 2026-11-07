---
name: dsh-plugin-safety
description: 当要安装、启用、卸载或调试 DSH 插件，或遇到插件在插件页消失、no loader entry matched、启动即崩（is not valid JSON / Welcome authentication failed）、启用后界面点不动或卡在插件加载界面时使用。给出清单三处一致性、JSON 清单安全写法、启动 cookie 累积、客户端挂载四条硬规则，以及备份 / 回滚 / 副本 profile 验证流程。
---

# DSH 插件安装与启动：四类已知坑

装、改、卸 DSH 插件之前先读这篇。这不是理论，是 2026-11-07 排查 `dsh-prose-polish` / `dsh-project-checkup` 时真实踩出来的四类故障，每一类都能让应用启动不了或界面锁死。

环境前提：Windows，`DSH_HOME = C:\Users\03\.dsh`，桌面 profile 在 `C:\Users\03\.dsh\profiles\desktop`，应用 `D:\deepseek\DeepSeek Harness.exe`。其它机器照同类比。

## 坑 1：清单三处不一致 → 插件消失 / no loader entry matched

插件要真正跑起来，三处必须同时一致：

1. profile `package.json` 的 `dependencies`（本地插件写 `link:C:/.../plugins/<name>`）
2. 同一文件的 `dsh.profile.bundles` 数组
3. （可选）`cordis.patch.yml` 里的 `- id: <name>` 行

少一处就表现为：插件页看不到、工具不出现、市场日志刷 `no loader entry matched` 或 `re-added to dsh.profile.bundles, which nothing was composing (#696)`。

做法：只用插件页开关或 `plugin_manager`（`install_bundle` / `set_bundle`）操作，**不要手改**清单；必须手改时先备份成 `package.json.manual-<yyyyMMdd-HHmmss>`，且**一次只装一个**，装完立刻重启验证，方便二分。

## 坑 2：清单写坏 → 启动即死

`dsh-app-boot` 的 `readProfileManifest` 是裸 `JSON.parse`（`dsh-app-boot/lib/index.js:1685-1696`）。清单有一个语法错误，应用直接抛 `DesktopHostFatalError ... is not valid JSON`，连启动界面都进不去。两个最常见的写法错误：

- 数组/对象**尾逗号**（`"dsh-comfyui", ]`）——真实事故：连续 3 次启动崩溃。
- PowerShell 5.1 用 `Set-Content -Encoding UTF8` 写会带 **BOM**，报 `Unexpected token '锘縶'`。

安全写法：

```powershell
$path = 'C:\Users\03\.dsh\profiles\desktop\package.json'
$json = Get-Content $path -Raw | ConvertFrom-Json        # 先验证现有文件
$text = $json | ConvertTo-Json -Depth 20
[System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))
Get-Content $path -Raw | ConvertFrom-Json                # 再验证写回的文件
```

## 坑 3：启动 cookie 累积 → desktop welcome: Web authentication failed

症状：应用连续启动失败，crash 日志（`C:\Users\03\AppData\Roaming\@deepseek-ai\dsh-desktop\logs\crash-*-host.log`）里固定是
`Error: desktop welcome: Web authentication failed`（`connectDesktopWelcome`，`app.asar/lib/main.js:16856`）。

根因：`127.0.0.1` 上累积约 70 条 `dsh-auth-<hash>` cookie，请求头超过 Node 默认 `maxHeaderSize = 16384`，Node 在解析层直接回 431；这个 431 到不了应用层，所以清理逻辑永远没机会跑。

对策：保留 `dsh-auth-cookie-guard` 插件（1.0.6+），**不要卸载**。判据：错误行固定是 welcome 认证失败、且启动次数接近 70，就优先怀疑它，而不是插件代码。

## 坑 4：插件自己拖垮启动链路 → 界面点不动 / 卡在插件加载界面

客户端 bundle 在页面启动时执行 `apply()`。写得不小心会把整个渲染进程拖死，表现是界面完全不能点，或重启后停在插件加载界面。

- ✗ 不要在 `apply()` 里 `new MutationObserver(...)` + `observer.observe(document.body, { childList: true, subtree: true })`：body 可能还没生成（`observe(null)` 直接抛 TypeError，中断 apply）；即使成功，插入节点 → 触发 mutation → 再插入，可能形成死循环。
- ✓ 有界轮询：立即尝试挂载一次，然后 800ms 一次、上限约 150 次（约 2 分钟），每次 `try/catch`，成功即清定时器。
- ✓ `apply()` 整体 `try/catch`，任何异常都不能冒泡到启动链路。
- ✓ 事件监听用标志位（如 `keydownBound`）只绑一次；`injectStyle()` 先查 `<style id>` 是否存在；定时器必须有上限并清理。
- ✓ 宿主侧 `apply(ctx)` 不做同步重活、不发网络请求；路由用 `ctx.effect` 回收、只允许 loopback；工具注册必须带 `output.render`，`execute` 抛错要兜底成返回值。

## 安全流程

1. 备份 `package.json` 与 `cordis.patch.yml`（带时间戳）。
2. 一次只装一个插件，走插件页或 `plugin_manager`。
3. 确认插件出现在插件页 / bundles 里，再重启。
4. 启动失败先看 crash 日志的 `phase` 与错误行：
   - `is not valid JSON` → 坑 2
   - `Web authentication failed` → 坑 3
   - 界面卡死 → 坑 4
5. 兜底：`C:\Users\03\Desktop\如果卡死-双击这个恢复.cmd`（杀进程 → 用最新 `package.json.manual-*` 覆盖清单 → 重启）。
6. 想先试插件而不动桌面 profile：复制一份 profile（`package.json` + `cordis.yml` + `cordis.patch.yml`，`node_modules` 用 junction 指向 `desktop\node_modules`），再
   `dsh --profile <副本> --host 127.0.0.1 --port <端口> --no-open`。
   桌面 profile 本身不能用命令行启动（`profile "desktop" is managed exclusively by the Electron application`）。

## 附加坑：创建技能一直失败

若看到 `the user rejected tool "create_skill"` 而自己没点拒绝：这是 `@michengai/dsh-skills-manager` 在 `tools/pre-execute` 里发起审批，而会话审批策略是 `never`（「完全访问」预设）时没人能回答，DSH 直接按 rejected 处理。解法：切到「工作区写入」权限预设让审批弹出来，或给该插件的 `isDangerFullAccess()` 加 `approval.effectivePolicy === "never"` 时放行的兜底。详见 `~/.dsh/AGENTS.md` 的坑 5。
