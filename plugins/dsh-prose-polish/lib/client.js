/**
 * dsh-prose-polish - browser half.
 *
 * A dependency-free overlay panel: paste a chapter or a fragment, pick a mode
 * and strength, watch the polished text stream in, then copy it or push it
 * back into the source box.  It never touches the conversation column.
 */
window.__ModuleLoader__.load({
  id: 'dsh-prose-polish',
  factory: () => {
    const module = { exports: {} }
    const exports = module.exports

    const API = '/api/dsh-prose-polish'
    const ENTRY_ATTR = 'data-dsh-prose-entry'
    const STYLE_ID = 'dsh-prose-polish-style'
    const PANEL_ID = 'dsh-prose-polish-panel'

    let panel = null
    let entry = null
    let mountTimer = null
    let abortController = null
    let keydownBound = false

    const CSS = `
.dsh-prose-entry{display:flex;align-items:center;gap:8px;width:100%;padding:8px 10px;margin:2px 0;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--dsh-text-secondary,#9aa4b2);font:inherit;font-size:13px;cursor:pointer;text-align:left;white-space:nowrap;overflow:hidden}
.dsh-prose-entry:hover{background:rgba(255,255,255,.055);color:var(--dsh-text-primary,#e8eaed)}
.dsh-prose-entry[data-active="true"]{border-color:rgba(214,168,88,.35);background:rgba(214,168,88,.08);color:#e4c07a}
.dsh-prose-entry .dsh-prose-entry-icon{display:grid;place-items:center;width:18px;height:18px;color:#d6a858;font-size:15px}
.dsh-prose-backdrop[hidden]{display:none}
.dsh-prose-backdrop{position:fixed;inset:0;z-index:1200;display:grid;place-items:center;padding:24px;background:rgba(2,8,12,.76);backdrop-filter:blur(9px)}
.dsh-prose-panel{width:min(1160px,100%);max-height:calc(100vh - 32px);display:flex;flex-direction:column;overflow:hidden;border:1px solid rgba(214,168,88,.25);border-radius:16px;background:linear-gradient(160deg,#111d24,#0a1418 62%,#101a17);box-shadow:0 28px 80px rgba(0,0,0,.58),inset 0 1px 0 rgba(255,255,255,.05);color:#e8e2d4;font-family:ui-serif,"Noto Serif SC",serif}
.dsh-prose-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex:0 0 auto;padding:20px 24px 13px;border-bottom:1px solid rgba(255,255,255,.06)}
.dsh-prose-kicker{font:11px/1.2 ui-monospace,monospace;letter-spacing:.22em;color:#9d8b65;text-transform:uppercase}
.dsh-prose-title{margin:6px 0 0;font-size:25px;font-weight:600;letter-spacing:.06em;color:#f0e6cf}
.dsh-prose-sub{margin:5px 0 0;font:11px/1.5 ui-monospace,monospace;color:#83908b}
.dsh-prose-close{width:34px;height:34px;border:1px solid rgba(214,168,88,.25);border-radius:9px;background:transparent;color:#c9b993;font-size:20px;cursor:pointer}
.dsh-prose-close:hover{background:rgba(214,168,88,.1);color:#f0dfb8}
.dsh-prose-body{padding:16px 24px 18px;overflow:auto;flex:1 1 auto;min-height:0}
.dsh-prose-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:14px}
.dsh-prose-card{display:flex;flex-direction:column;min-width:0;border:1px solid rgba(255,255,255,.075);border-radius:11px;background:rgba(255,255,255,.018);padding:12px}
.dsh-prose-card-head{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-bottom:7px;font:10px/1.2 ui-monospace,monospace;letter-spacing:.14em;color:#a89b82;text-transform:uppercase}
.dsh-prose-card-head b{font-weight:400;color:#d8c8a8;letter-spacing:.04em}
.dsh-prose-textarea{width:100%;min-height:260px;flex:1 1 auto;box-sizing:border-box;border:1px solid rgba(214,168,88,.18);border-radius:7px;background:rgba(0,0,0,.24);color:#eee6d5;padding:10px;font:14px/1.7 ui-serif,"Noto Serif SC",serif;outline:none;resize:vertical}
.dsh-prose-textarea:focus{border-color:rgba(214,168,88,.56);box-shadow:0 0 0 2px rgba(214,168,88,.08)}
.dsh-prose-select,.dsh-prose-input{width:100%;box-sizing:border-box;border:1px solid rgba(214,168,88,.18);border-radius:7px;background:rgba(0,0,0,.22);color:#eee6d5;padding:7px 8px;font:12px/1.45 ui-serif,"Noto Serif SC",serif;outline:none}
.dsh-prose-select:focus,.dsh-prose-input:focus{border-color:rgba(214,168,88,.56)}
.dsh-prose-controls{display:grid;grid-template-columns:1fr 1fr 1.5fr;gap:8px;margin-top:9px}
.dsh-prose-field{display:block;min-width:0}
.dsh-prose-field span{display:block;margin:0 0 4px;font:10px/1.2 ui-monospace,monospace;letter-spacing:.1em;color:#93876f;text-transform:uppercase}
.dsh-prose-field-wide{grid-column:1/-1}
.dsh-prose-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
.dsh-prose-btn{border:1px solid rgba(214,168,88,.3);border-radius:7px;background:rgba(214,168,88,.06);color:#e3c98f;padding:8px 12px;font:12px/1.2 ui-serif,"Noto Serif SC",serif;cursor:pointer}
.dsh-prose-btn:hover{background:rgba(214,168,88,.14);border-color:rgba(214,168,88,.55)}
.dsh-prose-btn.primary{background:linear-gradient(135deg,#b78743,#d9ae62);border-color:#d6a858;color:#1b1307;font-weight:700}
.dsh-prose-btn:disabled{opacity:.38;cursor:not-allowed}
.dsh-prose-output{min-height:330px;flex:1 1 auto;margin:0;padding:10px;border:1px solid rgba(214,168,88,.12);border-radius:7px;background:rgba(0,0,0,.24);color:#f0e7d6;font:14px/1.75 ui-serif,"Noto Serif SC",serif;white-space:pre-wrap;overflow-wrap:anywhere;overflow:auto}
.dsh-prose-output:empty::before{content:attr(data-placeholder);color:#6f7d78}
.dsh-prose-status{min-height:20px;margin:10px 0 0;font:12px/1.5 ui-monospace,monospace;color:#a9b7b3;white-space:pre-wrap;overflow-wrap:anywhere}
.dsh-prose-status.bad{color:#e69a8c}
.dsh-prose-status.good{color:#9fcf9c}
.dsh-prose-foot{display:flex;justify-content:space-between;gap:12px;flex:0 0 auto;padding:9px 24px 14px;border-top:1px solid rgba(255,255,255,.06);font:10px/1.4 ui-monospace,monospace;color:#7f8b86}
.dsh-prose-foot code{color:#b9a578}
@media(max-width:760px){.dsh-prose-backdrop{padding:8px}.dsh-prose-panel{max-height:calc(100vh - 16px)}.dsh-prose-grid{grid-template-columns:1fr}.dsh-prose-body{padding:12px}.dsh-prose-head{padding:15px 15px 10px}.dsh-prose-foot{padding:8px 15px 12px}.dsh-prose-controls{grid-template-columns:1fr 1fr}.dsh-prose-field-wide{grid-column:1/-1}.dsh-prose-textarea{min-height:180px}.dsh-prose-output{min-height:220px}}
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
      const anchor = newSessionButton(root)
      if (!anchor) return false
      if (!entry) {
        entry = document.createElement('button')
        entry.type = 'button'
        entry.className = 'dsh-prose-entry'
        entry.setAttribute(ENTRY_ATTR, '')
        entry.innerHTML = '<span class="dsh-prose-entry-icon">✎</span><span>实时润色</span>'
        entry.addEventListener('click', openPanel)
      }
      if (entry.parentElement !== anchor.parentElement || entry.previousElementSibling !== anchor) {
        anchor.insertAdjacentElement('afterend', entry)
      }
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
        const ok = placeEntrySafe()
        if (ticks <= 3 || ticks === 10 || ticks === 50) diag('mount-tick', `${ticks}:${ok}`)
        if (ok || ticks >= 150) {
          diag(ok ? 'mounted' : 'mount-give-up', String(ticks))
          clearInterval(mountTimer)
          mountTimer = null
        }
      }, 800)
    }

    function makePanel() {
      const backdrop = document.createElement('div')
      backdrop.className = 'dsh-prose-backdrop'
      backdrop.id = PANEL_ID
      backdrop.hidden = true
      backdrop.innerHTML = `
        <section class="dsh-prose-panel" role="dialog" aria-modal="true" aria-label="实时润色">
          <header class="dsh-prose-head">
            <div>
              <div class="dsh-prose-kicker">PROSE POLISH · 实时优化</div>
              <h2 class="dsh-prose-title">把这一段，改到让人想读下去</h2>
              <p class="dsh-prose-sub">保留事实、人物与视角；只改节奏、细节、对话和钩子。结果流式返回，可复制或回填原文。</p>
            </div>
            <button type="button" class="dsh-prose-close" data-prose-close aria-label="关闭">×</button>
          </header>
          <div class="dsh-prose-body">
            <div class="dsh-prose-grid">
              <section class="dsh-prose-card">
                <div class="dsh-prose-card-head"><span>原文</span><b data-prose-count>0 字</b></div>
                <textarea class="dsh-prose-textarea" data-prose-text placeholder="粘贴一章试读、一段场景，或未来要发的文案…"></textarea>
                <div class="dsh-prose-controls">
                  <label class="dsh-prose-field"><span>模式</span><select class="dsh-prose-select" data-prose-mode></select></label>
                  <label class="dsh-prose-field"><span>力度</span><select class="dsh-prose-select" data-prose-strength></select></label>
                  <label class="dsh-prose-field"><span>文体</span><input class="dsh-prose-input" data-prose-style placeholder="黑暗奇幻、第三人称限知"></label>
                  <label class="dsh-prose-field dsh-prose-field-wide"><span>额外要求（可选）</span><input class="dsh-prose-input" data-prose-instruction placeholder="例如：保留冷幽默；结尾再收紧；不要加新设定"></label>
                </div>
                <div class="dsh-prose-actions">
                  <button type="button" class="dsh-prose-btn primary" data-prose-run>开始润色</button>
                  <button type="button" class="dsh-prose-btn" data-prose-stop disabled>停止</button>
                  <button type="button" class="dsh-prose-btn" data-prose-paste>从剪贴板粘贴</button>
                  <button type="button" class="dsh-prose-btn" data-prose-clear>清空</button>
                </div>
              </section>
              <section class="dsh-prose-card">
                <div class="dsh-prose-card-head"><span>润色结果</span><b data-prose-model>模型：—</b></div>
                <pre class="dsh-prose-output" data-prose-output data-placeholder="结果会在这里实时出现……"></pre>
                <div class="dsh-prose-actions">
                  <button type="button" class="dsh-prose-btn" data-prose-copy disabled>复制结果</button>
                  <button type="button" class="dsh-prose-btn" data-prose-replace disabled>替换原文</button>
                </div>
              </section>
            </div>
            <p class="dsh-prose-status" data-prose-status>准备就绪。Ctrl/⌘ + Enter 可直接开始。</p>
          </div>
          <footer class="dsh-prose-foot">
            <span>规则：具体动作与五感 · 长短句交替 · 对话潜台词 · 章末钩子 · 不新增剧情</span>
            <span><code>/api/dsh-prose-polish</code></span>
          </footer>
        </section>
      `
      document.body.appendChild(backdrop)

      const close = () => closePanel()
      backdrop.querySelector('[data-prose-close]').addEventListener('click', close)
      backdrop.addEventListener('click', (event) => { if (event.target === backdrop) close() })

      const textarea = backdrop.querySelector('[data-prose-text]')
      const output = backdrop.querySelector('[data-prose-output]')
      const count = backdrop.querySelector('[data-prose-count]')
      const runButton = backdrop.querySelector('[data-prose-run]')
      const stopButton = backdrop.querySelector('[data-prose-stop]')
      const copyButton = backdrop.querySelector('[data-prose-copy]')
      const replaceButton = backdrop.querySelector('[data-prose-replace]')
      const status = backdrop.querySelector('[data-prose-status]')
      const modelLabel = backdrop.querySelector('[data-prose-model]')

      const refreshCount = () => { count.textContent = `${textarea.value.length.toLocaleString('zh-CN')} 字` }
      textarea.addEventListener('input', refreshCount)
      textarea.addEventListener('keydown', (event) => {
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
          event.preventDefault()
          void run()
        }
      })

      runButton.addEventListener('click', () => { void run() })
      stopButton.addEventListener('click', stop)
      copyButton.addEventListener('click', async () => {
        const text = output.textContent || ''
        if (!text) return
        try {
          await navigator.clipboard.writeText(text)
          setStatus('结果已复制。', 'good')
        } catch {
          setStatus('复制失败，请手动选择文本。', 'bad')
        }
      })
      replaceButton.addEventListener('click', () => {
        const text = output.textContent || ''
        if (!text) return
        textarea.value = text
        refreshCount()
        setStatus('已回填到原文框，可继续润色或复制。', 'good')
        textarea.focus()
      })
      backdrop.querySelector('[data-prose-clear]').addEventListener('click', () => {
        textarea.value = ''
        output.textContent = ''
        refreshCount()
        setButtons(false)
        setStatus('已清空。')
        textarea.focus()
      })
      backdrop.querySelector('[data-prose-paste]').addEventListener('click', async () => {
        try {
          const text = await navigator.clipboard.readText()
          if (text) {
            textarea.value = text
            refreshCount()
            setStatus('已从剪贴板粘贴。', 'good')
          }
        } catch {
          setStatus('无法读取剪贴板，请手动粘贴。', 'bad')
        }
      })

      function setStatus(message, kind = '') {
        status.textContent = message
        status.className = `dsh-prose-status${kind ? ` ${kind}` : ''}`
      }

      function setButtons(busy) {
        runButton.disabled = busy
        stopButton.disabled = !busy
      }

      function setResult(text, model) {
        output.textContent = text
        copyButton.disabled = !text
        replaceButton.disabled = !text
        if (model) modelLabel.textContent = `模型：${model}`
      }

      async function loadConfig() {
        try {
          const response = await fetch(`${API}/config`)
          const data = await response.json()
          if (!data.ok) throw new Error(data.message || '配置读取失败')
          const mode = backdrop.querySelector('[data-prose-mode]')
          const strength = backdrop.querySelector('[data-prose-strength]')
          mode.innerHTML = (data.modes || []).map((item) => `<option value="${escapeAttr(item.value)}">${escapeHtml(item.label)}</option>`).join('')
          strength.innerHTML = (data.strengths || []).map((item) => `<option value="${escapeAttr(item.value)}">${escapeHtml(item.label)}</option>`).join('')
          mode.value = 'novel'
          strength.value = 'medium'
          if (data.model) modelLabel.textContent = `模型：${data.model}`
          setStatus(data.model ? '准备就绪。Ctrl/⌘ + Enter 可直接开始。' : '已连上插件，但 DSH 还没有默认模型；请先在「设置 → 模型」里选一个。', data.model ? '' : 'bad')
        } catch (error) {
          setStatus(`插件后端未就绪：${error.message}`, 'bad')
        }
      }

      async function run() {
        const text = textarea.value.trim()
        if (!text) {
          setStatus('先粘贴一段原文。', 'bad')
          textarea.focus()
          return
        }
        if (text.length > 32000) {
          setStatus('原文超过 32,000 字符，请分段润色。', 'bad')
          return
        }
        stop()
        abortController = new AbortController()
        setButtons(true)
        setResult('', '')
        setStatus('正在连接模型…')
        const mode = backdrop.querySelector('[data-prose-mode]').value || 'novel'
        const strength = backdrop.querySelector('[data-prose-strength]').value || 'medium'
        const style = backdrop.querySelector('[data-prose-style]').value.trim()
        const instruction = backdrop.querySelector('[data-prose-instruction]').value.trim()

        try {
          const response = await fetch(`${API}/optimize`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text, mode, strength, style, instruction, stream: true }),
            signal: abortController.signal,
          })
          if (!response.ok) {
            let message = `请求失败（${response.status}）`
            try {
              const data = await response.json()
              message = data.message || message
            } catch {
              // keep the status message
            }
            throw new Error(message)
          }
          if (!response.body) throw new Error('浏览器不支持流式响应')
          const reader = response.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ''
          let finalText = ''

          const handleBlock = (raw) => {
            let event = 'message'
            const dataLines = []
            for (const line of raw.split(/\r?\n/)) {
              if (line.startsWith('event:')) event = line.slice(6).trim()
              else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
            }
            if (!dataLines.length) return
            let payload = null
            try { payload = JSON.parse(dataLines.join('\n')) } catch { return }
            if (event === 'delta' && typeof payload.text === 'string') {
              finalText += payload.text
              output.textContent = finalText
              output.scrollTop = output.scrollHeight
            } else if (event === 'done') {
              finalText = typeof payload.text === 'string' ? payload.text : finalText
              setResult(finalText, payload.model)
              setStatus(`润色完成${payload.model ? ` · ${payload.model}` : ''}。`, 'good')
            } else if (event === 'error') {
              throw new Error(payload.message || '润色失败')
            } else if (event === 'start') {
              setStatus('模型已开始输出…')
            }
          }

          while (true) {
            const { value, done } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            let split = buffer.indexOf('\n\n')
            while (split >= 0) {
              const raw = buffer.slice(0, split)
              buffer = buffer.slice(split + 2)
              handleBlock(raw)
              split = buffer.indexOf('\n\n')
            }
          }
          buffer += decoder.decode()
          if (buffer.trim()) handleBlock(buffer)
          if (!finalText) setStatus('模型没有返回内容，请重试或换一个模式。', 'bad')
        } catch (error) {
          if (error.name === 'AbortError') {
            setStatus('已停止。已输出的内容保留在右侧。', '')
          } else {
            setStatus(`润色失败：${error.message}`, 'bad')
          }
        } finally {
          abortController = null
          setButtons(false)
        }
      }

      function stop() {
        if (abortController) {
          abortController.abort()
          abortController = null
        }
      }

      backdrop.__dshProse = { loadConfig, run, stop, refreshCount }
      return backdrop
    }

    function escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))
    }

    function escapeAttr(value) {
      return escapeHtml(value).replace(/`/g, '&#96;')
    }

    function openPanel() {
      if (!panel) panel = makePanel()
      panel.hidden = false
      entry?.setAttribute('data-active', 'true')
      panel.__dshProse?.loadConfig()
      setTimeout(() => panel?.querySelector('[data-prose-text]')?.focus(), 40)
    }

    function closePanel() {
      if (panel) panel.hidden = true
      entry?.removeAttribute('data-active')
    }

    const inject = []

    function diag(step, extra) {
      try {
        const payload = JSON.stringify({
          step,
          extra: extra || null,
          ts: Date.now(),
          ready: document.readyState,
          nodes: document.body ? document.body.getElementsByTagName('*').length : -1,
          sidebar: Boolean(sidebarRoot()),
          mounted: Boolean(document.querySelector(`[${ENTRY_ATTR}]`)),
        })
        if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
          navigator.sendBeacon('/api/dsh-prose-polish/diag', payload)
        } else if (typeof fetch === 'function') {
          fetch('/api/dsh-prose-polish/diag', { method: 'POST', body: payload, keepalive: true }).catch(() => {})
        }
      } catch (error) {
        /* diagnostics must never throw */
      }
    }

    function apply() {
      if (typeof document === 'undefined') return
      diag('apply-enter')
      try {
        injectStyle()
        diag('style-ok')
      } catch (error) {
        diag('style-fail', String(error && error.message ? error.message : error))
      }
      try {
        startMount()
        diag('mount-started', mountTimer === null ? 'inline' : 'polling')
      } catch (error) {
        diag('mount-fail', String(error && error.message ? error.message : error))
      }
      if (!keydownBound) {
        keydownBound = true
        document.addEventListener('keydown', (event) => {
          if (event.key === 'Escape' && panel && !panel.hidden) closePanel()
        })
      }
      entry?.removeAttribute('data-active')
      diag('apply-done')
    }

    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
