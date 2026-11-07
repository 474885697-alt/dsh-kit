window.__ModuleLoader__.load({
  id: 'dsh-project-checkup',
  factory: () => {
    const module = { exports: {} }
    const exports = module.exports
    const API = '/api/dsh-project-checkup'

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function shortSource(source) {
  if (!source) return ''
  return String(source).length > 52 ? `…${String(source).slice(-50)}` : String(source)
}
    const ENTRY_ATTR = 'data-dsh-project-checkup-entry'
    const STYLE_ID = 'dsh-project-checkup-style'
    let panel = null
    let entry = null
    let mountTimer = null
    let running = false

    const CSS = `
    .dsh-pc-entry{display:flex;align-items:center;gap:8px;width:100%;padding:8px 10px;margin:2px 0;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--dsh-text-secondary,#9aa4b2);font:inherit;font-size:13px;cursor:pointer;text-align:left;white-space:nowrap;overflow:hidden}
    .dsh-pc-entry:hover{background:rgba(255,255,255,.055);color:var(--dsh-text-primary,#e8eaed)}
    .dsh-pc-entry .ico{width:18px;height:18px;display:grid;place-items:center;color:#d6a858;font-size:15px}
    .dsh-pc-backdrop[hidden]{display:none}
    .dsh-pc-backdrop{position:fixed;inset:0;z-index:1200;display:grid;place-items:center;padding:20px;background:rgba(2,8,12,.72);backdrop-filter:blur(8px)}
    .dsh-pc-panel{width:min(820px,100%);max-height:calc(100vh - 24px);display:flex;flex-direction:column;overflow:hidden;border:1px solid rgba(214,168,88,.25);border-radius:16px;background:linear-gradient(160deg,#111d24,#0a1418 62%,#101a17);box-shadow:0 28px 80px rgba(0,0,0,.55);color:#e8e2d4;font-family:ui-serif,"Noto Serif SC",serif}
    .dsh-pc-head{display:flex;justify-content:space-between;gap:16px;padding:20px 22px 14px;border-bottom:1px solid rgba(255,255,255,.06)}
    .dsh-pc-kicker{font:10px/1.2 ui-monospace,monospace;letter-spacing:.22em;color:#9d8b65}
    .dsh-pc-title{margin:6px 0 0;font-size:24px;font-weight:600;color:#f0e6cf}
    .dsh-pc-close{width:34px;height:34px;border:1px solid rgba(214,168,88,.25);border-radius:9px;background:transparent;color:#c9b993;font-size:20px;cursor:pointer}
    .dsh-pc-toolbar{display:flex;gap:8px;flex-wrap:wrap;padding:14px 22px;border-bottom:1px solid rgba(255,255,255,.06)}
    .dsh-pc-btn{border:1px solid rgba(214,168,88,.3);border-radius:7px;background:rgba(214,168,88,.06);color:#e3c98f;padding:8px 12px;font:12px/1.2 ui-serif,"Noto Serif SC",serif;cursor:pointer}
    .dsh-pc-btn:hover{background:rgba(214,168,88,.14);border-color:rgba(214,168,88,.55)}
    .dsh-pc-btn:disabled{opacity:.45;cursor:default}
    .dsh-pc-btn.primary{background:#c69a56;color:#15100a;border-color:#c69a56}
    .dsh-pc-body{padding:14px 22px 20px;overflow:auto;flex:1 1 auto;min-height:0}
    .dsh-pc-summary{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:13px 14px;border:1px solid rgba(255,255,255,.08);border-radius:10px;background:rgba(255,255,255,.02)}
    .dsh-pc-score{font:600 26px/1 ui-monospace,monospace;color:#e7c787}
    .dsh-pc-meta{font:11px/1.6 ui-monospace,monospace;color:#8d9a93}
    .dsh-pc-list{display:grid;gap:7px;margin-top:12px}
    .dsh-pc-check{display:grid;grid-template-columns:64px minmax(0,1fr);gap:10px;padding:9px 11px;border:1px solid rgba(255,255,255,.06);border-radius:8px;background:rgba(255,255,255,.015)}
    .dsh-pc-status{font:10px/1.6 ui-monospace,monospace;letter-spacing:.08em}
    .dsh-pc-status.pass{color:#83c99a}.dsh-pc-status.warn{color:#e0bd6e}.dsh-pc-status.fail{color:#e8887d}
    .dsh-pc-label{color:#e9e1d0;font-size:12px}
    .dsh-pc-detail{grid-column:2;color:#84928c;font:10px/1.5 ui-monospace,monospace;word-break:break-all}
    .dsh-pc-empty{padding:30px 12px;text-align:center;color:#83918b;font:11px/1.7 ui-monospace,monospace}
    @media(max-width:640px){.dsh-pc-backdrop{padding:6px}.dsh-pc-panel{max-height:calc(100vh - 12px)}.dsh-pc-head,.dsh-pc-toolbar,.dsh-pc-body{padding-left:14px;padding-right:14px}.dsh-pc-check{grid-template-columns:52px minmax(0,1fr)}}
    .dsh-pc-backdrop[hidden]{display:none}
    `

    function injectStyle() {
      if (document.getElementById(STYLE_ID)) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      document.head.appendChild(style)
    }

    function sidebarRoot() {
      return document.querySelector('[data-pane="sidebar"], [class*="sidebarCol"]')
    }

    function newSessionButton(root) {
      const nested = root.querySelector('button[class*="newSession"]')
      if (nested) return nested
      for (const child of root.children) if (child.tagName === 'BUTTON') return child
      return null
    }

    function placeEntry() {
      const root = sidebarRoot()
      if (!root) return false
      const button = newSessionButton(root)
      if (!button) return false
      let node = root.querySelector(`[${ENTRY_ATTR}]`)
      if (!node) {
        node = document.createElement('button')
        node.type = 'button'
        node.setAttribute(ENTRY_ATTR, '')
        node.className = 'dsh-pc-entry'
        node.innerHTML = '<span class="ico">◎</span><span>项目体检</span>'
        node.title = '检查当前项目（可用 dsh-checkup.json 自定义检查项）'
        node.addEventListener('click', openPanel)
      }
      const host = button.parentElement
      if (host && (node.parentElement !== host || node.previousElementSibling !== button)) {
        host.insertBefore(node, button.nextSibling)
      }
      entry = node
      return true
    }

    function placeEntrySafe() {
      try {
        return placeEntry()
      } catch (error) {
        return false
      }
    }

    function startMount() {
      if (mountTimer !== null) return
      if (placeEntrySafe()) return
      let ticks = 0
      mountTimer = setInterval(() => {
        ticks += 1
        if (placeEntrySafe() || ticks >= 150) {
          clearInterval(mountTimer)
          mountTimer = null
        }
      }, 800)
    }

    function makePanel() {
      const backdrop = document.createElement('div')
      backdrop.className = 'dsh-pc-backdrop'
      backdrop.hidden = true
      backdrop.innerHTML = `
        <section class="dsh-pc-panel" role="dialog" aria-modal="true" aria-label="项目体检">
          <header class="dsh-pc-head">
            <div><div class="dsh-pc-kicker">PROJECT CHECKUP · 寻神者工作区</div><h2 class="dsh-pc-title">项目体检</h2></div>
            <button type="button" class="dsh-pc-close" aria-label="关闭">×</button>
          </header>
          <div class="dsh-pc-toolbar">
            <button type="button" class="dsh-pc-btn primary" data-scope="quick">快检</button>
            <button type="button" class="dsh-pc-btn" data-scope="full">全检</button>
            <span class="dsh-pc-meta" data-status>选择体检范围</span>
          </div>
          <div class="dsh-pc-body"><div class="dsh-pc-empty">快检：语法、服务、素材。<br>全检：再加上动作处理、未完成标记、测试数据残留。</div></div>
        </section>`
      backdrop.querySelector('.dsh-pc-close').addEventListener('click', closePanel)
      backdrop.addEventListener('click', (event) => { if (event.target === backdrop) closePanel() })
      backdrop.querySelectorAll('[data-scope]').forEach((button) => {
        button.addEventListener('click', () => runScan(button.dataset.scope))
      })
      document.body.appendChild(backdrop)
      return backdrop
    }

    function openPanel() {
      if (!panel) panel = makePanel()
      panel.hidden = false
      runScan('quick')
    }

    function closePanel() {
      if (panel) panel.hidden = true
    }

    async function runScan(scope) {
      if (running) return
      running = true
      const status = panel.querySelector('[data-status]')
      const body = panel.querySelector('.dsh-pc-body')
      panel.querySelectorAll('[data-scope]').forEach((button) => { button.disabled = true })
      status.textContent = scope === 'full' ? '全检运行中…' : '快检运行中…'
      try {
        const response = await fetch(`${API}/scan?scope=${scope}`, { cache: 'no-store' })
        const data = await response.json()
        if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`)
        const c = data.summary
        status.textContent = `${scope === 'full' ? '全检' : '快检'} · ${new Date(data.generatedAt).toLocaleTimeString()}`
        body.innerHTML = `
          <div class="dsh-pc-summary">
            <div><div class="dsh-pc-score">${c.score}<span style="font-size:11px;color:#7f8e87"> / 100</span></div><div class="dsh-pc-meta">${c.pass} 通过 · ${c.warn} 提醒 · ${c.fail} 失败</div></div>
            <div class="dsh-pc-meta">${data.name ? `${escapeHtml(data.name)}<br>` : ''}${data.projectDir || ''}${data.profileSource && data.profileSource !== 'auto' ? `<br>${escapeHtml(shortSource(data.profileSource))}` : '<br>自动探测'}</div>
          </div>
          <div class="dsh-pc-list">${data.checks.map((item) => `
            <div class="dsh-pc-check"><span class="dsh-pc-status ${item.status}">${item.status === 'pass' ? 'PASS' : item.status === 'warn' ? 'WARN' : 'FAIL'}</span><span class="dsh-pc-label">${item.label}</span><span class="dsh-pc-detail">${item.detail || ''}</span></div>
          `).join('')}</div>`
      } catch (error) {
        status.textContent = '体检失败'
        body.innerHTML = `<div class="dsh-pc-empty">无法完成体检：${escapeHtml(error.message)}<br>确认插件已在当前 profile 启用，且目标项目目录可读。</div>`
      } finally {
        running = false
        panel.querySelectorAll('[data-scope]').forEach((button) => { button.disabled = false })
      }
    }

    function apply() {
      if (typeof document === 'undefined') return
      try {
        injectStyle()
      } catch (error) {
        /* 样式注入失败不应影响宿主启动 */
      }
      try {
        startMount()
      } catch (error) {
        /* 入口挂载失败不应影响宿主启动 */
      }
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && panel && !panel.hidden) closePanel()
      })
    }

    exports.inject = []
    exports.apply = apply
    return module.exports
  }
})
