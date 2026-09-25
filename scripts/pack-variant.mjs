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
 * The other direction is the personal build: `--with assets/local-themes
 * --personal` adds the artwork that is deliberately kept out of the repository —
 * the Clawd/Calico/Cloudling themes materialized by `setup-local-art` — so the
 * tarball is self-contained on the author's own machines. Such a tarball is
 * **not redistributable**: it carries All-Rights-Reserved artwork, the script
 * says so, and it writes a LOCAL-ONLY.md marker inside so a later accidental
 * upload is obvious.
 *
 * Usage:
 *   node scripts/pack-variant.mjs [--without <path>] [--with <path>] [--personal]
 *                                 [--label <text>] [--version-suffix <s>] [--out <dir>]
 *
 *   --without <path>      subtree to leave out; repeatable.
 *   --with <path>         subtree to copy in from the repository; repeatable.
 *   --personal            allow locally materialized artwork (see PROVENANCE),
 *                         and mark the tarball as local use only.
 *   --label <text>        appended to the tarball file name (default: variant).
 *   --version-suffix <s>  rewrites `version` inside the tarball to `<version>-<s>`.
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

const without = values('without')
const withPaths = values('with')
const personal = argv.includes('--personal')
const label = value('label', 'variant')
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

// --------------------------------------------------------------- additions ---
const added = []
for (const target of withPaths) {
  const source = path.join(ROOT, target)
  if (!fs.existsSync(source)) fail(`--with ${target}: no such path in the repository`)
  const destination = path.join(staging, target)
  fs.rmSync(destination, { recursive: true, force: true })
  // dereference: `setup-local-art --link` symlinks its artwork, and a symlink
  // into this machine would be useless (or wrong) on any other one.
  fs.cpSync(source, destination, { recursive: true, dereference: true })
  let files = 0
  let bytes = 0
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else {
        files += 1
        bytes += fs.statSync(full).size
      }
    }
  }
  walk(destination)
  added.push({ target, files, bytes })
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

// ------------------------------------------------------------------- marker ---
if (personal) {
  fs.writeFileSync(
    path.join(staging, 'LOCAL-ONLY.md'),
    `# LOCAL USE ONLY — do not redistribute this tarball

This build was assembled on the author's own machine by
\`scripts/pack-variant.mjs${withPaths.length ? ` --with ${withPaths.join(' --with ')}` : ''} --personal\`,
and it carries artwork that this repository deliberately does not track:

${added.map((entry) => `* \`${entry.target}\``).join('\n') || '* (nothing added)'}

That artwork is **All Rights Reserved** — the Clawd character belongs to
Anthropic, the Calico cat artwork is © 鹿鹿, and the \`clawd-on-desk\` project's
\`assets/LICENSE\` permits only personal use of the application it ships with. It
is not covered by this repository's MIT license, and it must not be uploaded,
published, or handed to anyone else.

The distributable builds are \`npm run pack\` (MIT placeholder theme) and
\`npm run pack:no-art\` (code only). See README.md, "Licensing and provenance".
`,
    'utf8',
  )
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
// `local-themes`, `.apng` and `audit.json` all point at locally materialized
// upstream artwork, so a distributable build must never carry them. A personal
// build is defined by carrying exactly that.
const banned = personal ? [] : [/local-themes/, /\.apng$/, /audit\.json$/]
for (const pattern of banned) {
  if (has(pattern)) fail(`the variant ships something it must not: ${listing.find((line) => pattern.test(line))}`)
}
for (const entry of added) {
  if (!has(new RegExp(`^package/${entry.target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`))) fail(`--with ${entry.target} did not make it into the tarball`)
}
if (personal && !listing.includes('package/LOCAL-ONLY.md')) fail('a personal build must carry LOCAL-ONLY.md')
if (personal && added.length === 0) fail('--personal without --with would ship nothing extra; pass the artwork subtree')
for (const required of ['package/lib/index.js', 'package/lib/client.js', 'package/cordis.patch.yml', 'package/LICENSE', 'package/README.md', 'package/package.json']) {
  if (!listing.includes(required)) fail(`the variant is missing ${required}`)
}

// Does the code-only build still run? Drive the extracted host half.
const home = path.join(scratch, 'home')
fs.mkdirSync(home, { recursive: true })
process.env.DSH_HOME = home
const { apply } = await import(path.join(staging, 'lib', 'index.js'))

// Which theme the tarball carries, and which one to drive: prefer a packaged
// local theme (the reason a personal build exists), else whatever is there.
const carriedThemes = []
for (const root of ['assets/themes', 'assets/local-themes']) {
  const dir = path.join(staging, root)
  if (!fs.existsSync(dir)) continue
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (fs.existsSync(path.join(dir, entry.name, 'theme.json'))) carriedThemes.push({ id: entry.name, root })
  }
}
// The row config in cordis.patch.yml asks for `clawd`, so drive that when the
// tarball carries it: the report should describe what the user will see.
const preferredTheme =
  carriedThemes.find((theme) => theme.id === 'clawd')?.id ??
  carriedThemes.find((theme) => theme.root === 'assets/local-themes')?.id ??
  carriedThemes[0]?.id

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
  preferredTheme ? { theme: preferredTheme } : {},
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

const themes = carriedThemes
if (themes.length === 0) {
  if (state.theme !== null || state.asset !== null) fail(`expected a theme-less payload, got theme=${JSON.stringify(state.theme)}`)
  if (!warnings.some((message) => /no theme found/.test(message))) fail('the host half did not report the missing theme')
} else {
  if (!state.theme) fail('the tarball carries themes but none resolved')
  else {
    const carried = themes.find((theme) => theme.id === state.theme.id)
    if (!carried) fail(`resolved theme ${state.theme.id} is not one the tarball carries (${themes.map((t) => t.id).join(', ')})`)
    const file = state.asset?.file
    // Mirrors the resolver: artwork sits beside theme.json or under art/ or assets/.
    const themeDir = path.join(staging, carried.root, carried.id)
    const present =
      typeof file === 'string' &&
      [path.join(themeDir, file), path.join(themeDir, 'art', file), path.join(themeDir, 'assets', file)].some((candidate) =>
        fs.existsSync(candidate),
      )
    if (!present) fail(`resolved artwork ${file} is missing from the tarball`)
  }
}
if (state.settings.size !== 64) fail(`the default size is ${state.settings.size}, expected 64`)

// ------------------------------------------------------------------ report ---
const bytes = fs.statSync(outPath).size
const digest = createHash('sha256').update(fs.readFileSync(outPath)).digest('hex')
process.stdout.write(
  `variant  : ${path.relative(ROOT, outPath)} (${listing.length} entries, ${(bytes / 1024).toFixed(0)} KiB)\n` +
    `removed  : ${removed.length ? removed.join(', ') : '(nothing)'}\n` +
    `added    : ${added.length ? added.map((entry) => `${entry.target} (${entry.files} files, ${(entry.bytes / 1024).toFixed(0)} KiB)`).join(', ') : '(nothing)'}\n` +
    `themes   : ${themes.length ? themes.map((theme) => theme.id).join(', ') : '(none — the pet stays hidden until one is added)'}\n` +
    `manifest : ${manifest.name}@${manifest.version}${versionSuffix ? ` (repo says ${baseVersion})` : ''}\n` +
    `runtime  : mounts ${routes[0]?.path}, answers state.json with theme=${JSON.stringify(state.theme)} and asset=${JSON.stringify(state.asset)}\n` +
    `sha256   : ${digest}\n`,
)

if (personal) {
  process.stdout.write(
    '\n  LOCAL USE ONLY: this tarball carries All-Rights-Reserved artwork and must not be\n' +
      '  uploaded, published or shared. LOCAL-ONLY.md inside says the same thing.\n',
  )
}

fs.rmSync(scratch, { recursive: true, force: true })
if (problems.length) {
  process.stdout.write(`\n${problems.length} problem(s)\n`)
}
// The plugin's own idle timer keeps the event loop alive; this is a build tool.
process.exit(problems.length ? 1 : 0)
