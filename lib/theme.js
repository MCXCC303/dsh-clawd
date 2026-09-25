/**
 * Theme discovery, validation and artwork resolution.
 *
 * A theme is a directory holding `theme.json` plus the artwork it references.
 * The manifest format keeps the field names of the `clawd-on-desk` theme
 * contract (`schemaVersion`, `states`, `workingTiers`, `idleAnimations`,
 * `timings`, `reactions`, ...) so that format-level knowledge transfers, but the
 * file itself is ours and this validator is an independent implementation.
 *
 * Resolution order for a theme id, later roots winning:
 *   1. `<package>/assets/themes/`       redistributable themes shipped in the box
 *   2. `<package>/assets/local-themes/` local-only artwork (gitignored, see PROVENANCE.md)
 *   3. `$DSH_HOME/dsh-clawd/themes/`    themes the user dropped in at runtime
 *
 * @module dsh-clawd/theme
 */

import fs from 'node:fs'
import path from 'node:path'

import { ALL_STATES, FALLBACK_STATES, REQUIRED_STATES, SCHEMA_VERSION } from './state.js'

/** Artwork extensions a theme may reference. */
export const ART_EXTENSIONS = Object.freeze(['.svg', '.png', '.gif', '.webp', '.apng', '.jpg', '.jpeg'])

const MAX_FALLBACK_HOPS = 3

/** Read and parse a theme manifest, returning diagnostics instead of throwing. */
export function readTheme(themeDir) {
  const manifestPath = path.join(themeDir, 'theme.json')
  let raw
  try {
    raw = fs.readFileSync(manifestPath, 'utf8')
  } catch (error) {
    return { ok: false, errors: [`theme.json is unreadable: ${error.message}`], warnings: [] }
  }
  let manifest
  try {
    manifest = JSON.parse(raw)
  } catch (error) {
    return { ok: false, errors: [`theme.json is not valid JSON: ${error.message}`], warnings: [] }
  }
  const { errors, warnings } = validateTheme(manifest, themeDir)
  return { ok: errors.length === 0, errors, warnings, manifest, manifestPath }
}

/**
 * Validate a parsed theme manifest against the contract and the artwork that is
 * actually present on disk.
 *
 * @param {object} manifest
 * @param {string} themeDir - directory the manifest lives in (artwork is checked against it).
 */
export function validateTheme(manifest, themeDir) {
  const errors = []
  const warnings = []
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { errors: ['theme.json must contain a JSON object'], warnings }
  }
  if (manifest.schemaVersion !== SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${SCHEMA_VERSION} (found ${JSON.stringify(manifest.schemaVersion)})`)
  }
  if (typeof manifest.id !== 'string' || !manifest.id.trim()) errors.push('id must be a non-empty string')
  if (typeof manifest.name !== 'string' || !manifest.name.trim()) warnings.push('name is missing; the id is used instead')

  const states = manifest.states
  if (!states || typeof states !== 'object' || Array.isArray(states)) {
    errors.push('states must be an object mapping state names to artwork')
  } else {
    for (const state of REQUIRED_STATES) {
      if (!states[state]) errors.push(`states.${state} is required`)
    }
    for (const [state, entry] of Object.entries(states)) {
      if (!ALL_STATES.includes(state)) warnings.push(`states.${state} is not a state this build knows; it will never be shown`)
      if (Array.isArray(entry)) {
        if (entry.length === 0) errors.push(`states.${state} lists no file`)
        for (const file of entry) checkFile(file, `states.${state}`, themeDir, errors)
      } else if (entry && typeof entry === 'object') {
        if (!Array.isArray(entry.files) || entry.files.length === 0) errors.push(`states.${state}.files must be a non-empty array`)
        else for (const file of entry.files) checkFile(file, `states.${state}.files`, themeDir, errors)
        if (entry.fallbackTo !== undefined) {
          if (!FALLBACK_STATES.includes(state)) errors.push(`states.${state} may not declare fallbackTo`)
          if (!ALL_STATES.includes(entry.fallbackTo)) errors.push(`states.${state}.fallbackTo names an unknown state`)
        }
      } else {
        errors.push(`states.${state} must be an array of files or { files, fallbackTo }`)
      }
    }
    for (const state of ALL_STATES) {
      if (states[state]) continue
      const reached = FALLBACK_STATES.includes(state)
      if (reached) warnings.push(`states.${state} is missing; the pet falls back to another state there`)
    }
    checkFallbackCycles(states, errors)
  }

  for (const key of ['workingTiers', 'jugglingTiers']) {
    const tiers = manifest[key]
    if (tiers === undefined) continue
    if (!Array.isArray(tiers)) {
      errors.push(`${key} must be an array of { minSessions, file }`)
      continue
    }
    for (const tier of tiers) {
      if (!tier || typeof tier !== 'object' || !Number.isFinite(tier.minSessions)) errors.push(`${key} entries need a numeric minSessions`)
      else checkFile(tier.file, key, themeDir, errors)
    }
  }

  if (manifest.idleAnimations !== undefined) {
    if (!Array.isArray(manifest.idleAnimations)) errors.push('idleAnimations must be an array of { file, duration }')
    else {
      for (const entry of manifest.idleAnimations) {
        if (!entry || typeof entry !== 'object') errors.push('idleAnimations entries must be objects')
        else checkFile(entry.file, 'idleAnimations', themeDir, errors)
      }
    }
  }

  if (manifest.reactions !== undefined) {
    if (!manifest.reactions || typeof manifest.reactions !== 'object') errors.push('reactions must be an object')
    else {
      for (const [kind, entry] of Object.entries(manifest.reactions)) {
        if (entry === null) continue
        if (Array.isArray(entry)) {
          for (const file of entry) checkFile(file, `reactions.${kind}`, themeDir, errors)
        } else if (typeof entry === 'object') {
          if (Array.isArray(entry.files)) for (const file of entry.files) checkFile(file, `reactions.${kind}.files`, themeDir, errors)
          else checkFile(entry.file, `reactions.${kind}`, themeDir, errors)
        } else {
          errors.push(`reactions.${kind} must be a file, a file list, or null`)
        }
      }
    }
  }

  if (manifest.viewBox !== undefined) {
    const box = manifest.viewBox
    if (!box || !['x', 'y', 'width', 'height'].every((key) => Number.isFinite(box[key])) || box.width <= 0 || box.height <= 0) {
      errors.push('viewBox must be { x, y, width, height } with positive width and height')
    }
  }

  if (manifest.contentBox !== undefined) {
    const box = manifest.contentBox
    if (!box || !['x', 'y', 'width', 'height'].every((key) => Number.isFinite(box[key])) || box.width <= 0 || box.height <= 0) {
      errors.push('contentBox must be { x, y, width, height } with positive width and height')
    } else if (manifest.viewBox) {
      const view = manifest.viewBox
      const inside =
        box.x >= view.x - 0.001 &&
        box.y >= view.y - 0.001 &&
        box.x + box.width <= view.x + view.width + 0.001 &&
        box.y + box.height <= view.y + view.height + 0.001
      if (!inside) warnings.push('contentBox reaches outside viewBox; the pet may be clipped by its own frame')
    }
  }

  return { errors, warnings }
}

function checkFile(file, where, themeDir, errors) {
  if (typeof file !== 'string' || !file.trim()) {
    errors.push(`${where} references an empty file name`)
    return
  }
  if (file.includes('..') || path.isAbsolute(file) || file.includes('\\')) {
    errors.push(`${where} references "${file}": only plain file names inside the theme may be used`)
    return
  }
  if (!ART_EXTENSIONS.includes(path.extname(file).toLowerCase())) {
    errors.push(`${where} references "${file}": allowed artwork is ${ART_EXTENSIONS.join(', ')}`)
    return
  }
  if (!themeDir) return
  const candidate = path.join(themeDir, file)
  if (!fs.existsSync(candidate)) {
    // Themes may keep artwork in an `art/` or `assets/` subdirectory.
    const nested = ['art', 'assets']
      .map((dir) => path.join(themeDir, dir, file))
      .find((value) => fs.existsSync(value))
    if (!nested) errors.push(`${where} references "${file}", which does not exist in the theme directory`)
  }
}

function checkFallbackCycles(states, errors) {
  for (const state of Object.keys(states)) {
    const seen = new Set([state])
    let current = state
    for (let hop = 0; hop < MAX_FALLBACK_HOPS; hop += 1) {
      const entry = states[current]
      const next = entry && !Array.isArray(entry) && typeof entry === 'object' ? entry.fallbackTo : undefined
      if (!next) break
      if (seen.has(next)) {
        errors.push(`fallback chain from states.${state} loops through ${next}`)
        break
      }
      seen.add(next)
      current = next
      if (hop === MAX_FALLBACK_HOPS - 1) {
        const entry2 = states[current]
        if (entry2 && !Array.isArray(entry2) && entry2.fallbackTo) {
          errors.push(`fallback chain from states.${state} is longer than ${MAX_FALLBACK_HOPS} hops`)
        }
      }
    }
  }
}

/**
 * Files an audit measured as painting nothing (`audit.json`, written by
 * `scripts/audit-local-art.mjs`). Rendering one of these shows an empty frame,
 * so the host substitutes a usable pose instead. Absent audit means an empty
 * set: nothing is assumed about artwork that was never measured.
 */
export function readUnrenderable(themeDir) {
  try {
    const audit = JSON.parse(fs.readFileSync(path.join(themeDir, 'audit.json'), 'utf8'))
    const listed = [...(audit?.unrenderable ?? []), ...(audit?.manualUnrenderable ?? [])]
    return new Set(listed.filter((file) => typeof file === 'string'))
  } catch {
    return new Set()
  }
}

/** Every file a state can show, in the order the fallback chain resolves them. */
export function filesForState(manifest, state) {
  const seen = new Set()
  let current = state
  for (let hop = 0; hop <= MAX_FALLBACK_HOPS; hop += 1) {
    if (!current || seen.has(current)) return []
    seen.add(current)
    const { files, fallbackTo } = stateArtwork(manifest, current)
    if (files.length) return files
    current = fallbackTo
  }
  return []
}

/** Resolve a referenced artwork file to a path inside the theme directory. */
export function resolveArtFile(theme, file) {
  if (!theme || typeof file !== 'string' || !file) return undefined
  if (file.includes('..') || path.isAbsolute(file) || file.includes('\\')) return undefined
  for (const candidate of [path.join(theme.dir, file), path.join(theme.dir, 'art', file), path.join(theme.dir, 'assets', file)]) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate
    } catch {
      /* keep looking */
    }
  }
  return undefined
}

/** Flatten every artwork file a theme references. */
export function themeFiles(manifest) {
  const files = new Set()
  const push = (file) => {
    if (typeof file === 'string' && file) files.add(file)
  }
  const pushEntry = (entry) => {
    if (Array.isArray(entry)) entry.forEach(push)
    else if (entry && typeof entry === 'object') pushEntry(entry.files ?? entry.file)
    else push(entry)
  }
  for (const entry of Object.values(manifest?.states ?? {})) pushEntry(entry)
  for (const tier of [...(manifest?.workingTiers ?? []), ...(manifest?.jugglingTiers ?? [])]) push(tier?.file)
  for (const entry of manifest?.idleAnimations ?? []) push(entry?.file)
  for (const entry of Object.values(manifest?.reactions ?? {})) pushEntry(entry)
  return [...files]
}

/** Normalize one state's artwork entry into a list of file names plus its fallback. */
export function stateArtwork(manifest, state) {
  const entry = manifest?.states?.[state]
  if (!entry) return { files: [], fallbackTo: undefined }
  if (Array.isArray(entry)) return { files: entry.slice(), fallbackTo: undefined }
  if (typeof entry === 'object') return { files: Array.isArray(entry.files) ? entry.files.slice() : [], fallbackTo: entry.fallbackTo }
  return { files: [], fallbackTo: undefined }
}

/**
 * Resolve one artwork file for a state, following `fallbackTo` hops when the
 * state itself carries no artwork.
 *
 * @param {object} manifest
 * @param {string} state
 * @param {{ pick?: number }} [options] - `pick` indexes multi-file states.
 */
export function fileForState(manifest, state, options = {}) {
  const files = filesForState(manifest, state)
  if (!files.length) return undefined
  const index = files.length > 1 ? Math.abs(Math.trunc(options.pick ?? 0)) % files.length : 0
  return files[index]
}

/**
 * The tier artwork a busy state should wear, by how many sessions are doing it:
 * a theme's `workingTiers` / `jugglingTiers` say `{ minSessions, file }`, and the
 * highest threshold the count reaches wins. The whole reached chain is returned,
 * most specific first, so a caller that cannot show one tier (its artwork was
 * measured as painting nothing) falls to the next rather than skipping tiers.
 * Empty when the theme declares no tiers for that state.
 *
 * @param {object} manifest
 * @param {string} state - only `working` and `juggling` carry tiers.
 * @param {number} count - working sessions, or active subagent sessions.
 */
export function tierFilesFor(manifest, state, count) {
  const tiers = state === 'working' ? manifest?.workingTiers : state === 'juggling' ? manifest?.jugglingTiers : undefined
  if (!Array.isArray(tiers) || tiers.length === 0) return []
  return tiers
    .filter((tier) => tier && typeof tier.file === 'string' && Number.isFinite(tier.minSessions) && count >= tier.minSessions)
    .sort((a, b) => b.minSessions - a.minSessions)
    .map((tier) => tier.file)
}

/** The most specific reached tier; see {@link tierFilesFor} for the whole chain. */
export function tierFileFor(manifest, state, count) {
  return tierFilesFor(manifest, state, count)[0]
}

/**
 * A loaded theme plus everything the host needs to serve and describe it.
 * @typedef {object} LoadedTheme
 * @property {string} id
 * @property {string} dir
 * @property {object} manifest
 * @property {string} source - which root it came from.
 */

/** Discover every theme under the given roots; later roots win on id collision. */
export function discoverThemes(roots) {
  /** @type {Map<string, LoadedTheme>} */
  const found = new Map()
  const diagnostics = []
  for (const { dir, source } of roots) {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      const themeDir = path.join(dir, entry.name)
      if (!fs.existsSync(path.join(themeDir, 'theme.json'))) continue
      const read = readTheme(themeDir)
      if (!read.ok) {
        diagnostics.push({ id: entry.name, source, errors: read.errors, warnings: read.warnings })
        continue
      }
      const id = read.manifest.id || entry.name
      found.set(id, {
        id,
        dir: themeDir,
        manifest: read.manifest,
        source,
        warnings: read.warnings,
        unrenderable: readUnrenderable(themeDir),
      })
    }
  }
  return { themes: found, diagnostics }
}
