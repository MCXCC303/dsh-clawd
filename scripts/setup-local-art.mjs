#!/usr/bin/env node
/**
 * Materializes every bundled theme of a `clawd-on-desk` installation into
 * `assets/local-themes/`, a directory `.gitignore` excludes.
 *
 * Why this exists: that project's artwork is `All Rights Reserved` — explicitly
 * outside its source license, and the Clawd character itself is Anthropic's
 * (see PROVENANCE.md). None of it may be redistributed, so this repository ships
 * only its own MIT placeholder theme and pulls the rest in locally, on demand,
 * from an installation the user already has.
 *
 * The themes are not copied file-for-file as they are upstream: each upstream
 * `theme.json` is *translated* into this plugin's manifest schema (states,
 * tiers, idle pool, reactions, timings, content box), and only fields this
 * plugin understands are carried over. The result lives in a git-ignored
 * directory, so no upstream file — manifest or artwork — enters this repository.
 *
 * Usage:
 *   node scripts/setup-local-art.mjs [--from /path/to/clawd-on-desk]
 *                                    [--only clawd,calico] [--link] [--force]
 *
 *   --link   symlink the artwork instead of copying it (saves ~12 MiB, but the
 *            themes then break if the source checkout moves).
 *   --force  replace themes that were materialized before.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { ALL_STATES } from '../lib/state.js'
import { validateTheme } from '../lib/theme.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TARGET_ROOT = path.join(ROOT, 'assets', 'local-themes')

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const value = (name) => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 ? argv[index + 1] : undefined
}

const NOTICE = 'All Rights Reserved — LOCAL USE ONLY, NOT REDISTRIBUTABLE'
const LICENSE_NOTE =
  'The artwork in this theme is neither this repository’s nor covered by its MIT license. It was materialized locally by scripts/setup-local-art.mjs; see PROVENANCE.md.'

// ------------------------------------------------------------------ source ---

const candidates = [
  value('from'),
  process.env.CLAWD_ON_DESK_DIR,
  path.join(os.homedir(), 'Programme', 'Git', 'clawd-on-desk'),
  path.join(ROOT, '..', 'clawd-on-desk'),
  path.join(os.homedir(), 'clawd-on-desk'),
].filter(Boolean)

const checkout = candidates.map((entry) => path.resolve(entry)).find((entry) => fs.existsSync(path.join(entry, 'themes')))
if (!checkout) {
  process.stderr.write(
    `no clawd-on-desk checkout found (looked for a themes/ directory in):\n  ${candidates.join('\n  ')}\n` +
      `pass one explicitly: node scripts/setup-local-art.mjs --from /path/to/clawd-on-desk\n`,
  )
  process.exit(1)
}

const only = (value('only') ?? '')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean)

/** Every theme directory upstream ships, minus the scaffold. */
function upstreamThemes() {
  const root = path.join(checkout, 'themes')
  const found = []
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = path.join(root, entry.name)
    const manifestPath = path.join(dir, 'theme.json')
    if (!fs.existsSync(manifestPath)) continue
    let manifest
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    } catch (error) {
      process.stderr.write(`skipping ${entry.name}: theme.json is not valid JSON (${error.message})\n`)
      continue
    }
    // `_scaffoldOnly` marks the template: upstream skips it in its own theme
    // list, and it is a form to fill in rather than a theme to display.
    if (manifest._scaffoldOnly === true) continue
    if (only.length && !only.includes(entry.name)) continue
    // The built-in Clawd theme carries no assets/ of its own: its artwork is the
    // checkout's shared assets/svg/ directory.
    const ownArt = path.join(dir, 'assets')
    const artDir = fs.existsSync(ownArt) ? ownArt : path.join(checkout, 'assets', 'svg')
    if (!fs.existsSync(artDir)) {
      process.stderr.write(`skipping ${entry.name}: no artwork directory (${artDir})\n`)
      continue
    }
    found.push({ id: entry.name, dir, manifest, artDir })
  }
  return found
}

// -------------------------------------------------------------- translation ---

const numeric = (value) => {
  if (!value || typeof value !== 'object') return undefined
  const out = Object.fromEntries(Object.entries(value).filter(([, entry]) => typeof entry === 'number' && Number.isFinite(entry)))
  return Object.keys(out).length ? out : undefined
}

const fileEntry = (entry) => {
  if (Array.isArray(entry)) {
    const files = entry.filter((file) => typeof file === 'string' && file)
    return files.length ? { files } : undefined
  }
  if (entry && typeof entry === 'object') {
    const out = {}
    const files = Array.isArray(entry.files) ? entry.files.filter((file) => typeof file === 'string' && file) : []
    if (files.length) out.files = files
    else if (typeof entry.file === 'string' && entry.file) out.files = [entry.file]
    if (typeof entry.duration === 'number' && Number.isFinite(entry.duration)) out.duration = entry.duration
    return Object.keys(out).length ? out : undefined
  }
  if (typeof entry === 'string' && entry) return { files: [entry] }
  return undefined
}

/**
 * Upstream states may be a file list or `{ files, fallbackTo }`; resolve the
 * fallback chain here so the emitted manifest stands on its own, and drop
 * states this plugin never displays.
 */
function translateStates(upstream) {
  const resolve = (state, seen = new Set()) => {
    if (seen.has(state)) return undefined
    seen.add(state)
    const entry = upstream?.[state]
    if (!entry) return undefined
    const files = fileEntry(entry)?.files
    if (files?.length) return files
    const fallbackTo = entry && typeof entry === 'object' ? entry.fallbackTo : undefined
    return typeof fallbackTo === 'string' ? resolve(fallbackTo, seen) : undefined
  }
  const states = {}
  for (const state of ALL_STATES) {
    const files = resolve(state)
    if (files?.length) states[state] = files
  }
  return states
}

function translateTiers(tiers) {
  if (!Array.isArray(tiers)) return undefined
  const out = tiers
    .filter((tier) => tier && typeof tier.file === 'string' && Number.isFinite(tier.minSessions))
    .map((tier) => ({ minSessions: tier.minSessions, file: tier.file }))
    .sort((a, b) => b.minSessions - a.minSessions)
  return out.length ? out : undefined
}

function translateReactions(reactions) {
  if (!reactions || typeof reactions !== 'object') return undefined
  const out = {}
  for (const [kind, entry] of Object.entries(reactions)) {
    const translated = fileEntry(entry)
    if (translated?.files?.length) {
      out[kind] = { file: translated.files[0], ...(translated.duration ? { duration: translated.duration } : {}) }
    }
  }
  return Object.keys(out).length ? out : undefined
}

/**
 * Translate one upstream manifest into this plugin's schema. Only the fields
 * this plugin reads are carried over; everything else upstream declares
 * (eye tracking, hit boxes, mini mode, accessories, per-file offsets…) belongs
 * to its own renderer and is deliberately dropped rather than half-honoured.
 */
function translateTheme(source) {
  const upstream = source.manifest
  const timings = {}
  const minDisplay = numeric(upstream.timings?.minDisplay)
  const autoReturn = numeric(upstream.timings?.autoReturn)
  if (minDisplay) timings.minDisplay = minDisplay
  if (autoReturn) timings.autoReturn = autoReturn
  // Upstream sleeps after `mouseSleepTimeout` of pointer idleness; that is the
  // same entry point as our idle -> sleep chain, so it maps across. Its
  // per-phase durations are tuned to its own renderer, so ours keeps its pacing.
  if (Number.isFinite(upstream.timings?.mouseSleepTimeout)) timings.idleSleepMs = upstream.timings.mouseSleepTimeout

  const viewBox = numeric(upstream.viewBox)
  const contentBox = numeric(upstream.layout?.contentBox)
  const objectScale = numeric(upstream.objectScale)
  const workingTiers = translateTiers(upstream.workingTiers)
  const jugglingTiers = translateTiers(upstream.jugglingTiers)
  const idleAnimations = Array.isArray(upstream.idleAnimations)
    ? upstream.idleAnimations
        .filter((entry) => entry && typeof entry.file === 'string')
        .map((entry) => ({ file: entry.file, ...(Number.isFinite(entry.duration) ? { duration: entry.duration } : {}) }))
    : []
  const reactions = translateReactions(upstream.reactions)

  return {
    schemaVersion: 1,
    id: source.id,
    name: typeof upstream.name === 'string' && upstream.name ? upstream.name : source.id,
    author: typeof upstream.author === 'string' ? upstream.author : 'clawd-on-desk contributors',
    version: typeof upstream.version === 'string' ? upstream.version : '1.0.0',
    license: NOTICE,
    description: `${typeof upstream.description === 'string' && upstream.description ? `${upstream.description} ` : ''}Translated from ${path.relative(checkout, source.dir)}/theme.json for dsh-clawd.`,
    _artwork: `copied from ${source.artDir}`,
    _license: LICENSE_NOTE,
    ...(viewBox ? { viewBox } : {}),
    ...(contentBox ? { contentBox } : {}),
    ...(objectScale
      ? {
          objectScale: Object.fromEntries(
            ['widthRatio', 'heightRatio', 'offsetX', 'offsetY']
              .filter((key) => Number.isFinite(objectScale[key]))
              .map((key) => [key, objectScale[key]]),
          ),
        }
      : {}),
    states: translateStates(upstream.states),
    ...(workingTiers ? { workingTiers } : {}),
    ...(jugglingTiers ? { jugglingTiers } : {}),
    ...(idleAnimations.length ? { idleAnimations } : {}),
    ...(reactions ? { reactions } : {}),
    ...(Object.keys(timings).length ? { timings } : {}),
  }
}

// ----------------------------------------------------------------- placement ---

function materialize(source, { link, force }) {
  const target = path.join(TARGET_ROOT, source.id)
  const art = path.join(target, 'art')
  let copied = 0
  let bytes = 0

  if (fs.existsSync(target)) {
    if (!force) return { target, manifest: null, skipped: true, copied, bytes }
    fs.rmSync(target, { recursive: true, force: true })
  }
  fs.mkdirSync(target, { recursive: true })

  const manifest = translateTheme(source)
  if (link) {
    fs.symlinkSync(source.artDir, art, 'dir')
  } else {
    fs.cpSync(source.artDir, art, { recursive: true })
    for (const name of fs.readdirSync(art)) {
      const stat = fs.statSync(path.join(art, name))
      if (stat.isFile()) {
        copied += 1
        bytes += stat.size
      }
    }
  }
  fs.writeFileSync(path.join(target, 'theme.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return { target, manifest, skipped: false, copied, bytes, linked: Boolean(link) }
}

const sources = upstreamThemes()
if (!sources.length) {
  process.stderr.write(`no themes to materialize from ${checkout}\n`)
  process.exit(1)
}

const results = []
let failures = 0
for (const source of sources) {
  const result = materialize(source, { link: flag('link'), force: flag('force') })
  if (result.skipped) {
    process.stdout.write(`SKIP  ${source.id} — already materialized (use --force to replace)\n`)
    results.push({ source, result })
    continue
  }
  const checked = validateTheme(result.manifest, result.target)
  const states = Object.keys(result.manifest.states).length
  const art = result.linked ? `-> ${source.artDir}` : `${result.copied} files, ${(result.bytes / 1024).toFixed(0)} KiB`
  if (checked.errors.length) {
    failures += 1
    process.stdout.write(`FAIL  ${source.id} — ${checked.errors.length} error(s)\n`)
    for (const error of checked.errors) process.stdout.write(`        error: ${error}\n`)
  } else {
    process.stdout.write(`OK    ${source.id} (${states} states, ${art})\n`)
  }
  for (const warning of checked.warnings ?? []) process.stdout.write(`        warn:  ${warning}\n`)
  results.push({ source, result })
}

process.stdout.write(
  `\n${results.length} theme(s) from ${checkout}\n` +
    `  placed in ${path.relative(ROOT, TARGET_ROOT)} (git-ignored — nothing here is committed)\n` +
    `  reload them in Settings -> Clawd -> Reload themes\n`,
)
process.exit(failures ? 1 : 0)
