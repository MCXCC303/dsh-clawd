/**
 * dsh-clawd — browser half.
 *
 * A plain-JS Client module (no bundler, no imports beyond `react`, which comes
 * from the browser module table). It renders:
 *
 *   * `shell.overlay` — the pet itself: draggable, click-reactive, crossfading
 *     between the artwork URLs the host publishes;
 *   * `settings.section` — the Clawd settings page.
 *
 * It deliberately owns **no state machine**: it renders `payload.asset.url` and
 * `payload.state` exactly as the host computed them, and sends intents back
 * (`settings`, `react`, `refresh`). That keeps the state table single-sourced in
 * `lib/state.js` on the host — the lesson of the reference project, whose PWA
 * kept a hand-copied table that drifted.
 *
 * @module dsh-clawd/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-clawd',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const BASE = '/dsh-clawd/'
    const POLL_MS = 1500
    const NS = 'dsh-clawd'

    const EN = {
      'settings.title': 'Clawd',
      'settings.subtitle': 'A pixel pet that follows what this Harness is doing.',
      'settings.enabled': 'Show the pet',
      'settings.enabledHint': 'Turn the overlay off without unloading the plugin.',
      'settings.theme': 'Theme',
      'settings.themeHint': 'Themes come from the plugin, its local-only art folder, and $DSH_HOME/dsh-clawd/themes.',
      'settings.size': 'Size',
      'settings.sizeHint': 'Height of the pet in pixels.',
      'settings.opacity': 'Opacity',
      'settings.sounds': 'Chime on turn end',
      'settings.soundsHint': 'A short tone when a turn finishes, and a lower one when it fails.',
      'settings.position': 'Position',
      'settings.resetPosition': 'Reset to the corner',
      'settings.reload': 'Reload themes',
      'settings.reloadHint': 'Re-read theme directories after editing artwork on disk.',
      'settings.state': 'Now',
      'settings.noTheme': 'No theme is available. Run `npm run setup-local-art` in the plugin checkout, or drop a theme into $DSH_HOME/dsh-clawd/themes.',
      'settings.unreachable': 'The plugin host half is not answering yet.',
      'state.idle': 'idle',
      'state.thinking': 'thinking',
      'state.working': 'working',
      'state.attention': 'done',
      'state.error': 'error',
      'state.notification': 'waiting for you',
      'state.sweeping': 'compacting',
      'state.juggling': 'subagents',
      'state.carrying': 'carrying',
      'state.sleeping': 'sleeping',
      'state.yawning': 'yawning',
      'state.dozing': 'dozing',
      'state.collapsing': 'curling up',
      'state.waking': 'waking up',
      'state.roam': 'roaming',
      'status.sessions': 'sessions',
      'status.tools': 'tools running',
      'status.subagents': 'subagents',
    }

    const ZH = {
      'settings.title': 'Clawd',
      'settings.subtitle': '一只跟着 Harness 干活状态换动作的像素宠物。',
      'settings.enabled': '显示宠物',
      'settings.enabledHint': '关掉浮层，但插件仍然加载。',
      'settings.theme': '主题',
      'settings.themeHint': '主题来自插件内置目录、本地素材目录，以及 $DSH_HOME/dsh-clawd/themes。',
      'settings.size': '大小',
      'settings.sizeHint': '宠物的像素高度。',
      'settings.opacity': '不透明度',
      'settings.sounds': '回合结束提示音',
      'settings.soundsHint': '一轮结束时响一声；出错时响更低的一声。',
      'settings.position': '位置',
      'settings.resetPosition': '回到默认角落',
      'settings.reload': '重载主题',
      'settings.reloadHint': '在磁盘上改完素材后重新读取主题目录。',
      'settings.state': '当前状态',
      'settings.noTheme': '没有可用主题。请在插件目录执行 `npm run setup-local-art`，或把主题放进 $DSH_HOME/dsh-clawd/themes。',
      'settings.unreachable': '插件宿主半边还没有响应。',
      'state.idle': '发呆',
      'state.thinking': '思考中',
      'state.working': '干活中',
      'state.attention': '完成了',
      'state.error': '出错了',
      'state.notification': '等你确认',
      'state.sweeping': '压缩上下文',
      'state.juggling': '多线程分身',
      'state.carrying': '搬运中',
      'state.sleeping': '睡着了',
      'state.yawning': '打哈欠',
      'state.dozing': '打瞌睡',
      'state.collapsing': '蜷起来了',
      'state.waking': '醒来了',
      'state.roam': '溜达',
      'status.sessions': '个会话',
      'status.tools': '个工具在跑',
      'status.subagents': '个子代理',
    }

    // ------------------------------------------------------------------ util ---

    /** Minimal external store: one payload, many subscribers. */
    function createStore() {
      let value = null
      const listeners = new Set()
      return {
        get: () => value,
        set(next) {
          value = next
          for (const listener of [...listeners]) listener()
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      }
    }

    function useStore(store) {
      const [value, setValue] = React.useState(store.get())
      React.useEffect(() => store.subscribe(() => setValue(store.get())), [store])
      return value
    }

    function clamp(value, min, max) {
      return Math.min(max, Math.max(min, value))
    }

    /**
     * Feed the store from the host half: one snapshot fetch, then the live SSE
     * stream, falling back to polling when a stream cannot be established.
     * @returns {() => void} disposer.
     */
    function connect(store, onLine) {
      let closed = false
      let source = null
      let poller = null
      let failures = 0

      const read = async () => {
        try {
          const response = await fetch(`${BASE}state.json`, { credentials: 'same-origin' })
          if (!response.ok) throw new Error(`state.json answered ${response.status}`)
          store.set(await response.json())
          onLine?.(true)
        } catch (error) {
          failures += 1
          if (failures === 3) onLine?.(false)
          return false
        }
        return true
      }

      const startPolling = () => {
        if (poller !== null || closed) return
        poller = setInterval(read, POLL_MS)
      }

      void read().then((ok) => {
        if (closed || !ok) startPolling()
      })

      try {
        source = new EventSource(`${BASE}live`, { withCredentials: true })
        source.onmessage = (message) => {
          try {
            store.set(JSON.parse(message.data))
            failures = 0
            onLine?.(true)
            if (poller !== null) {
              clearInterval(poller)
              poller = null
            }
          } catch {
            /* ignore a malformed frame */
          }
        }
        source.onerror = () => {
          if (source && source.readyState === 2) startPolling()
        }
      } catch {
        startPolling()
      }

      const onVisible = () => {
        if (document.visibilityState === 'visible') void read()
      }
      document.addEventListener('visibilitychange', onVisible)

      return () => {
        closed = true
        document.removeEventListener('visibilitychange', onVisible)
        if (poller !== null) clearInterval(poller)
        try {
          source?.close()
        } catch {
          /* already closed */
        }
      }
    }

    async function post(route, body) {
      try {
        const response = await fetch(`${BASE}${route}`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body ?? {}),
        })
        if (!response.ok) return null
        return await response.json()
      } catch {
        return null
      }
    }

    /** Short two-tone chime; the AudioContext is created on the first gesture. */
    function createChime() {
      let context = null
      const ensure = () => {
        if (context) return context
        const Ctor = window.AudioContext || window.webkitAudioContext
        if (!Ctor) return null
        try {
          context = new Ctor()
        } catch {
          context = null
        }
        return context
      }
      return (kind) => {
        const audio = ensure()
        if (!audio) return
        if (audio.state === 'suspended') void audio.resume()
        const notes = kind === 'error' ? [392, 261.6] : [523.25, 783.99]
        notes.forEach((frequency, index) => {
          const oscillator = audio.createOscillator()
          const gain = audio.createGain()
          const start = audio.currentTime + index * 0.12
          oscillator.type = 'sine'
          oscillator.frequency.value = frequency
          gain.gain.setValueAtTime(0.0001, start)
          gain.gain.exponentialRampToValueAtTime(0.08, start + 0.02)
          gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.2)
          oscillator.connect(gain).connect(audio.destination)
          oscillator.start(start)
          oscillator.stop(start + 0.24)
        })
      }
    }

    // ------------------------------------------------------------------- pet ---

    const OVERLAY_CSS = `
.clawd-root{position:fixed;left:0;top:0;pointer-events:none;user-select:none;touch-action:none;
  font-family:inherit;transition:opacity .18s ease}
.clawd-stage{position:relative;pointer-events:auto;cursor:grab}
.clawd-stage.clawd-dragging{cursor:grabbing}
.clawd-layer{position:absolute;display:block;pointer-events:none;-webkit-user-drag:none}
.clawd-layer.clawd-enter{animation:clawd-in .22s ease both}
.clawd-layer.clawd-leave{animation:clawd-out .22s ease both}
@keyframes clawd-in{from{opacity:0;transform:translateY(2px) scale(.985)}to{opacity:1;transform:none}}
@keyframes clawd-out{from{opacity:1}to{opacity:0}}
.clawd-pill{position:absolute;left:50%;bottom:100%;transform:translateX(-50%);margin-bottom:6px;
  display:flex;align-items:center;gap:6px;white-space:nowrap;padding:3px 8px;border-radius:999px;
  background:var(--dsw-alias-bg-overlay,#1b1d22);color:var(--dsw-alias-label-primary,#eee);
  border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.14));font-size:11px;line-height:16px;
  opacity:0;transition:opacity .15s ease;pointer-events:none}
.clawd-stage:hover .clawd-pill{opacity:1}
.clawd-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-brand-primary,#4c8dff)}
.clawd-dot.clawd-busy{background:var(--dsw-alias-state-warn-primary,#e0a33e)}
.clawd-dot.clawd-alert{background:var(--dsw-alias-state-error-primary,#e05c5c)}
`

    /**
     * Where the character actually sits inside the artwork, and how big the
     * `<img>` has to be drawn so that the *character* — not its viewBox — fills
     * the requested height. Themes whose artwork has generous transparent
     * margins (the Clawd set has 45 units of viewBox around 20 units of cat)
     * declare `contentBox`; without one the whole viewBox is the content.
     */
    function layoutOf(theme, size) {
      const view = theme?.viewBox ?? { x: 0, y: 0, width: 64, height: 64 }
      const content = theme?.contentBox ?? { x: view.x, y: view.y, width: view.width, height: view.height }
      const scale = size / content.height
      return {
        width: Math.round(content.width * scale),
        height: Math.round(size),
        imageStyle: {
          left: `${Math.round(-(content.x - view.x) * scale)}px`,
          top: `${Math.round(-(content.y - view.y) * scale)}px`,
          width: `${Math.round(view.width * scale)}px`,
          height: `${Math.round(view.height * scale)}px`,
        },
      }
    }

    function PetView(props) {
      const payload = useStore(props.store)
      const t = props.t
      const [local, setLocal] = React.useState(null)
      const [dragging, setDragging] = React.useState(false)
      const [shown, setShown] = React.useState({ url: null, previous: null })
      const [online, setOnline] = React.useState(true)
      const dragRef = React.useRef(null)
      const chimeRef = React.useRef(null)

      React.useEffect(() => {
        const off = props.onLine?.((value) => setOnline(value))
        return () => off?.()
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])

      // Warm the browser cache for the states that are one swap away.
      React.useEffect(() => {
        for (const url of payload?.preload ?? []) {
          const image = new Image()
          image.src = url
        }
      }, [payload?.theme?.rev])

      const settings = payload?.settings ?? {}
      const asset = payload?.asset ?? null
      const theme = payload?.theme ?? null
      const size = Number(settings.size) || 64
      const layout = layoutOf(theme, size)
      const width = layout.width
      const height = layout.height

      // Crossfade: remember the outgoing artwork URL for one animation.
      React.useEffect(() => {
        if (!asset?.url) return
        setShown((current) => (current.url === asset.url ? current : { url: asset.url, previous: current.url }))
      }, [asset?.url])

      // Default position: bottom-right, above the composer; the user's own
      // position (persisted by the host) wins as soon as one exists.
      const stored = settings.position && Number.isFinite(settings.position.x) ? settings.position : null
      const position = local ?? stored ?? {
        x: Math.max(12, (window.innerWidth || 1200) - width - 36),
        y: Math.max(12, (window.innerHeight || 800) - height - 150),
      }

      React.useEffect(() => {
        const onResize = () => {
          setLocal((current) => {
            if (!current) return current
            return {
              x: clamp(current.x, 0, Math.max(0, window.innerWidth - width)),
              y: clamp(current.y, 0, Math.max(0, window.innerHeight - height)),
            }
          })
        }
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
      }, [width, height])

      // Chime on the transitions the user asked to hear.
      React.useEffect(() => {
        if (!settings.sounds || !payload?.state) return
        if (payload.state !== 'attention' && payload.state !== 'error') return
        if (!chimeRef.current) chimeRef.current = createChime()
        chimeRef.current(payload.state === 'error' ? 'error' : 'done')
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [payload?.state, payload?.rev])

      const onPointerDown = (event) => {
        if (event.button !== 0) return
        dragRef.current = { px: event.clientX, py: event.clientY, x: position.x, y: position.y, moved: false }
        event.currentTarget.setPointerCapture?.(event.pointerId)
        setDragging(true)
      }

      const onPointerMove = (event) => {
        const drag = dragRef.current
        if (!drag) return
        const dx = event.clientX - drag.px
        const dy = event.clientY - drag.py
        if (!drag.moved && Math.hypot(dx, dy) > 4) {
          drag.moved = true
          // The drag pose is *held*, not played once: the host keeps it up until
          // we release it, so it lasts exactly as long as the gesture does.
          void post('react', { kind: 'drag', phase: 'hold' })
        }
        if (!drag.moved) return
        // The committed position lives on the drag record, so a pointerup that
        // arrives before React re-rendered still persists where the pet landed.
        drag.last = {
          x: clamp(drag.x + dx, 0, Math.max(0, window.innerWidth - width)),
          y: clamp(drag.y + dy, 0, Math.max(0, window.innerHeight - height)),
        }
        setLocal(drag.last)
      }

      const releaseDragPose = (drag) => {
        if (!drag?.moved || drag.released) return
        drag.released = true
        void post('react', { kind: 'drag', phase: 'release' })
      }

      const endDrag = async (event) => {
        const drag = dragRef.current
        dragRef.current = null
        setDragging(false)
        if (!drag) return
        if (drag.moved) {
          releaseDragPose(drag)
          await post('settings', { position: drag.last ?? position })
          return
        }
        if (event?.type === 'pointerup') void post('react', { kind: 'clickLeft' })
      }

      const onDoubleClick = () => void post('react', { kind: 'double' })
      const onContextMenu = (event) => {
        event.preventDefault()
        void post('react', { kind: 'annoyed' })
      }

      // A drag whose pointerup never arrives — the window lost focus, or the
      // overlay unmounted mid-gesture — must not leave the pose held.
      React.useEffect(() => {
        const abandon = () => {
          const drag = dragRef.current
          dragRef.current = null
          setDragging(false)
          releaseDragPose(drag)
        }
        window.addEventListener('blur', abandon)
        return () => {
          window.removeEventListener('blur', abandon)
          abandon()
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])

      if (!payload) return null
      if (settings.enabled === false || !asset) return null

      const counts = payload.counts ?? {}
      const busy = (counts.working ?? 0) > 0 || (counts.busy ?? 0) > 0
      const alert = payload.state === 'error' || payload.state === 'notification'
      const label = t(`state.${payload.state}`)
      const details = []
      if (counts.sessions) details.push(`${counts.sessions} ${t('status.sessions')}`)
      if (counts.working) details.push(`${counts.working} ${t('status.tools')}`)
      if (counts.subagents) details.push(`${counts.subagents} ${t('status.subagents')}`)

      return h(
        'div',
        {
          className: 'clawd-root',
          style: { left: `${Math.round(position.x)}px`, top: `${Math.round(position.y)}px`, width: `${width}px`, height: `${height}px`, opacity: Number(settings.opacity) || 1 },
        },
        h('style', null, OVERLAY_CSS),
        h(
          'div',
          {
            className: dragging ? 'clawd-stage clawd-dragging' : 'clawd-stage',
            style: { width: `${width}px`, height: `${height}px` },
            onPointerDown,
            onPointerMove,
            onPointerUp: endDrag,
            onPointerCancel: endDrag,
            onDoubleClick,
            onContextMenu,
            title: `${label}${details.length ? ` · ${details.join(' · ')}` : ''}${online ? '' : ' · host offline'}`,
          },
          shown.previous
            ? h('img', { className: 'clawd-layer clawd-leave', src: shown.previous, alt: '', draggable: false, style: layout.imageStyle })
            : null,
          shown.url
            ? h('img', { className: 'clawd-layer clawd-enter', src: shown.url, alt: label, draggable: false, style: layout.imageStyle })
            : null,
          h(
            'div',
            { className: 'clawd-pill' },
            h('span', { className: `clawd-dot${alert ? ' clawd-alert' : busy ? ' clawd-busy' : ''}` }),
            h('span', null, label),
            details.length ? h('span', { style: { opacity: 0.66 } }, details.join(' · ')) : null,
          ),
        ),
      )
    }

    // -------------------------------------------------------------- settings ---

    const PANEL_CSS = `
.clawd-panel{display:flex;flex-direction:column;gap:18px;padding:4px 0 24px;max-width:620px}
.clawd-panel h3{margin:0;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary,#eee)}
.clawd-panel p{margin:2px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#9aa0a6)}
.clawd-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:10px 0;
  border-top:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08))}
.clawd-row:first-of-type{border-top:0}
.clawd-row-main{min-width:0}
.clawd-row-main span{display:block;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary,#eee)}
.clawd-row-main small{display:block;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,#9aa0a6)}
.clawd-control{display:flex;align-items:center;gap:10px;flex:0 0 auto}
.clawd-switch{appearance:none;width:36px;height:20px;border-radius:999px;position:relative;cursor:pointer;
  background:var(--dsw-alias-border-l2,rgba(255,255,255,.2));transition:background .15s ease;border:0}
.clawd-switch:checked{background:var(--dsw-alias-brand-primary,#4c8dff)}
.clawd-switch::after{content:'';position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;
  background:#fff;transition:transform .15s ease}
.clawd-switch:checked::after{transform:translateX(16px)}
.clawd-select,.clawd-button{font:inherit;font-size:12px;line-height:18px;padding:4px 10px;border-radius:6px;
  border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.14));color:var(--dsw-alias-label-primary,#eee);
  background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.04));cursor:pointer}
.clawd-button:hover,.clawd-select:hover{border-color:var(--dsw-alias-border-l2,rgba(255,255,255,.28))}
.clawd-range{width:150px;accent-color:var(--dsw-alias-brand-primary,#4c8dff)}
.clawd-value{width:52px;text-align:right;font-size:12px;color:var(--dsw-alias-label-secondary,#9aa0a6)}
.clawd-note{font-size:12px;line-height:18px;padding:8px 10px;border-radius:6px;
  border:1px solid var(--dsw-alias-state-warn-primary,rgba(224,163,62,.5));
  color:var(--dsw-alias-label-primary,#eee);background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.03))}
`

    function SettingsView(props) {
      const payload = useStore(props.store)
      const t = props.t
      const settings = payload?.settings ?? null
      const themes = payload?.themes ?? []
      const unsupported = themes.length === 0

      const write = (patch) => void post('settings', patch)

      if (!settings) {
        return h(
          'div',
          { className: 'clawd-panel' },
          h('style', null, PANEL_CSS),
          h('h3', null, t('settings.title')),
          h('p', null, t('settings.unreachable')),
        )
      }

      return h(
        'div',
        { className: 'clawd-panel' },
        h('style', null, PANEL_CSS),
        h('div', null, h('h3', null, t('settings.title')), h('p', null, t('settings.subtitle'))),
        unsupported ? h('div', { className: 'clawd-note' }, t('settings.noTheme')) : null,
        row(
          t('settings.enabled'),
          t('settings.enabledHint'),
          h('input', {
            className: 'clawd-switch',
            type: 'checkbox',
            'aria-label': t('settings.enabled'),
            checked: settings.enabled !== false,
            onChange: (event) => write({ enabled: event.target.checked }),
          }),
        ),
        row(
          t('settings.theme'),
          t('settings.themeHint'),
          h(
            'select',
            {
              className: 'clawd-select',
              'aria-label': t('settings.theme'),
              value: payload?.theme?.id ?? '',
              onChange: (event) => write({ theme: event.target.value }),
            },
            themes.map((theme) => h('option', { key: theme.id, value: theme.id }, `${theme.name}${theme.source === 'local' ? ' · local' : ''}`)),
          ),
        ),
        row(
          t('settings.size'),
          t('settings.sizeHint'),
          h('input', {
            className: 'clawd-range',
            type: 'range',
            min: 48,
            max: 320,
            step: 4,
            'aria-label': t('settings.size'),
            value: Number(settings.size) || 64,
            onChange: (event) => write({ size: Number(event.target.value) }),
          }),
          h('span', { className: 'clawd-value' }, `${Math.round(Number(settings.size) || 64)}px`),
        ),
        row(
          t('settings.opacity'),
          null,
          h('input', {
            className: 'clawd-range',
            type: 'range',
            min: 0.2,
            max: 1,
            step: 0.05,
            'aria-label': t('settings.opacity'),
            value: Number(settings.opacity) || 1,
            onChange: (event) => write({ opacity: Number(event.target.value) }),
          }),
          h('span', { className: 'clawd-value' }, `${Math.round((Number(settings.opacity) || 1) * 100)}%`),
        ),
        row(
          t('settings.sounds'),
          t('settings.soundsHint'),
          h('input', {
            className: 'clawd-switch',
            type: 'checkbox',
            'aria-label': t('settings.sounds'),
            checked: settings.sounds === true,
            onChange: (event) => write({ sounds: event.target.checked }),
          }),
        ),
        row(
          t('settings.position'),
          `${t('settings.state')}: ${t(`state.${payload?.state ?? 'idle'}`)}`,
          h('button', { className: 'clawd-button', type: 'button', onClick: () => write({ position: null }) }, t('settings.resetPosition')),
        ),
        row(
          t('settings.reload'),
          t('settings.reloadHint'),
          h('button', { className: 'clawd-button', type: 'button', onClick: () => void post('refresh', {}) }, t('settings.reload')),
        ),
      )
    }

    function row(label, hint, ...controls) {
      return h(
        'div',
        { className: 'clawd-row' },
        h('div', { className: 'clawd-row-main' }, h('span', null, label), hint ? h('small', null, hint) : null),
        h('div', { className: 'clawd-control' }, ...controls),
      )
    }

    // ------------------------------------------------------------------ plugin ---

    return {
      name: NS,
      inject: ['slots'],
      apply(ctx) {
        const store = createStore()
        const lineListeners = new Set()
        const onLine = (listener) => {
          lineListeners.add(listener)
          return () => lineListeners.delete(listener)
        }
        const notifyLine = (value) => {
          for (const listener of [...lineListeners]) listener(value)
        }

        let translate = (key) => key
        const locale = ctx.get('locale')
        if (locale && typeof locale.bind === 'function') {
          try {
            locale.register?.(NS, { zh: ZH, en: EN })
          } catch (error) {
            // Already registered (a hot reload kept the previous dictionary): bind anyway.
            ctx.logger?.debug?.(`[dsh-clawd] locale registration skipped: ${error?.message ?? error}`)
          }
          translate = locale.bind(NS)
        } else {
          const dict = (window.navigator?.language ?? '').toLowerCase().startsWith('zh') ? ZH : EN
          translate = (key, params) => {
            const template = dict[key] ?? EN[key] ?? key
            if (!params) return template
            return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
          }
        }

        const t = (key, params) => translate(key, params)

        ctx.effect(() => connect(store, notifyLine))

        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            { name: 'shell.overlay', id: 'clawd-pet', order: 40, label: () => t('settings.title') },
            (props) => h(PetView, { ...props, store, t, onLine }),
          ),
        )

        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'clawd', order: 35, label: () => t('settings.title') },
            (props) => h(SettingsView, { ...props, store, t }),
          ),
        )
      },
    }
  },
})
