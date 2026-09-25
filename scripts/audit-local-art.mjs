#!/usr/bin/env node
/**
 * Measures what each theme's artwork actually paints, and records the verdict in
 * the theme directory as `audit.json`.
 *
 * Why: a theme can reference files that render nothing — the most common cause
 * is an SVG exported from an authoring tool whose character is assembled by an
 * inline script, which the browser never runs for an `<img>`. The bundled
 * `cloudling` theme has eight such exports upstream. Structure alone cannot tell
 * them apart (nearly every file there contains a script, most render fine), so
 * this script renders every referenced file in headless Chromium and measures
 * the opaque pixels inside the theme's `contentBox`.
 *
 * The plugin reads `audit.json` when it loads a theme and substitutes the idle
 * pose for a state whose only artwork paints nothing, instead of showing an
 * empty frame. Nothing here needs to run at plugin runtime, and nothing here is
 * a judgement about someone else's art: it is a measurement.
 *
 * Usage:
 *   node scripts/audit-local-art.mjs [themeDir ...]
 *
 * With no argument it audits every theme the plugin can see. Needs a Chromium
 * binary (set CHROMIUM to override the search).
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { readTheme, themeFiles } from '../lib/theme.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')

/** Below this share of painted pixels inside the content box, a file is unusable. */
const INK_THRESHOLD = 1
/** Below this share, the file is usable but suspiciously empty. */
const INK_WARN = 8

const roots = [
  { dir: path.join(ROOT, 'assets', 'themes'), source: 'builtin' },
  { dir: path.join(ROOT, 'assets', 'local-themes'), source: 'local' },
  { dir: path.join(DSH_HOME, 'dsh-clawd', 'themes'), source: 'user' },
]

function findBrowser() {
  const candidates = [process.env.CHROMIUM, 'chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'chrome'].filter(Boolean)
  for (const candidate of candidates) {
    try {
      const version = execFileSync(candidate, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
      if (version) return { command: candidate, version }
    } catch {
      /* try the next one */
    }
  }
  return null
}

/** Every theme directory this plugin can see; an argument list overrides it. */
function themeDirs(args) {
  if (args.length) return args.map((dir) => path.resolve(dir))
  const found = []
  for (const { dir } of roots) {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const themeDir = path.join(dir, entry.name)
      if (fs.existsSync(path.join(themeDir, 'theme.json'))) found.push(themeDir)
    }
  }
  return found
}

/** The measurement page: render each file, count opaque pixels inside the content box. */
function measurementPage(jobs) {
  return `<!doctype html><meta charset="utf-8"><body><pre id="out">pending</pre><script>
const jobs = ${JSON.stringify(jobs)};
const lines = [];
function measure(job) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const width = 240;
      const scale = width / job.view.width;
      const height = Math.max(1, Math.round(job.view.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      const context = canvas.getContext('2d');
      context.drawImage(img, 0, 0, width, height);
      let data;
      try { data = context.getImageData(0, 0, width, height).data }
      catch (error) { resolve({ file: job.file, error: 'canvas-tainted' }); return }
      const left = (job.content.x - job.view.x) * scale;
      const top = (job.content.y - job.view.y) * scale;
      const right = left + job.content.width * scale;
      const bottom = top + job.content.height * scale;
      let insideInk = 0, insidePixels = 0, outsideInk = 0;
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const alpha = data[(y * width + x) * 4 + 3];
          const inside = x >= left && x < right && y >= top && y < bottom;
          if (inside) { insidePixels += 1; if (alpha > 8) insideInk += 1 }
          else if (alpha > 8) outsideInk += 1;
        }
      }
      resolve({ file: job.file, ink: insideInk / Math.max(1, insidePixels), outside: outsideInk / Math.max(1, insidePixels) });
    };
    img.onerror = () => resolve({ file: job.file, error: 'load-failed' });
    img.src = job.url;
  });
}
(async () => {
  for (const job of jobs) {
    const result = await measure(job);
    lines.push(result.error ? result.file + ' ERROR ' + result.error
      : result.file + ' ink=' + result.ink + ' outside=' + result.outside);
  }
  document.getElementById('out').textContent = lines.join('\\n');
})();
</script></body>`
}

function auditTheme(themeDir, browser, scratch) {
  const read = readTheme(themeDir)
  if (!read.ok) return { themeDir, errors: read.errors }
  const manifest = read.manifest
  const view = manifest.viewBox ?? { x: 0, y: 0, width: 64, height: 64 }
  const content = manifest.contentBox ?? view
  const jobs = []
  for (const file of themeFiles(manifest)) {
    for (const candidate of [path.join(themeDir, file), path.join(themeDir, 'art', file), path.join(themeDir, 'assets', file)]) {
      if (!fs.existsSync(candidate)) continue
      jobs.push({ file, url: `file://${candidate}`, view, content })
      break
    }
  }
  if (!jobs.length) return { themeDir, id: manifest.id, paints: {}, unrenderable: [], warnings: [] }

  const page = path.join(scratch, `audit-${manifest.id.replace(/[^\w-]/g, '_')}.html`)
  fs.writeFileSync(page, measurementPage(jobs), 'utf8')
  const dom = execFileSync(
    browser.command,
    [
      '--headless',
      '--disable-gpu',
      '--no-sandbox',
      '--allow-file-access-from-files',
      `--user-data-dir=${path.join(scratch, 'chrome-profile')}`,
      '--virtual-time-budget=6000',
      '--dump-dom',
      `file://${page}`,
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
  )
  const block = dom.match(/<pre id="out">([\s\S]*?)<\/pre>/)
  if (!block) return { themeDir, id: manifest.id, error: 'the measurement page produced no result' }

  const paints = {}
  const unrenderable = []
  const warnings = []
  for (const line of block[1].split('\n')) {
    const match = line.match(/^(\S+) (?:ink=([\d.eE+-]+) outside=([\d.eE+-]+)|ERROR (\S+))$/)
    if (!match) continue
    const file = match[1]
    if (match[4]) {
      unrenderable.push(file)
      warnings.push(`${file}: unreadable (${match[4]})`)
      continue
    }
    const ink = Number(match[2]) * 100
    paints[file] = { ink: Number(ink.toFixed(2)), outside: Number((Number(match[3]) * 100).toFixed(2)) }
    if (ink < INK_THRESHOLD) unrenderable.push(file)
    else if (ink < INK_WARN) warnings.push(`${file}: only ${ink.toFixed(1)}% of the content box is painted`)
  }

  // A file that paints *something* but not the character (an authoring-tool
  // export whose script assembles the real artwork, of which only a prop is
  // static) cannot be told from a legitimate pose by measurement — statistics
  // over silhouettes flag real poses too. Such a file is curated by hand into
  // `manualUnrenderable`, which survives every re-run.
  let manualUnrenderable = []
  try {
    const previous = JSON.parse(fs.readFileSync(path.join(themeDir, 'audit.json'), 'utf8'))
    if (Array.isArray(previous.manualUnrenderable)) {
      manualUnrenderable = previous.manualUnrenderable.filter((file) => typeof file === 'string')
    }
  } catch {
    /* no previous audit */
  }

  const audit = {
    version: 1,
    theme: manifest.id,
    measuredAt: new Date().toISOString(),
    renderer: browser.version,
    threshold: INK_THRESHOLD,
    unrenderable: [...new Set([...unrenderable, ...manualUnrenderable])].sort(),
    measuredUnrenderable: unrenderable,
    manualUnrenderable,
    paints,
  }
  fs.writeFileSync(path.join(themeDir, 'audit.json'), `${JSON.stringify(audit, null, 2)}\n`, 'utf8')
  return { themeDir, id: manifest.id, paints, unrenderable, warnings }
}

const args = process.argv.slice(2).filter((value) => !value.startsWith('-'))
const browser = findBrowser()
if (!browser) {
  process.stderr.write('no Chromium binary found; set CHROMIUM=/path/to/chromium and retry\n')
  process.exit(2)
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-clawd-audit-'))
let problems = 0
let missing = 0
for (const themeDir of themeDirs(args)) {
  const result = auditTheme(themeDir, browser, scratch)
  if (result.errors) {
    process.stdout.write(`FAIL  ${path.relative(ROOT, themeDir)} — ${result.errors[0]}\n`)
    problems += 1
    continue
  }
  if (result.error) {
    process.stdout.write(`FAIL  ${result.id} — ${result.error}\n`)
    problems += 1
    continue
  }
  const total = Object.keys(result.paints).length
  process.stdout.write(`${result.id}: ${total} files measured, ${result.unrenderable.length} unusable\n`)
  for (const file of result.unrenderable) process.stdout.write(`        unusable: ${file}\n`)
  for (const warning of result.warnings) process.stdout.write(`        warn:     ${warning}\n`)
  missing += result.unrenderable.length
  if (result.unrenderable.length) {
    process.stdout.write(`        -> audit.json written; those states fall back to the idle pose\n`)
  }
}

process.stdout.write(
  `\n${browser.command} (${browser.version}); threshold ${INK_THRESHOLD}% ink inside contentBox\n` +
    (missing ? `${missing} file(s) will be substituted at render time\n` : 'every referenced file paints\n'),
)
fs.rmSync(scratch, { recursive: true, force: true })
process.exit(problems ? 1 : 0)
