#!/usr/bin/env node
/**
 * Contract tests for the browser half.
 *
 * `lib/client.js` is a plain-JS Client module: it registers a lazy factory on
 * `window.__ModuleLoader__`, and that factory returns an ordinary Cordis plugin
 * which claims two slots. This suite replays exactly that contract outside a
 * browser — the module is evaluated against a stub `window`, its factory is
 * materialized with a minimal React implementation, and the two registered
 * components are rendered against a realistic host payload.
 *
 * It is not a browser: it proves the module shape, the slot registrations, the
 * rendering logic and the intents the components send. How the result *looks*
 * is verified in the running GUI.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ---------------------------------------------------------------- mini React ---

/** The smallest React that can execute these components: hooks plus a render pass. */
function createMiniReact() {
  let hooks = []
  let cursor = 0
  let effects = []
  let dirty = false

  const React = {
    createElement(type, props, ...children) {
      const flat = children
        .flat(Infinity)
        .filter((child) => child !== null && child !== undefined && child !== false && child !== true)
      return { type, props: { ...(props ?? {}), children: flat } }
    },
    useState(initial) {
      const index = cursor
      cursor += 1
      if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial
      return [
        hooks[index],
        (next) => {
          hooks[index] = typeof next === 'function' ? next(hooks[index]) : next
          dirty = true
        },
      ]
    },
    useRef(initial) {
      const index = cursor
      cursor += 1
      if (!(index in hooks)) hooks[index] = { current: initial }
      return hooks[index]
    },
    useEffect(effect, deps) {
      const index = cursor
      cursor += 1
      const previous = hooks[index]
      const changed =
        !previous || !deps || deps.length !== previous.deps.length || deps.some((value, position) => value !== previous.deps[position])
      if (changed) effects.push({ index, effect, deps })
      else hooks[index] = previous
    },
  }

  /**
   * Render an element tree to plain nodes, running effects the way React would.
   * Effect cleanups are kept per hook slot for the life of the tree, so the
   * returned `cleanups` are the unmount cleanups — including those of effects
   * that ran in an earlier pass.
   */
  function render(element) {
    const cleanupByIndex = new Map()
    for (let pass = 0; pass < 12; pass += 1) {
      cursor = 0
      effects = []
      dirty = false
      const tree = resolve(element)
      for (const { index, effect, deps } of effects) {
        const previous = cleanupByIndex.get(index)
        if (previous) {
          previous()
          cleanupByIndex.delete(index)
        }
        hooks[index] = { deps }
        const cleanup = effect()
        if (typeof cleanup === 'function') cleanupByIndex.set(index, cleanup)
      }
      if (!dirty) return { tree, cleanups: [...cleanupByIndex.values()] }
    }
    throw new Error('mini React: the tree did not settle')
  }

  function resolve(node) {
    if (node === null || node === undefined || node === false || node === true) return null
    if (typeof node === 'string' || typeof node === 'number') return { text: String(node) }
    if (Array.isArray(node)) return node.map(resolve).filter(Boolean)
    if (typeof node.type === 'function') return resolve(node.type(node.props))
    return { tag: node.type, props: node.props, children: (node.props.children ?? []).map(resolve).filter(Boolean) }
  }

  return { React, render }
}

function find(node, tag) {
  return findAll(node, tag)[0] ?? null
}

function findAll(node, tag, out = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, tag, out)
    return out
  }
  if (node.tag === tag) out.push(node)
  for (const child of node.children ?? []) findAll(child, tag, out)
  return out
}

function textOf(node) {
  if (!node || typeof node !== 'object') return ''
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node.text !== undefined) return node.text
  return (node.children ?? []).map(textOf).join('')
}

// ------------------------------------------------------------------ fixtures ---

const PAYLOAD = {
  rev: 7,
  state: 'working',
  since: 1,
  oneshot: false,
  idlePick: 0,
  counts: { sessions: 2, busy: 2, working: 1, subagents: 0 },
  sessions: [{ id: 's1', origin: 'root', state: 'working', tool: 'read' }],
  theme: {
    id: 'placeholder',
    name: 'Placeholder Blob',
    source: 'builtin',
    rev: 'abc123',
    viewBox: { x: 0, y: 0, width: 64, height: 64 },
    contentBox: { x: 8, y: 2, width: 48, height: 56 },
  },
  themes: [
    { id: 'clawd', name: 'Clawd (local-only artwork)', source: 'local' },
    { id: 'placeholder', name: 'Placeholder Blob', source: 'builtin' },
  ],
  asset: {
    kind: 'state',
    file: 'working.svg',
    theme: 'placeholder',
    url: '/dsh-clawd/art/placeholder/working.svg?rev=abc123',
    width: 64,
    height: 64,
    aspect: 1,
  },
  preload: ['/dsh-clawd/art/placeholder/idle.svg?rev=abc123'],
  settings: { enabled: true, theme: 'placeholder', size: 132, opacity: 1, sounds: false, position: { x: 40, y: 50 } },
  timings: { reactionMs: 2500, idleAnimationMs: 12000 },
  owner: null,
  version: '0.1.0',
}

/**
 * Evaluate `lib/client.js` the way the browser module loader would, mount the
 * plugin on a stub Client context, and hand back everything a test needs.
 */
async function harness({ locale = 'zh', localeAvailable = true, payload = PAYLOAD } = {}) {
  let registration = null
  const requests = []
  const streams = []
  const slots = new Map()
  const localeCalls = []
  const effects = []

  const fakeWindow = {
    __ModuleLoader__: { load: (entry) => { registration = entry } },
    navigator: { language: locale === 'zh' ? 'zh-CN' : 'en-US' },
    innerWidth: 1400,
    innerHeight: 900,
    addEventListener() {},
    removeEventListener() {},
  }
  const fakeDocument = { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' }
  const fakeFetch = async (url, options = {}) => {
    requests.push({ url, options })
    return { ok: true, status: 200, json: async () => (url.endsWith('state.json') ? payload : { ok: true, payload }) }
  }
  class FakeEventSource {
    constructor(url) {
      streams.push(url)
    }
    close() {}
  }

  const source = fs.readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8')
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'fetch', 'EventSource', 'Image', source)(
    fakeWindow,
    fakeDocument,
    fakeFetch,
    FakeEventSource,
    class {},
  )

  assert.ok(registration, 'the module registers a factory on window.__ModuleLoader__')
  const { React, render } = createMiniReact()
  const plugin = registration.factory((name) => {
    if (name === 'react') return React
    throw new Error(`the client module must not import ${name}`)
  })

  const ctx = {
    logger: { debug() {}, info() {}, warn() {} },
    get(name) {
      if (name !== 'locale' || !localeAvailable) return undefined
      return {
        register: (...args) => localeCalls.push(args),
        bind: () => (key) => `zh:${key}`,
      }
    },
    effect(callback) {
      effects.push(callback())
      return () => {}
    },
    slots: {
      inject: (key, callback) => {
        callback()
        return () => {}
      },
      register: (options, component) => {
        slots.set(`${options.name}#${options.id}`, { options, component })
        return () => {}
      },
    },
  }

  plugin.apply(ctx)
  await new Promise((resolve) => setTimeout(resolve, 0))

  /** The plugin closes its store and translator into the components it registers. */
  const bound = (key) => {
    const registered = slots.get(key)
    assert.ok(registered, `${key} is registered`)
    return registered.component({})
  }

  return {
    plugin,
    React,
    render,
    requests,
    streams,
    slots,
    localeCalls,
    registration,
    pet: (props = {}) => bound('shell.overlay#clawd-pet').props.store && { ...bound('shell.overlay#clawd-pet').props, ...props },
    settings: (props = {}) => ({ ...bound('settings.section#clawd').props, ...props }),
    Component: {
      pet: (props) => slots.get('shell.overlay#clawd-pet').component(props),
      settings: (props) => slots.get('settings.section#clawd').component(props),
    },
  }
}

// --------------------------------------------------------------------- tests ---

test('the client module registers the pet overlay and the settings page', async () => {
  const h = await harness()
  assert.equal(h.registration.id, 'dsh-clawd', 'the factory id is the package name')
  assert.equal(h.plugin.inject.includes('slots'), true)
  assert.deepEqual([...h.slots.keys()].sort(), ['settings.section#clawd', 'shell.overlay#clawd-pet'])
  assert.equal(h.slots.get('shell.overlay#clawd-pet').options.order, 40)
  assert.deepEqual(h.streams, ['/dsh-clawd/live'], 'the live feed is opened once')
  assert.equal(h.localeCalls.length, 1, 'both dictionaries are registered together')
  assert.equal(h.localeCalls[0][0], 'dsh-clawd')
  assert.ok(h.localeCalls[0][1].zh['settings.title'])
  assert.ok(h.localeCalls[0][1].en['settings.title'])
  assert.equal(
    Object.keys(h.localeCalls[0][1].zh).length,
    Object.keys(h.localeCalls[0][1].en).length,
    'both dictionaries cover the same keys',
  )
})

test('the pet renders the artwork, size and position the host published', async () => {
  const h = await harness()
  const { tree } = h.render(h.Component.pet({}))

  const root = find(tree, 'div')
  assert.equal(root.props.className, 'clawd-root')
  // 132px is the height of the *character*: its contentBox (48x56 of a 64x64
  // viewBox) is what gets fitted, and the frame is drawn around it.
  assert.deepEqual(
    { left: root.props.style.left, top: root.props.style.top, width: root.props.style.width, height: root.props.style.height },
    { left: '40px', top: '50px', width: '113px', height: '132px' },
  )

  const image = find(tree, 'img')
  assert.equal(image.props.src, PAYLOAD.asset.url, 'the published artwork URL is the img src')
  assert.equal(image.props.draggable, false)
  assert.deepEqual(image.props.style, { left: '-19px', top: '-5px', width: '151px', height: '151px' })

  const stage = findAll(tree, 'div').find((node) => node.props.className?.startsWith('clawd-stage'))
  assert.equal(typeof stage.props.onPointerDown, 'function')
  assert.equal(typeof stage.props.onPointerMove, 'function')
  assert.equal(typeof stage.props.onContextMenu, 'function')

  const pill = findAll(tree, 'div').find((node) => node.props.className === 'clawd-pill')
  assert.match(textOf(pill), /zh:state\.working/)
  assert.match(textOf(pill), /2 zh:status\.sessions/)
  assert.match(textOf(pill), /1 zh:status\.tools/)

  const stylesheet = find(tree, 'style')
  assert.match(textOf(stylesheet), /--dsw-alias-bg-overlay/, 'the overlay styles itself with host theme tokens')
})

test('the pet hides itself when the setting is off, and without artwork', async () => {
  const off = await harness({ payload: { ...PAYLOAD, settings: { ...PAYLOAD.settings, enabled: false } } })
  assert.equal(find(off.render(off.Component.pet({})).tree, 'div'), null)

  const bare = await harness({ payload: { ...PAYLOAD, asset: null, theme: null, themes: [] } })
  assert.equal(find(bare.render(bare.Component.pet({})).tree, 'div'), null)
})

test('dragging moves the pet and commits one position write', async () => {
  const h = await harness()
  const { tree } = h.render(h.Component.pet({}))
  const stage = findAll(tree, 'div').find((node) => node.props.className?.startsWith('clawd-stage'))

  const target = { setPointerCapture() {}, clientX: 100, clientY: 100 }
  stage.props.onPointerDown({ button: 0, pointerId: 1, clientX: 90, clientY: 95, currentTarget: target })
  stage.props.onPointerMove({ clientX: 130, clientY: 140 })
  await stage.props.onPointerUp({ type: 'pointerup' })

  const write = h.requests.find((request) => request.url.endsWith('/settings'))
  assert.ok(write, 'the new position is persisted through the guarded route')
  assert.deepEqual(JSON.parse(write.options.body), { position: { x: 80, y: 95 } })
  assert.deepEqual(
    h.requests.filter((request) => request.url.endsWith('/react')).map((request) => JSON.parse(request.options.body)),
    [
      { kind: 'drag', phase: 'hold' },
      { kind: 'drag', phase: 'release' },
    ],
    'the drag pose is held while the pointer is down and released on pointerup, never played on a timer',
  )
})

test('a drag that loses its pointerup still releases the pose', async () => {
  const h = await harness()
  const { tree, cleanups } = h.render(h.Component.pet({}))
  const stage = findAll(tree, 'div').find((node) => node.props.className?.startsWith('clawd-stage'))

  stage.props.onPointerDown({ button: 0, pointerId: 1, clientX: 10, clientY: 10, currentTarget: { setPointerCapture() {} } })
  stage.props.onPointerMove({ clientX: 60, clientY: 60 })
  // No pointerup: the overlay unmounts mid-gesture instead.
  cleanups.forEach((cleanup) => cleanup())

  assert.deepEqual(
    h.requests.filter((request) => request.url.endsWith('/react')).map((request) => JSON.parse(request.options.body)),
    [
      { kind: 'drag', phase: 'hold' },
      { kind: 'drag', phase: 'release' },
    ],
    'unmounting releases the held pose',
  )
})

test('a plain click plays a reaction instead of moving the pet', async () => {
  const h = await harness()
  const { tree } = h.render(h.Component.pet({}))
  const stage = findAll(tree, 'div').find((node) => node.props.className?.startsWith('clawd-stage'))

  stage.props.onPointerDown({ button: 0, pointerId: 1, clientX: 90, clientY: 95, currentTarget: { setPointerCapture() {} } })
  await stage.props.onPointerUp({ type: 'pointerup' })
  const reactions = h.requests.filter((request) => request.url.endsWith('/react'))
  assert.deepEqual(
    reactions.map((request) => JSON.parse(request.options.body).kind),
    ['clickLeft'],
  )
  assert.equal(h.requests.some((request) => request.url.endsWith('/settings')), false)
})

test('the settings page drives the guarded write routes', async () => {
  const h = await harness()
  const { tree } = h.render(h.Component.settings({}))

  const checkbox = find(tree, 'input')
  assert.equal(checkbox.props.type, 'checkbox')
  assert.equal(checkbox.props.checked, true)
  assert.equal(checkbox.props['aria-label'], 'zh:settings.enabled')

  const select = find(tree, 'select')
  assert.equal(select.props.value, 'placeholder')
  assert.equal(select.props.children.length, 2, 'every discovered theme is offered')

  const range = findAll(tree, 'input').find((node) => node.props.type === 'range')
  assert.equal(range.props.value, 132)
  assert.equal(range.props.max, 320)

  const buttons = findAll(tree, 'button')
  assert.equal(buttons.length, 2)
  await buttons[0].props.onClick()
  const write = h.requests.find((request) => request.url.endsWith('/settings'))
  assert.equal(write.options.method, 'POST')
  assert.deepEqual(JSON.parse(write.options.body), { position: null })

  await buttons[1].props.onClick()
  assert.ok(h.requests.some((request) => request.url.endsWith('/refresh')))
})

test('a host with no theme explains itself instead of rendering a broken page', async () => {
  const h = await harness({ payload: { ...PAYLOAD, asset: null, theme: null, themes: [] } })
  const { tree } = h.render(h.Component.settings({}))
  assert.match(textOf(tree), /zh:settings\.noTheme/)
})

test('the settings page survives a host that only sent settings', async () => {
  const h = await harness({ payload: { settings: { enabled: true, size: 96, opacity: 1, sounds: false, position: null } } })
  const { tree } = h.render(h.Component.settings({}))
  assert.match(textOf(tree), /zh:settings\.title/)
})

test('without the client locale service the plugin still renders text', async () => {
  const h = await harness({ locale: 'en', localeAvailable: false })
  assert.equal(h.localeCalls.length, 0)
  const { tree } = h.render(h.Component.settings({}))
  assert.match(textOf(tree), /A pixel pet/)
})

test('a theme without a contentBox falls back to the whole viewBox', async () => {
  const h = await harness({ payload: { ...PAYLOAD, theme: { ...PAYLOAD.theme, contentBox: undefined } } })
  const { tree } = h.render(h.Component.pet({}))
  const root = find(tree, 'div')
  assert.equal(root.props.style.width, '132px')
  assert.equal(root.props.style.height, '132px')
  assert.deepEqual(find(tree, 'img').props.style, { left: '0px', top: '0px', width: '132px', height: '132px' })
})

test('the pet renders before the first payload arrives', async () => {
  const h = await harness({ payload: null })
  const rendered = h.render(h.Component.pet({}))
  assert.equal(rendered.tree, null, 'nothing is drawn until the host answers')
})
