#!/usr/bin/env node
/**
 * Scaffolds a new theme.
 *
 * Usage:
 *   node scripts/create-theme.mjs <theme-id> [--name "Display Name"] [--author "You"] [--dir <target root>]
 *
 * The new theme starts from this repository's own placeholder artwork (MIT), so
 * it is immediately valid and immediately yours to replace. Default target is
 * `$DSH_HOME/dsh-clawd/themes/`, where the running plugin picks it up after a
 * "Reload themes" in Settings -> Clawd.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')

const argv = process.argv.slice(2)
const value = (name) => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 ? argv[index + 1] : undefined
}
const positional = []
for (let index = 0; index < argv.length; index += 1) {
  if (argv[index].startsWith('--')) {
    index += 1
    continue
  }
  positional.push(argv[index])
}
const id = positional[0]

if (!id) {
  process.stderr.write(
    'usage: node scripts/create-theme.mjs <theme-id> [--name "Display Name"] [--author "You"] [--dir <root>]\n',
  )
  process.exit(2)
}
if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
  process.stderr.write(`theme id "${id}" must be lowercase letters, digits and dashes\n`)
  process.exit(2)
}

const targetRoot = path.resolve(value('dir') ?? path.join(DSH_HOME, 'dsh-clawd', 'themes'))
let target = path.join(targetRoot, id)
for (let suffix = 2; fs.existsSync(target); suffix += 1) target = path.join(targetRoot, `${id}-${suffix}`)

const source = path.join(ROOT, 'assets', 'themes', 'placeholder')
const template = JSON.parse(fs.readFileSync(path.join(source, 'theme.json'), 'utf8'))
const manifest = {
  ...template,
  id: path.basename(target),
  name: value('name') ?? path.basename(target),
  author: value('author') ?? 'unknown',
  description: `Theme "${value('name') ?? path.basename(target)}", scaffolded from the placeholder theme. Replace the artwork in art/ and adjust states in theme.json.`,
}

fs.mkdirSync(path.join(target, 'art'), { recursive: true })
for (const file of fs.readdirSync(path.join(source, 'art'))) {
  fs.copyFileSync(path.join(source, 'art', file), path.join(target, 'art', file))
}
fs.writeFileSync(path.join(target, 'theme.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

process.stdout.write(
  `theme "${manifest.id}" created at ${target}\n` +
    `  ${fs.readdirSync(path.join(target, 'art')).length} starter files copied from the placeholder theme (MIT)\n` +
    `  validate with: node scripts/validate-theme.mjs ${target}\n` +
    `  then: Settings -> Clawd -> Reload themes\n`,
)
