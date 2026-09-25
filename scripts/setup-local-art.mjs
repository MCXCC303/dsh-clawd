#!/usr/bin/env node
/**
 * Materializes the local-only `clawd` theme.
 *
 * The Clawd artwork belongs to a separate project whose asset license forbids
 * redistribution (`All Rights Reserved`; the character itself is Anthropic's).
 * This repository therefore never carries it: this script links the artwork
 * from an installed `clawd-on-desk` checkout into `assets/local-themes/clawd/`,
 * a directory that `.gitignore` excludes. Everything else in the plugin works
 * without it — the committed `placeholder` theme is what a clone renders.
 *
 * Usage:
 *   node scripts/setup-local-art.mjs [--from /path/to/clawd-on-desk] [--force]
 *
 * See PROVENANCE.md, section 2, for the licensing this script exists to respect.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TARGET = path.join(ROOT, 'assets', 'local-themes', 'clawd')

/** state -> artwork file in the source checkout's `assets/svg/`, plus reactions and idle pool. */
const MAPPING = {
  states: {
    idle: ['clawd-idle-follow.svg'],
    thinking: ['clawd-working-thinking.svg'],
    working: ['clawd-working-typing.svg'],
    attention: ['clawd-happy.svg'],
    error: ['clawd-error.svg'],
    notification: ['clawd-notification.svg'],
    sweeping: ['clawd-working-sweeping.svg'],
    juggling: ['clawd-headphones-groove.svg'],
    carrying: ['clawd-working-carrying.svg'],
    sleeping: ['clawd-sleeping.svg'],
    yawning: ['clawd-idle-yawn.svg'],
    dozing: ['clawd-idle-doze.svg'],
    collapsing: ['clawd-collapse-sleep.svg'],
    waking: ['clawd-wake.svg'],
    roam: ['clawd-mini-crabwalk.svg'],
  },
  idleAnimations: [
    { file: 'clawd-idle-look.svg', duration: 6500 },
    { file: 'clawd-idle-bubble.svg', duration: 13500 },
    { file: 'clawd-idle-reading.svg', duration: 14000 },
  ],
  workingTiers: [
    { minSessions: 3, file: 'clawd-working-building.svg' },
    { minSessions: 2, file: 'clawd-headphones-groove.svg' },
    { minSessions: 1, file: 'clawd-working-typing.svg' },
  ],
  reactions: {
    drag: { file: 'clawd-react-drag.svg' },
    clickLeft: { file: 'clawd-react-left.svg', duration: 2500 },
    clickRight: { file: 'clawd-react-right.svg', duration: 2500 },
    double: { files: ['clawd-react-double.svg', 'clawd-react-double-jump.svg'], duration: 2500 },
    annoyed: { file: 'clawd-react-annoyed.svg', duration: 3500 },
  },
  timings: {
    minDisplay: { attention: 4000, error: 5000, sweeping: 5500, notification: 5000, carrying: 3000 },
  },
}

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const value = (name) => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 ? argv[index + 1] : undefined
}

const candidates = [
  value('from'),
  process.env.CLAWD_ON_DESK_DIR,
  path.join(os.homedir(), 'Programme', 'Git', 'clawd-on-desk'),
  path.join(ROOT, '..', 'clawd-on-desk'),
  path.join(os.homedir(), 'clawd-on-desk'),
].filter(Boolean)

const source = candidates.map((entry) => path.resolve(entry)).find((entry) => fs.existsSync(path.join(entry, 'assets', 'svg')))
if (!source) {
  process.stderr.write(
    `no clawd-on-desk checkout found (looked for assets/svg in):\n  ${candidates.join('\n  ')}\n` +
      `pass one explicitly: node scripts/setup-local-art.mjs --from /path/to/clawd-on-desk\n`,
  )
  process.exit(1)
}

const assetDir = path.join(source, 'assets', 'svg')
const available = new Set(fs.readdirSync(assetDir))
const referenced = new Set()
const collect = (entry) => {
  if (Array.isArray(entry)) entry.forEach(collect)
  else if (entry && typeof entry === 'object') collect(entry.file ?? entry.files)
  else if (typeof entry === 'string') referenced.add(entry)
}
for (const state of Object.values(MAPPING.states)) collect(state)
MAPPING.idleAnimations.forEach(collect)
MAPPING.workingTiers.forEach(collect)
Object.values(MAPPING.reactions).forEach(collect)

const missing = [...referenced].filter((file) => !available.has(file))
if (missing.length) {
  process.stderr.write(`the checkout at ${source} is missing ${missing.length} referenced file(s):\n  ${missing.join('\n  ')}\n`)
  process.exit(1)
}

fs.mkdirSync(TARGET, { recursive: true })
if (flag('force')) fs.rmSync(path.join(TARGET, 'art'), { recursive: true, force: true })

const link = path.join(TARGET, 'art')
if (!fs.existsSync(link)) {
  fs.symlinkSync(assetDir, link, 'dir')
}

const theme = {
  schemaVersion: 1,
  id: 'clawd',
  name: 'Clawd (local-only artwork)',
  author: 'clawd-on-desk artwork, linked locally',
  version: '1.0.0',
  license: 'All Rights Reserved — LOCAL USE ONLY, NOT REDISTRIBUTABLE',
  description: 'Clawd, linked from a local clawd-on-desk checkout. This theme is never committed or shipped; see PROVENANCE.md.',
  _artwork: `linked from ${assetDir}`,
  _license: 'The artwork in this theme is All Rights Reserved and is covered by neither this repository nor its MIT license.',
  viewBox: { x: -15, y: -25, width: 45, height: 45 },
  // Every file in this set keeps 45x45 units of viewBox around a character that
  // occupies about 23x20 of them (the source theme's own layout.contentBox).
  contentBox: { x: -4, y: -3, width: 23, height: 20 },
  objectScale: { widthRatio: 1, heightRatio: 1, offsetX: 0, offsetY: 0 },
  states: MAPPING.states,
  workingTiers: MAPPING.workingTiers,
  idleAnimations: MAPPING.idleAnimations,
  reactions: MAPPING.reactions,
  timings: MAPPING.timings,
}

fs.writeFileSync(path.join(TARGET, 'theme.json'), `${JSON.stringify(theme, null, 2)}\n`, 'utf8')
process.stdout.write(
  `local theme "clawd" ready\n  artwork: ${assetDir} (symlinked as assets/local-themes/clawd/art)\n  manifest: ${path.relative(ROOT, path.join(TARGET, 'theme.json'))}\n` +
    `  ${referenced.size} referenced files, all present\n  NOT committed: assets/local-themes/ is in .gitignore\n`,
)
