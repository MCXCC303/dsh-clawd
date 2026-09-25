#!/usr/bin/env node
/**
 * Packs a variant of the plugin with parts of the tree left out.
 *
 * The main use is a code-only build: `npm run pack` ships the MIT placeholder
 * theme so a fresh install renders something, while some destinations want the
 * plugin without any theme artwork at all — a marketplace that supplies its own,
 * or a redistribution that must carry no art whatsoever. A profile installed
 * from such a tarball still works: the host half mounts, the settings page says
 * no theme is available, and `$DSH_HOME/dsh-clawd/themes/` or
 * `scripts/setup-local-art.mjs` supplies one.
 *
 * The file list still comes from npm (`npm pack` resolves `files`, always-included
 * entries and the audit exclusion), so a variant cannot drift from the real
 * package: this script only removes what it was told to remove, then checks that
 * the result is still installable and that the plugin still answers without a
 * theme.
 *
 * Usage:
 *   node scripts/pack-variant.mjs [--without assets/themes] [--label no-art]
 *                                 [--version-suffix noart.0] [--out dist]
 *
 *   --without <path>      subtree to leave out; repeatable.
 *   --label <text>        appended to the tarball file name (default: no-art).
 *   --version-suffix <s>  rewrites `version` inside the tarball to `<version>-<s>`,
 *                         for registries that must tell the variants apart;
 *                         the default leaves the manifest identical to the repo.
 *   --out <dir>           where the tarball goes (default: dist).
 */

import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const argv = process.argv.slice(2)
const values = (name) => {
  const found = []
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === `--${name}`) found.push(argv[index + 1])
  }
  return found
}
const value = (name, fallback) => values(name)[0] ?? fallback

const without = values('without').length ? values('without') : ['assets/themes']
const label = value('label', 'no-art')
const versionSuffix = value('version-suffix')
const outDir = path.resolve(ROOT, value('out', 'dist'))

const problems = []
const fail = (message) => {
  problems.push(message)
  process.stdout.write(`FAIL  ${message}\n`)
}

// ------------------------------------------------------------------- pack ---
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-clawd-variant-'))
const base = execFileSync('npm', ['pack', '--pack-destination', scratch, '--silent'], {
  cwd: ROOT,
  encoding: 'utf8',
  env: { ...process.env, npm_config_cache: path.join(scratch, 'npm-cache'), npm_config_logs_dir: path.join(scratch, 'npm-logs') },
}).trim().split('\n').pop()
execFileSync('tar', ['xzf', path.join(scratch, base), '-C', scratch])

const staging = path.join(scratch, 'package')
const removed = []
for (const target of without) {
  const absolute = path.join(staging, target)
  if (!fs.existsSync(absolute)) continue
  fs.rmSync(absolute, { recursive: true, force: true })
  removed.push(target)
}

// ---------------------------------------------------------------- manifest ---
const manifestPath = path.join(staging, 'package.json')
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
const baseVersion = manifest.version
if (versionSuffix) manifest.version = `${manifest.version}-${versionSuffix}`
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

// A dangling icon reference is a diagnostic, not a crash: drop it when its file left.
if (manifest.icon && !fs.existsSync(path.join(staging, manifest.icon))) {
  delete manifest.icon
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

// ------------------------------------------------------------------- tar it ---
fs.mkdirSync(outDir, { recursive: true })
const outName = `dsh-clawd-${baseVersion}${label ? `-${label}` : ''}.tgz`
const outPath = path.join(outDir, outName)
fs.rmSync(outPath, { force: true })
execFileSync('tar', ['czf', outPath, '--owner=0', '--group=0', '--numeric-owner', '--sort=name', '-C', scratch, 'package'])

// ------------------------------------------------------------------ checks ---
const listing = execFileSync('tar', ['tzf', outPath], { encoding: 'utf8' }).trim().split('\n')
const has = (pattern) => listing.some((line) => pattern.test(line))

for (const target of without) {
  if (has(new RegExp(`^package/${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(/|$)`))) fail(`the tarball still contains ${target}`)
}
for (const banned of [/local-themes/, /\.apng$/, /audit\.json$/]) {
  if (has(banned)) fail(`the variant ships something it must not: ${listing.find((line) => banned.test(line))}`)
}
for (const required of ['package/lib/index.js', 'package/lib/client.js', 'package/cordis.patch.yml', 'package/LICENSE', 'package/README.md', 'package/package.json']) {
  if (!listing.includes(required)) fail(`the variant is missing ${required}`)
}

// Does the code-only build still run? Drive the extracted host half.
const home = path.join(scratch, 'home')
fs.mkdirSync(home, { recursive: true })
process.env.DSH_HOME = home
const { apply } = await import(path.join(staging, 'lib', 'index.js'))
const routes = []
const warnings = []
apply(
  {
    logger: { debug() {}, info() {}, warn: (message) => warnings.push(message) },
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
  },
  {},
)
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const route = routes.find((r) => url.pathname === r.path || url.pathname.startsWith(`${r.path}/`))
  if (route) return void route.handler(req, res)
  res.writeHead(404).end()
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base_ = `http://127.0.0.1:${server.address().port}`
const state = await (await fetch(`${base_}/dsh-clawd/state.json`)).json()
server.close()

const themeLess = state.theme === null && state.asset === null
if (!themeLess) fail(`expected a theme-less payload, got theme=${JSON.stringify(state.theme)} asset=${JSON.stringify(state.asset)}`)
if (state.settings.size !== 64) fail(`the default size is ${state.settings.size}, expected 64`)
if (!warnings.some((message) => /no theme found/.test(message))) fail('the host half did not report the missing theme')

// ------------------------------------------------------------------ report ---
const bytes = fs.statSync(outPath).size
const digest = createHash('sha256').update(fs.readFileSync(outPath)).digest('hex')
process.stdout.write(
  `variant  : ${path.relative(ROOT, outPath)} (${listing.length} entries, ${(bytes / 1024).toFixed(0)} KiB)\n` +
    `removed  : ${removed.length ? removed.join(', ') : '(nothing)'}\n` +
    `manifest : ${manifest.name}@${manifest.version}${versionSuffix ? ` (repo says ${baseVersion})` : ''}\n` +
    `runtime  : mounts ${routes[0]?.path}, answers state.json with theme=${JSON.stringify(state.theme)} and asset=${JSON.stringify(state.asset)}\n` +
    `sha256   : ${digest}\n`,
)

fs.rmSync(scratch, { recursive: true, force: true })
if (problems.length) {
  process.stdout.write(`\n${problems.length} problem(s)\n`)
}
// The plugin's own idle timer keeps the event loop alive; this is a build tool.
process.exit(problems.length ? 1 : 0)
