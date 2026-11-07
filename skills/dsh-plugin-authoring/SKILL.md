---
name: dsh-plugin-authoring
description: 当用户要写一个 DSH 插件（host 工具、HTTP 路由、客户端面板、bundle 打包）或要排查插件不加载、工具不出现、面板不显示时使用。给出可复制的 package.json / cordis.patch.yml / lib/index.js 骨架、路由与工具注册契约、客户端挂载的四条硬规则，以及「副本 profile 命令行验证」流程。
---

# 写一个能真正加载的 DSH 插件

## 骨架

```
plugins/<pkg>/
  package.json
  cordis.patch.yml
  README.md
  lib/index.js        # 宿主半边（必需）
  lib/client.js       # 浏览器半边（可选，风险高）
```

`package.json` 关键字段：

```json
{
  "type": "module",
  "main": "lib/index.js",
  "exports": { ".": "./lib/index.js", "./package.json": "./package.json" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "engines": { "node": ">=20" },
  "files": ["lib", "cordis.patch.yml", "README.md"]
}
```

`cordis.patch.yml`：

```yaml
- insert:
    - id: my-plugin          # 短名，和 cordis.patch.yml 里的 - id: 行对齐
      name: dsh-my-plugin
```

## 宿主契约

```js
export const name = 'my-plugin'
export const inject = ['webServer']

export function apply(ctx) {
  const disposers = [ctx.webServer.register({ kind: 'exact', path: '/api/my-plugin/x', handler: async (req, res) => {...} })]
  ctx.effect(() => () => { for (const d of disposers) d() }, 'my-plugin: routes')

  ctx.inject(['tools'], (tctx) => {
    tctx.effect(() => tctx.tools.register({
      name: 'my_tool',
      description: '...',
      parameters: { type: 'object', additionalProperties: false, properties: { x: { type: 'string' } }, required: ['x'] },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
      async execute(args) { return JSON.stringify({ ok: true }, null, 2) },
    }), 'my-plugin: tools')
  })
}
```

- `output.render` 必须存在，否则注册直接抛错；返回 JSON 字符串最省事。
- 路由只允许 loopback；`ctx.effect` 必须真正回收 disposer。
- `apply()` 里不要做同步重活、不要发网络请求。

## 客户端（可选，但最容易炸）

```js
window.__ModuleLoader__.load({
  id: 'dsh-my-plugin',
  factory: () => {
    const exports = {}
    exports.inject = []
    exports.apply = () => { try { mount() } catch (e) { console.warn('[my-plugin]', e) } }
    return exports
  },
})
```

- ✗ 不要 `observe(document.body, { childList: true, subtree: true })`：body 可能为 null，且 insert→mutation→insert 会成环，界面直接点不动。
- ✓ 有界轮询：立即挂一次，然后 800ms 一次、最多约 150 次，成功即清定时器。
- ✓ `apply()` 整体 try/catch；监听用标志位只绑一次；注入样式前先查 `document.getElementById`。
- ✓ 挂载点用 `[class*="sidebarCol"]` / `button[class*="newSession"]`，不要依赖 `data-pane` 之类的猜测属性。

## 验证流程（别直接动桌面 profile）

1. `node --check lib/index.js`。
2. 复制一份 profile：`package.json` + `cordis.yml` + `cordis.patch.yml`，`node_modules` 用 `mklink /J` 指向 `desktop\node_modules`，再把插件目录 junction 进去。
3. `dsh --profile <副本> --host 127.0.0.1 --port <端口> --no-open`，打开 boot 页确认 `plugins/??...client.js` 列表里有你的包。
4. 用 `curl` 打自己的路由；用模型调用一次自己的工具。
5. 确认无误再 `plugin_manager install_bundle` 装进桌面 profile。