/**
 * dsh-comfyui - browser half.
 *
 * A small, dependency-free sidebar studio.  It deliberately uses a full-screen
 * overlay rather than taking over DSH's conversation column, so it can be
 * opened from any conversation without disrupting the chat layout.
 */
window.__ModuleLoader__.load({
  id: 'dsh-comfyui',
  factory: () => {
    const module = { exports: {} }
    const exports = module.exports
const API = '/api/dsh-comfyui'
const ENTRY_ATTR = 'data-dsh-comfyui-entry'
const STYLE_ID = 'dsh-comfyui-style'
const PANEL_ID = 'dsh-comfyui-panel'

let panel = null
let entry = null
let observer = null

const CSS = `
.dsh-comfyui-entry{display:flex;align-items:center;gap:8px;width:100%;padding:8px 10px;margin:2px 0;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--dsh-text-secondary,#9aa4b2);font:inherit;font-size:13px;cursor:pointer;text-align:left;white-space:nowrap;overflow:hidden}
.dsh-comfyui-entry:hover{background:rgba(255,255,255,.055);color:var(--dsh-text-primary,#e8eaed)}
.dsh-comfyui-entry[data-active="true"]{border-color:rgba(214,168,88,.35);background:rgba(214,168,88,.08);color:#e4c07a}
.dsh-comfyui-entry .dsh-comfyui-entry-icon{display:grid;place-items:center;width:18px;height:18px;color:#d6a858;font-size:15px}
.dsh-comfyui-backdrop[hidden]{display:none}
.dsh-comfyui-backdrop{position:fixed;inset:0;z-index:1200;display:grid;place-items:center;padding:24px;background:rgba(2,8,12,.72);backdrop-filter:blur(8px)}
.dsh-comfyui-panel{width:min(980px,100%);max-height:calc(100vh - 32px);display:flex;flex-direction:column;overflow:hidden;border:1px solid rgba(214,168,88,.25);border-radius:16px;background:linear-gradient(160deg,#111d24,#0a1418 62%,#101a17);box-shadow:0 28px 80px rgba(0,0,0,.55),inset 0 1px 0 rgba(255,255,255,.05);color:#e8e2d4;font-family:ui-serif,"Noto Serif SC",serif}
.dsh-comfyui-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex:0 0 auto;padding:22px 24px 14px;border-bottom:1px solid rgba(255,255,255,.06)}
.dsh-comfyui-kicker{font:11px/1.2 ui-monospace,monospace;letter-spacing:.22em;color:#9d8b65;text-transform:uppercase}
.dsh-comfyui-title{margin:6px 0 0;font-size:26px;font-weight:600;letter-spacing:.06em;color:#f0e6cf}
.dsh-comfyui-close{width:34px;height:34px;border:1px solid rgba(214,168,88,.25);border-radius:9px;background:transparent;color:#c9b993;font-size:20px;cursor:pointer}
.dsh-comfyui-close:hover{background:rgba(214,168,88,.1);color:#f0dfb8}
.dsh-comfyui-body{padding:18px 24px 24px;overflow:auto;flex:1 1 auto;min-height:0}
.dsh-comfyui-grid{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,.85fr);gap:18px}
.dsh-comfyui-card{border:1px solid rgba(255,255,255,.075);border-radius:11px;background:rgba(255,255,255,.018);padding:13px}
.dsh-comfyui-label{display:block;margin:0 0 5px;font:10px/1.2 ui-monospace,monospace;letter-spacing:.14em;color:#a89b82;text-transform:uppercase}
.dsh-comfyui-input,.dsh-comfyui-select,.dsh-comfyui-textarea{width:100%;box-sizing:border-box;border:1px solid rgba(214,168,88,.18);border-radius:7px;background:rgba(0,0,0,.22);color:#eee6d5;padding:8px 9px;font:13px/1.45 ui-serif,"Noto Serif SC",serif;outline:none}
.dsh-comfyui-input:focus,.dsh-comfyui-select:focus,.dsh-comfyui-textarea:focus{border-color:rgba(214,168,88,.56);box-shadow:0 0 0 2px rgba(214,168,88,.08)}
.dsh-comfyui-textarea{min-height:92px;resize:vertical}
.dsh-comfyui-row{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.dsh-comfyui-row3{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.dsh-comfyui-btn{border:1px solid rgba(214,168,88,.3);border-radius:7px;background:rgba(214,168,88,.06);color:#e3c98f;padding:8px 12px;font:12px/1.2 ui-serif,"Noto Serif SC",serif;cursor:pointer}
.dsh-comfyui-btn:hover{background:rgba(214,168,88,.14);border-color:rgba(214,168,88,.55)}
.dsh-comfyui-btn.primary{background:linear-gradient(135deg,#b78743,#d9ae62);border-color:#d6a858;color:#1b1307;font-weight:700}
.dsh-comfyui-btn:disabled{opacity:.4;cursor:not-allowed}
.dsh-comfyui-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
.dsh-comfyui-status{min-height:19px;margin-top:9px;font:12px/1.45 ui-monospace,monospace;color:#a9b7b3;white-space:pre-wrap;overflow-wrap:anywhere}
.dsh-comfyui-status.bad{color:#e69a8c}
.dsh-comfyui-status.good{color:#9fcf9c}
.dsh-comfyui-hint{margin:8px 0 0;font:11px/1.55 ui-monospace,monospace;color:#7f8f8b}
.dsh-comfyui-gallery{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-top:12px}
.dsh-comfyui-shot{position:relative;aspect-ratio:1;border:1px solid rgba(255,255,255,.08);border-radius:8px;overflow:hidden;background:#060b0d;cursor:zoom-in}
.dsh-comfyui-shot img{width:100%;height:100%;object-fit:cover;display:block}
.dsh-comfyui-shot:hover{border-color:rgba(214,168,88,.5)}
.dsh-comfyui-shot-meta{position:absolute;left:0;right:0;bottom:0;padding:16px 6px 5px;background:linear-gradient(transparent,rgba(0,0,0,.75));font:9px/1.2 ui-monospace,monospace;color:#d8c8a8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-comfyui-shot-empty{grid-column:1/-1;border:1px dashed rgba(255,255,255,.1);border-radius:8px;padding:20px;text-align:center;color:#7b8a86;font:11px/1.5 ui-monospace,monospace}
.dsh-comfyui-foot{display:flex;justify-content:space-between;gap:12px;flex:0 0 auto;padding:10px 24px 16px;border-top:1px solid rgba(255,255,255,.06);font:10px/1.4 ui-monospace,monospace;color:#7f8b86}
.dsh-comfyui-path{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:64%}
@media(max-width:720px){.dsh-comfyui-backdrop{padding:8px}.dsh-comfyui-panel{max-height:calc(100vh - 16px)}.dsh-comfyui-grid{display:flex;flex-direction:column}.dsh-comfyui-grid>*:first-child{order:2}.dsh-comfyui-grid>*:last-child{display:contents}.dsh-comfyui-grid>*:last-child>.dsh-comfyui-card:first-child{order:1}.dsh-comfyui-grid>*:last-child>.dsh-comfyui-card:last-child{order:3}.dsh-comfyui-grid{grid-template-columns:1fr}.dsh-comfyui-gallery{grid-template-columns:repeat(2,minmax(0,1fr))}.dsh-comfyui-body{padding:14px}.dsh-comfyui-head{padding:16px 16px 10px}.dsh-comfyui-foot{padding:8px 16px 12px}}
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
    node.className = 'dsh-comfyui-entry'
    node.innerHTML = '<span class="dsh-comfyui-entry-icon">◈</span><span>本地生图</span>'
    node.title = '打开本地 ComfyUI 生图面板'
    node.addEventListener('click', () => openPanel())
  }
  const host = button.parentElement
  if (host && (node.parentElement !== host || node.previousElementSibling !== button)) {
    host.insertBefore(node, button.nextSibling)
  }
  entry = node
  return true
}

function startObserver() {
  if (observer) return
  observer = new MutationObserver(() => { placeEntry() })
  observer.observe(document.body, { childList: true, subtree: true })
  placeEntry()
}

function makePanel() {
  const backdrop = document.createElement('div')
  backdrop.className = 'dsh-comfyui-backdrop'
  backdrop.hidden = true
  backdrop.innerHTML = `
    <section class="dsh-comfyui-panel" role="dialog" aria-modal="true" aria-label="本地 ComfyUI 生图">
      <header class="dsh-comfyui-head">
        <div>
          <div class="dsh-comfyui-kicker">LOCAL COMFYUI · 本机生成</div>
          <h2 class="dsh-comfyui-title">本地生图</h2>
        </div>
        <button type="button" class="dsh-comfyui-close" data-comfy-close aria-label="关闭">×</button>
      </header>
      <div class="dsh-comfyui-body">
        <div class="dsh-comfyui-grid">
          <div>
            <div class="dsh-comfyui-card">
              <label class="dsh-comfyui-label">正向提示词</label>
              <textarea class="dsh-comfyui-textarea" data-comfy-prompt placeholder="例如：夜色海港，潮灯酒馆，电影感，2.5D，无文字…"></textarea>
              <label class="dsh-comfyui-label" style="margin-top:10px">负向提示词</label>
              <textarea class="dsh-comfyui-textarea" data-comfy-negative style="min-height:52px" placeholder="text, watermark, logo, blurry, low quality">text, watermark, logo, blurry, low quality</textarea>
              <div class="dsh-comfyui-row" style="margin-top:10px">
                <div><label class="dsh-comfyui-label">尺寸</label>
                  <select class="dsh-comfyui-select" data-comfy-size>
                    <option value="1344x768">横版 1344×768</option>
                    <option value="768x1344">竖版 768×1344</option>
                    <option value="1024x1024">方图 1024×1024</option>
                    <option value="1536x864">宽屏 1536×864</option>
                  </select>
                </div>
                <div><label class="dsh-comfyui-label">Checkpoint</label>
                  <input class="dsh-comfyui-input" data-comfy-checkpoint list="dsh-comfyui-checkpoints" placeholder="juggernautXL_v9.safetensors">
                  <datalist id="dsh-comfyui-checkpoints"></datalist>
                </div>
              </div>
              <div class="dsh-comfyui-row" style="margin-top:10px">
                <div><label class="dsh-comfyui-label">LoRA</label>
                  <select class="dsh-comfyui-select" data-comfy-lora><option value="">不使用 LoRA</option></select>
                </div>
                <div><label class="dsh-comfyui-label">LoRA 强度</label><input class="dsh-comfyui-input" data-comfy-lora-strength type="number" min="0" max="1.5" step="0.05" value="0.8"></div>
              </div>
              <div class="dsh-comfyui-row3" style="margin-top:10px">
                <div><label class="dsh-comfyui-label">Steps</label><input class="dsh-comfyui-input" data-comfy-steps type="number" min="1" max="80" value="28"></div>
                <div><label class="dsh-comfyui-label">CFG</label><input class="dsh-comfyui-input" data-comfy-cfg type="number" min="0" max="20" step="0.5" value="5.5"></div>
                <div><label class="dsh-comfyui-label">Batch</label><input class="dsh-comfyui-input" data-comfy-batch type="number" min="1" max="4" value="1"></div>
              </div>
              <div class="dsh-comfyui-actions">
                <button type="button" class="dsh-comfyui-btn primary" data-comfy-generate>生成</button>
                <button type="button" class="dsh-comfyui-btn" data-comfy-check>测试连接</button>
                <button type="button" class="dsh-comfyui-btn" data-comfy-models>刷新模型</button>
                <button type="button" class="dsh-comfyui-btn" data-comfy-cancel>中断队列</button>
              </div>
              <div class="dsh-comfyui-status" data-comfy-status>正在读取本地设置…</div>
            </div>
            <p class="dsh-comfyui-hint">生成请求由 DSH 本机代理转发到 ComfyUI；图片写入下方输出目录。此面板仅在 127.0.0.1 / localhost 可用。</p>
          </div>
          <div>
            <div class="dsh-comfyui-card">
              <label class="dsh-comfyui-label">ComfyUI 地址</label>
              <input class="dsh-comfyui-input" data-comfy-url placeholder="http://127.0.0.1:8188">
              <label class="dsh-comfyui-label" style="margin-top:10px">输出目录</label>
              <input class="dsh-comfyui-input" data-comfy-outdir placeholder="C:\\Users\\你\\Pictures\\DSH-ComfyUI">
              <div class="dsh-comfyui-actions">
                <button type="button" class="dsh-comfyui-btn" data-comfy-save>保存设置</button>
                <button type="button" class="dsh-comfyui-btn" data-comfy-folder>打开目录</button>
              </div>
              <div class="dsh-comfyui-hint">修改设置后点「保存设置」，下次启动仍然生效。</div>
            </div>
            <div class="dsh-comfyui-card" style="margin-top:12px">
              <label class="dsh-comfyui-label">最近生成</label>
              <div class="dsh-comfyui-gallery" data-comfy-gallery><div class="dsh-comfyui-shot-empty">还没有生成图片</div></div>
            </div>
          </div>
        </div>
      </div>
      <footer class="dsh-comfyui-foot">
        <span class="dsh-comfyui-path" data-comfy-path>—</span>
        <span>dsh-comfyui · local only</span>
      </footer>
    </section>`
  document.body.appendChild(backdrop)
  backdrop.addEventListener('click', event => {
    if (event.target === backdrop) closePanel()
  })
  backdrop.querySelector('[data-comfy-close]').addEventListener('click', closePanel)
  const q = selector => backdrop.querySelector(selector)
  q('[data-comfy-save]').addEventListener('click', () => saveSettings(true))
  q('[data-comfy-check]').addEventListener('click', checkStatus)
  q('[data-comfy-models]').addEventListener('click', refreshModels)
  q('[data-comfy-folder]').addEventListener('click', async () => {
    try {
      const res = await fetch(`${API}/open-folder`, { method: 'POST' })
      const data = await res.json()
      setStatus(data.ok ? `已打开 ${data.outputDir}` : data.message, !data.ok)
    } catch (error) { setStatus(String(error), true) }
  })
  q('[data-comfy-cancel]').addEventListener('click', async () => {
    try {
      const res = await fetch(`${API}/cancel`, { method: 'POST' })
      const data = await res.json()
      setStatus(data.ok ? '已发送中断请求' : data.message, !data.ok)
    } catch (error) { setStatus(String(error), true) }
  })
  q('[data-comfy-generate]').addEventListener('click', generate)
  return backdrop
}

function setStatus(text, bad = false, good = false) {
  const node = panel?.querySelector('[data-comfy-status]')
  if (!node) return
  node.textContent = text
  node.classList.toggle('bad', Boolean(bad))
  node.classList.toggle('good', Boolean(good))
}

function openPanel() {
  injectStyle()
  if (!panel) panel = makePanel()
  panel.hidden = false
  entry?.setAttribute('data-active', 'true')
  loadSettings()
  loadGallery()
}

function closePanel() {
  if (panel) panel.hidden = true
  entry?.removeAttribute('data-active')
}

async function loadSettings() {
  try {
    const res = await fetch(`${API}/config`)
    const data = await res.json()
    if (!data.ok) throw new Error(data.message || '读取设置失败')
    const cfg = data.config
    panel.querySelector('[data-comfy-url]').value = cfg.baseUrl || ''
    panel.querySelector('[data-comfy-outdir]').value = cfg.outputDir || ''
    panel.querySelector('[data-comfy-checkpoint]').value = cfg.checkpoint || ''
    panel.querySelector('[data-comfy-lora]').value = cfg.lora || ''
    panel.querySelector('[data-comfy-lora-strength]').value = cfg.loraStrength ?? 0.8
    panel.querySelector('[data-comfy-steps]').value = cfg.steps ?? 28
    panel.querySelector('[data-comfy-cfg]').value = cfg.cfg ?? 5.5
    panel.querySelector('[data-comfy-batch]').value = cfg.batch ?? 1
    const size = panel.querySelector('[data-comfy-size]')
    const target = `${cfg.width}x${cfg.height}`
    if (Array.from(size.options).some(option => option.value === target)) size.value = target
    panel.querySelector('[data-comfy-path]').textContent = cfg.outputDir || '—'
    setStatus(`配置已载入 · ${cfg.baseUrl}`, false, true)
    void refreshModels().then(() => {
      const lora = panel.querySelector('[data-comfy-lora]')
      if (lora && cfg.lora) lora.value = cfg.lora
    })
  } catch (error) {
    setStatus(`读取设置失败：${error instanceof Error ? error.message : String(error)}`, true)
  }
}

async function saveSettings(notify = false) {
  const [width, height] = String(panel.querySelector('[data-comfy-size]').value).split('x').map(Number)
  const body = {
    baseUrl: panel.querySelector('[data-comfy-url]').value.trim(),
    outputDir: panel.querySelector('[data-comfy-outdir]').value.trim(),
    checkpoint: panel.querySelector('[data-comfy-checkpoint]').value.trim(),
    lora: panel.querySelector('[data-comfy-lora]').value,
    loraStrength: Number(panel.querySelector('[data-comfy-lora-strength]').value),
    width,
    height,
    steps: Number(panel.querySelector('[data-comfy-steps]').value),
    cfg: Number(panel.querySelector('[data-comfy-cfg]').value),
    batch: Number(panel.querySelector('[data-comfy-batch]').value),
  }
  const res = await fetch(`${API}/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json()
  if (!data.ok) throw new Error(data.message || '保存失败')
  panel.querySelector('[data-comfy-path]').textContent = data.config.outputDir
  if (notify) setStatus('设置已保存', false, true)
  return data.config
}

async function refreshModels() {
  try {
    const res = await fetch(`${API}/models`)
    const data = await res.json()
    if (!data.ok) return
    const list = panel.querySelector('#dsh-comfyui-checkpoints')
    list.textContent = ''
    for (const name of data.checkpoints || []) {
      const option = document.createElement('option')
      option.value = name
      list.appendChild(option)
    }
    if (data.checkpoints?.length && !panel.querySelector('[data-comfy-checkpoint]').value) {
      panel.querySelector('[data-comfy-checkpoint]').value = data.checkpoints[0]
    }
    const loraSelect = panel.querySelector('[data-comfy-lora]')
    if (loraSelect) {
      const current = loraSelect.value
      loraSelect.textContent = ''
      const none = document.createElement('option')
      none.value = ''
      none.textContent = '不使用 LoRA'
      loraSelect.appendChild(none)
      for (const name of data.loras || []) {
        const option = document.createElement('option')
        option.value = name
        option.textContent = data.loraLabels?.[name] || name
        option.title = name
        loraSelect.appendChild(option)
      }
      loraSelect.value = current
      if (loraSelect.value !== current) loraSelect.value = ''
    }
  } catch {
    // 模型发现失败不阻塞生成；ComfyUI 会给出更具体的错误。
  }
}

async function checkStatus() {
  setStatus('正在连接 ComfyUI…')
  try {
    const res = await fetch(`${API}/status`)
    const data = await res.json()
    if (data.online) {
      const q = data.queue ? `队列 ${data.queue.running} 运行 / ${data.queue.pending} 等待` : '队列不可读'
      setStatus(`ComfyUI 在线 · ${data.version} · ${q} · ${data.latencyMs}ms`, false, true)
    } else {
      setStatus(`ComfyUI 离线：${data.message || '无法连接'}`, true)
    }
  } catch (error) {
    setStatus(`连接失败：${error instanceof Error ? error.message : String(error)}`, true)
  }
}

async function generate() {
  const button = panel.querySelector('[data-comfy-generate]')
  const prompt = panel.querySelector('[data-comfy-prompt]').value.trim()
  if (!prompt) { setStatus('先写提示词', true); return }
  button.disabled = true
  setStatus('正在提交到 ComfyUI 队列…')
  try {
    const cfg = await saveSettings(false)
    const body = {
      prompt,
      negative: panel.querySelector('[data-comfy-negative]').value.trim(),
      width: cfg.width,
      height: cfg.height,
      steps: cfg.steps,
      cfg: cfg.cfg,
      batch: cfg.batch,
      checkpoint: cfg.checkpoint,
      lora: cfg.lora,
      loraStrength: cfg.loraStrength,
    }
    const res = await fetch(`${API}/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json()
    if (!data.ok) throw new Error(data.message || '生成失败')
    setStatus(`完成 · ${data.images.length} 张 · seed ${data.seed} · ${(data.elapsedMs / 1000).toFixed(1)}s`, false, true)
    for (const image of data.images) prependShot(image)
    void loadGallery()
  } catch (error) {
    setStatus(`生成失败：${error instanceof Error ? error.message : String(error)}`, true)
  } finally {
    button.disabled = false
  }
}

function prependShot(image) {
  const galleryNode = panel.querySelector('[data-comfy-gallery]')
  const empty = galleryNode.querySelector('.dsh-comfyui-shot-empty')
  if (empty) empty.remove()
  const shot = makeShot(image)
  galleryNode.insertBefore(shot, galleryNode.firstChild)
}

function makeShot(image) {
  const holder = document.createElement('div')
  holder.className = 'dsh-comfyui-shot'
  holder.title = image.name
  const img = document.createElement('img')
  img.src = image.url
  img.loading = 'lazy'
  img.alt = image.name
  const meta = document.createElement('div')
  meta.className = 'dsh-comfyui-shot-meta'
  meta.textContent = image.name
  holder.append(img, meta)
  holder.addEventListener('click', () => window.open(image.url, '_blank', 'noopener'))
  return holder
}

async function loadGallery() {
  try {
    const res = await fetch(`${API}/gallery?limit=24`)
    const data = await res.json()
    if (!data.ok) return
    const galleryNode = panel.querySelector('[data-comfy-gallery]')
    galleryNode.textContent = ''
    if (!data.images?.length) {
      const empty = document.createElement('div')
      empty.className = 'dsh-comfyui-shot-empty'
      empty.textContent = '还没有生成图片'
      galleryNode.appendChild(empty)
      return
    }
    for (const image of data.images) galleryNode.appendChild(makeShot(image))
    panel.querySelector('[data-comfy-path]').textContent = data.outputDir || '—'
  } catch {
    // 保持上次结果。
  }
}

const inject = []

function apply() {
  if (typeof document === 'undefined') return
  injectStyle()
  startObserver()
  const mountTimer = setInterval(() => {
    if (placeEntry()) clearInterval(mountTimer)
  }, 600)
  setTimeout(() => clearInterval(mountTimer), 15000)
  if (!document.getElementById(PANEL_ID)) {
    // 面板按需创建；PID 仅用于避免重复初始化。
    const guard = document.createElement('meta')
    guard.id = PANEL_ID
    document.head.appendChild(guard)
  }
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && panel && !panel.hidden) closePanel()
  })
  entry?.removeAttribute('data-active')
}

exports.inject = inject
exports.apply = apply
return module.exports
  }
})
