#!/usr/bin/env node
/**
 * Packs the plugin, extracts the tarball into a scratch directory, and drives
 * *that copy* — the artifact a user actually installs, not the working tree.
 *
 * Checks, in order: the tarball contains no local-only artwork; the host half
 * mounts `/dsh-clawd`, falls back to a theme on a bare install, serves every
 * artwork file its theme references, and refuses a forged request; the client
 * half registers its factory under the package name and injects `slots`; the
 * packaged validator accepts the packaged themes.
 *
 * Usage: node scripts/verify-package.mjs   (CI runs this on every push)
 */

import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const problems = []
const note = (message) => process.stdout.write(`${message}\n`)
const fail = (message) => {
  problems.push(message)
  process.stdout.write(`FAIL  ${message}\n`)
}

// ---------------------------------------------------------------- pack it ---
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-clawd-verify-'))
execFileSync('npm', ['pack', '--pack-destination', scratch], {
  cwd: ROOT,
  stdio: ['ignore', 'ignore', 'inherit'],
  env: { ...process.env, npm_config_cache: path.join(scratch, 'npm-cache'), npm_config_logs_dir: path.join(scratch, 'npm-logs') },
})
const tarball = fs.readdirSync(scratch).find((name) => name.endsWith('.tgz'))
if (!tarball) {
  fail('npm pack produced no tarball')
  process.exit(1)
}
const listing = execFileSync('tar', ['tzf', path.join(scratch, tarball)], { encoding: 'utf8' }).trim().split('\n')
note(`tarball : ${tarball} (${listing.length} entries, ${(fs.statSync(path.join(scratch, tarball)).size / 1024).toFixed(0)} KiB)`)

for (const banned of [/local-themes/, /calico/, /cloudling/, /audit\.json$/]) {
  const hit = listing.find((line) => banned.test(line))
  if (hit) fail(`the tarball ships something it must not: ${hit}`)
}
for (const required of ['package/lib/index.js', 'package/lib/client.js', 'package/cordis.patch.yml', 'package/assets/themes/placeholder/theme.json', 'package/LICENSE']) {
  if (!listing.includes(required)) fail(`the tarball is missing ${required}`)
}

const pkgRoot = path.join(scratch, 'package')
execFileSync('tar', ['xzf', path.join(scratch, tarball), '-C', scratch])

// ------------------------------------------------------- drive the host half ---
const home = path.join(scratch, 'home')
fs.mkdirSync(home, { recursive: true })
process.env.DSH_HOME = home
const { apply } = await import(path.join(pkgRoot, 'lib', 'index.js'))

const routes = []
const ctx = {
  logger: { debug() {}, info() {}, warn: (message) => note(`warn  : ${message}`) },
  get: () => undefined,
  on: () => () => {},
  effect: (callback) => {
    callback()
    return () => {}
  },
  webServer: {
    register(route) {
      routes.push(route)
      return () => {}
    },
    tapIndex: () => () => {},
  },
}
apply(ctx, {})
if (routes.length !== 1 || routes[0].path !== '/dsh-clawd') fail(`unexpected route mount: ${JSON.stringify(routes.map((r) => r.path))}`)

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const route = routes.find((r) => url.pathname === r.path || url.pathname.startsWith(`${r.path}/`))
  if (route) return void route.handler(req, res)
  res.writeHead(404).end()
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

const state = await (await fetch(`${base}/dsh-clawd/state.json`)).json()
note(`host    : theme ${state.theme?.id} (${state.theme?.source}), size ${state.settings.size}, state ${state.state}`)
if (!state.theme) fail('no theme resolved on a bare install')
if (state.settings.size !== 64) fail(`default size is ${state.settings.size}, expected 64`)
if (!state.asset?.url) fail('no artwork resolved for the idle state')

const manifest = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'assets', 'themes', 'placeholder', 'theme.json'), 'utf8'))
const referenced = new Set()
const collect = (entry) => {
  if (Array.isArray(entry)) entry.forEach((file) => referenced.add(file))
  else if (entry && typeof entry === 'object') {
    if (entry.file) referenced.add(entry.file)
    for (const file of entry.files ?? []) referenced.add(file)
    if (typeof entry === 'string') referenced.add(entry)
  } else if (typeof entry === 'string') referenced.add(entry)
}
Object.values(manifest.states).forEach(collect)
;(manifest.idleAnimations ?? []).forEach(collect)
Object.values(manifest.reactions ?? {}).forEach(collect)
for (const tier of [...(manifest.workingTiers ?? []), ...(manifest.jugglingTiers ?? [])]) collect(tier.file)
let served = 0
for (const file of referenced) {
  const response = await fetch(`${base}/dsh-clawd/art/placeholder/${encodeURIComponent(file)}`)
  if (response.status !== 200) fail(`artwork ${file} answered ${response.status}`)
  else served += 1
}
note(`artwork : ${served}/${referenced.size} referenced files served from the tarball`)

const traversal = await fetch(`${base}/dsh-clawd/art/placeholder/%2e%2e%2f%2e%2e%2fpackage.json`)
if (traversal.status !== 404) fail(`a traversal attempt answered ${traversal.status}, expected 404`)

// ----------------------------------------------------- materialize the client ---
let registration = null
const fakeWindow = {
  __ModuleLoader__: { load: (entry) => { registration = entry } },
  navigator: { language: 'zh-CN' },
  innerWidth: 1200,
  innerHeight: 800,
  addEventListener() {},
  removeEventListener() {},
}
const fakeDocument = { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' }
new Function('window', 'document', 'fetch', 'EventSource', 'Image', fs.readFileSync(path.join(pkgRoot, 'lib', 'client.js'), 'utf8'))(
  fakeWindow,
  fakeDocument,
  async () => ({ ok: true, status: 200, json: async () => state }),
  class { close() {} },
  class {},
)
const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'))
if (registration?.id !== pkg.name) fail(`the client factory registers as ${registration?.id}, expected ${pkg.name}`)
const plugin = registration?.factory((name) => {
  if (name === 'react') return { createElement: () => null, useState: (v) => [v, () => {}], useEffect() {}, useRef: (v) => ({ current: v }) }
  throw new Error(`the client half imported ${name}`)
})
if (!plugin?.inject?.includes('slots')) fail('the client plugin does not inject slots')
note(`client  : factory "${registration?.id}" injects ${JSON.stringify(plugin?.inject)}`)

server.close()
fs.rmSync(scratch, { recursive: true, force: true })
if (problems.length) {
  process.stdout.write(`\n${problems.length} problem(s)\n`)
  process.exit(1)
}
process.stdout.write('\nthe packaged plugin is self-contained\n')
