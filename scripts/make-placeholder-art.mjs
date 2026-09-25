#!/usr/bin/env node
/**
 * Generates the placeholder theme's artwork.
 *
 * The placeholder exists so that a fresh clone of this repository renders
 * something without shipping anyone else's artwork: it is an original blob,
 * deliberately unlike any existing character, drawn from this file. Regenerate
 * with `node scripts/make-placeholder-art.mjs`; the output is committed, so the
 * plugin never needs this script at runtime.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'assets', 'themes', 'placeholder')

const BODY = '#8b6cf0'
const BODY_DARK = '#6d4fd6'
const INK = '#241a3d'

/** Eyes: open, closed, half, wide, happy, cross, dizzy. */
function eyes(kind) {
  const left = 25
  const right = 39
  const y = 32
  switch (kind) {
    case 'closed':
      return `<path d="M${left - 3} ${y} q3 3 6 0" stroke="${INK}" stroke-width="1.6" fill="none" stroke-linecap="round"/>
              <path d="M${right - 3} ${y} q3 3 6 0" stroke="${INK}" stroke-width="1.6" fill="none" stroke-linecap="round"/>`
    case 'half':
      return `<path d="M${left - 3} ${y - 1} h6" stroke="${INK}" stroke-width="1.6" stroke-linecap="round"/>
              <path d="M${right - 3} ${y - 1} h6" stroke="${INK}" stroke-width="1.6" stroke-linecap="round"/>
              <circle cx="${left}" cy="${y + 2}" r="2" fill="${INK}"/>
              <circle cx="${right}" cy="${y + 2}" r="2" fill="${INK}"/>`
    case 'happy':
      return `<path d="M${left - 3} ${y + 1} q3 -4 6 0" stroke="${INK}" stroke-width="1.8" fill="none" stroke-linecap="round"/>
              <path d="M${right - 3} ${y + 1} q3 -4 6 0" stroke="${INK}" stroke-width="1.8" fill="none" stroke-linecap="round"/>`
    case 'wide':
      return `<circle cx="${left}" cy="${y}" r="3.6" fill="#fff"/><circle cx="${right}" cy="${y}" r="3.6" fill="#fff"/>
              <circle cx="${left}" cy="${y}" r="1.8" fill="${INK}"/><circle cx="${right}" cy="${y}" r="1.8" fill="${INK}"/>`
    case 'cross':
      return `<path d="M${left - 3} ${y - 3} l6 6 M${left + 3} ${y - 3} l-6 6" stroke="${INK}" stroke-width="1.6" stroke-linecap="round"/>
              <path d="M${right - 3} ${y - 3} l6 6 M${right + 3} ${y - 3} l-6 6" stroke="${INK}" stroke-width="1.6" stroke-linecap="round"/>`
    case 'dizzy':
      return `<path d="M${left} ${y - 3} a3 3 0 1 1 -2.6 4.4" stroke="${INK}" stroke-width="1.4" fill="none" stroke-linecap="round"/>
              <path d="M${right} ${y + 3} a3 3 0 1 1 2.6 -4.4" stroke="${INK}" stroke-width="1.4" fill="none" stroke-linecap="round"/>`
    default:
      return `<circle cx="${left}" cy="${y}" r="3" fill="#fff"/><circle cx="${right}" cy="${y}" r="3" fill="#fff"/>
              <circle cx="${left}" cy="${y + 0.6}" r="1.5" fill="${INK}"/><circle cx="${right}" cy="${y + 0.6}" r="1.5" fill="${INK}"/>`
  }
}

function mouth(kind) {
  switch (kind) {
    case 'small':
      return `<path d="M30 40 q2 2 4 0" stroke="${INK}" stroke-width="1.5" fill="none" stroke-linecap="round"/>`
    case 'open':
      return `<ellipse cx="32" cy="41" rx="4.5" ry="5" fill="${INK}" opacity=".85"/>`
    case 'flat':
      return `<path d="M29 41 h6" stroke="${INK}" stroke-width="1.5" stroke-linecap="round"/>`
    default:
      return `<path d="M29.5 40 q2.5 2.4 5 0" stroke="${INK}" stroke-width="1.6" fill="none" stroke-linecap="round"/>`
  }
}

/** The shared creature: shadow, body, belly, face, antenna. */
function blob({ face = 'open', mouthKind = 'smile', extra = '', bodyClass = 'blob', bodyAttrs = '' } = {}) {
  return `<g class="${bodyClass}" ${bodyAttrs}>
    <ellipse cx="32" cy="56" rx="15" ry="3.2" fill="#1b1430" opacity=".22"/>
    <rect x="14" y="16" width="36" height="36" rx="15" fill="${BODY}"/>
    <rect x="14" y="30" width="36" height="22" rx="15" fill="${BODY_DARK}" opacity=".35"/>
    <rect x="23" y="34" width="18" height="13" rx="6.5" fill="#ffffff" opacity=".2"/>
    ${eyes(face)}
    ${mouth(mouthKind)}
    <line x1="32" y1="16" x2="32" y2="9" stroke="${INK}" stroke-width="1.6" stroke-linecap="round"/>
    <circle class="tip" cx="32" cy="7.5" r="2.6" fill="#ffd166"/>
    ${extra}
  </g>`
}

const wrap = (title, style, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="256" height="256" role="img" aria-label="${title}">
  <title>${title}</title>
  <style>
    .blob{transform-box:fill-box;transform-origin:50% 92%}
    .tip{transform-box:fill-box;transform-origin:50% 100%}
    ${style}
  </style>
  ${body}
</svg>
`

const ART = {
  idle: wrap(
    'Placeholder pet, idle',
    `.blob{animation:breathe 3.2s ease-in-out infinite}
     .tip{animation:blink 4s ease-in-out infinite}
     @keyframes breathe{0%,100%{transform:scale(1,1)}50%{transform:scale(1.03,.97)}}
     @keyframes blink{0%,90%,100%{opacity:1}95%{opacity:.3}}`,
    blob({ face: 'open', mouthKind: 'smile' }),
  ),
  thinking: wrap(
    'Placeholder pet, thinking',
    `.blob{animation:sway 2.4s ease-in-out infinite}
     .dots circle{animation:hop 1.2s ease-in-out infinite}
     .dots circle:nth-child(2){animation-delay:.15s}
     .dots circle:nth-child(3){animation-delay:.3s}
     @keyframes sway{0%,100%{transform:rotate(-2deg)}50%{transform:rotate(2deg)}}
     @keyframes hop{0%,100%{transform:translateY(0);opacity:.5}50%{transform:translateY(-3px);opacity:1}}`,
    blob({
      face: 'half',
      mouthKind: 'flat',
      extra: `<g class="dots" fill="#ffd166"><circle cx="47" cy="13" r="2"/><circle cx="53" cy="9" r="2"/><circle cx="59" cy="5" r="2"/></g>`,
    }),
  ),
  working: wrap(
    'Placeholder pet, working',
    `.blob{animation:type .28s steps(2,end) infinite}
     .arms line{animation:arms .28s steps(2,end) infinite}
     .arms line:nth-child(2){animation-delay:.14s}
     @keyframes type{0%{transform:translateY(0)}100%{transform:translateY(1.2px)}}
     @keyframes arms{0%{transform:translateY(0)}100%{transform:translateY(2px)}}`,
    blob({
      face: 'open',
      mouthKind: 'flat',
      extra: `<g class="arms" stroke="${INK}" stroke-width="2" stroke-linecap="round">
        <line x1="16" y1="42" x2="10" y2="45"/><line x1="48" y1="42" x2="54" y2="45"/>
      </g>
      <rect x="8" y="46" width="48" height="3" rx="1.5" fill="${INK}" opacity=".7"/>`,
    }),
  ),
  attention: wrap(
    'Placeholder pet, done',
    `.blob{animation:jump .9s ease-in-out infinite}
     .spark{transform-box:fill-box;transform-origin:50% 50%;animation:spin 2.4s linear infinite}
     @keyframes jump{0%,100%{transform:translateY(0) scale(1,1)}45%{transform:translateY(-6px) scale(.97,1.05)}}
     @keyframes spin{to{transform:rotate(360deg)}}`,
    blob({
      face: 'happy',
      mouthKind: 'small',
      extra: `<g class="spark" fill="#ffe08a">
        <path d="M52 14 l1.6 3.4 3.4 1.6 -3.4 1.6 -1.6 3.4 -1.6 -3.4 -3.4 -1.6 3.4 -1.6z"/>
      </g>`,
    }),
  ),
  error: wrap(
    'Placeholder pet, error',
    `.blob{animation:wobble 1.6s ease-in-out infinite}
     @keyframes wobble{0%,100%{transform:rotate(-3deg)}50%{transform:rotate(3deg)}}`,
    blob({
      face: 'cross',
      mouthKind: 'flat',
      extra: `<g stroke="#ff7a7a" stroke-width="2" stroke-linecap="round" opacity=".9">
        <line x1="48" y1="18" x2="56" y2="26"/><line x1="56" y1="18" x2="48" y2="26"/>
      </g>`,
    }),
  ),
  notification: wrap(
    'Placeholder pet, waiting for you',
    `.blob{animation:pulse 1.4s ease-in-out infinite}
     .bang{transform-box:fill-box;transform-origin:50% 100%;animation:ring 1.4s ease-in-out infinite}
     @keyframes pulse{0%,100%{transform:scale(1,1)}50%{transform:scale(1.04,.97)}}
     @keyframes ring{0%,100%{transform:rotate(-8deg)}50%{transform:rotate(8deg)}}`,
    blob({
      face: 'wide',
      mouthKind: 'open',
      extra: `<g class="bang" fill="#ffd166">
        <rect x="46" y="8" width="4" height="12" rx="2"/>
        <circle cx="48" cy="24" r="2.4"/>
      </g>`,
    }),
  ),
  sweeping: wrap(
    'Placeholder pet, compacting',
    `.blob{animation:sweep 1.8s ease-in-out infinite}
     .broom{transform-box:fill-box;transform-origin:90% 10%;animation:brush 1.8s ease-in-out infinite}
     @keyframes sweep{0%,100%{transform:translateX(-2px)}50%{transform:translateX(2px)}}
     @keyframes brush{0%,100%{transform:rotate(-12deg)}50%{transform:rotate(12deg)}}`,
    blob({
      face: 'half',
      mouthKind: 'flat',
      extra: `<g class="broom"><line x1="44" y1="18" x2="56" y2="40" stroke="#c9a227" stroke-width="2.4" stroke-linecap="round"/>
        <path d="M52 38 l8 4 -6 6 -6 -6z" fill="#e0b84a"/></g>`,
    }),
  ),
  juggling: wrap(
    'Placeholder pet, subagents',
    `.blob{animation:bob 1.2s ease-in-out infinite}
     .balls circle{animation:toss 1.2s ease-in-out infinite}
     .balls circle:nth-child(2){animation-delay:.2s}
     .balls circle:nth-child(3){animation-delay:.4s}
     @keyframes bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-2px)}}
     @keyframes toss{0%,100%{transform:translateY(0)}50%{transform:translateY(-8px)}}`,
    blob({
      face: 'happy',
      mouthKind: 'smile',
      extra: `<g class="balls"><circle cx="20" cy="10" r="3" fill="#6ee7b7"/><circle cx="32" cy="6" r="3" fill="#93c5fd"/><circle cx="44" cy="10" r="3" fill="#fca5a5"/></g>`,
    }),
  ),
  carrying: wrap(
    'Placeholder pet, carrying',
    `.blob{animation:walk 1s ease-in-out infinite}
     .box{transform-box:fill-box;transform-origin:50% 100%;animation:shift 1s ease-in-out infinite}
     @keyframes walk{0%,100%{transform:translateY(0) rotate(-1.5deg)}50%{transform:translateY(-2px) rotate(1.5deg)}}
     @keyframes shift{0%,100%{transform:rotate(-3deg)}50%{transform:rotate(3deg)}}`,
    blob({
      face: 'open',
      mouthKind: 'flat',
      extra: `<g class="box"><rect x="22" y="2" width="20" height="12" rx="2.5" fill="#c9a227"/>
        <path d="M22 6 h20" stroke="#8a6d16" stroke-width="1.4"/></g>`,
    }),
  ),
  sleeping: wrap(
    'Placeholder pet, sleeping',
    `.blob{animation:sleep 4.5s ease-in-out infinite}
     .zzz text{animation:float 3.6s ease-in-out infinite}
     @keyframes sleep{0%,100%{transform:scale(1,1)}50%{transform:scale(1.04,.96)}}
     @keyframes float{0%{opacity:0;transform:translateY(2px)}30%{opacity:1}100%{opacity:0;transform:translateY(-8px)}}`,
    blob({
      face: 'closed',
      mouthKind: 'small',
      extra: `<g class="zzz" fill="#cfd6ff" font-family="monospace" font-size="9">
        <text x="47" y="16">z</text><text x="53" y="10" font-size="7">z</text>
      </g>`,
    }),
  ),
  yawning: wrap(
    'Placeholder pet, yawning',
    `.blob{animation:stretch 2s ease-in-out infinite}
     @keyframes stretch{0%,100%{transform:scale(1,1)}40%{transform:scale(.97,1.05)}}`,
    blob({ face: 'half', mouthKind: 'open' }),
  ),
  dozing: wrap(
    'Placeholder pet, dozing',
    `.blob{animation:nod 2.6s ease-in-out infinite}
     @keyframes nod{0%,100%{transform:rotate(-4deg)}50%{transform:rotate(1deg)}}`,
    blob({ face: 'half', mouthKind: 'flat' }),
  ),
  collapsing: wrap(
    'Placeholder pet, curling up',
    `.blob{animation:flatten 2.6s ease-in-out infinite}
     @keyframes flatten{0%,100%{transform:scale(1,1)}50%{transform:scale(1.12,.82) translateY(8px)}}`,
    blob({ face: 'closed', mouthKind: 'flat' }),
  ),
  waking: wrap(
    'Placeholder pet, waking up',
    `.blob{animation:rise 1.5s ease-out both}
     @keyframes rise{0%{transform:scale(1.1,.85) translateY(6px)}60%{transform:scale(.98,1.04)}100%{transform:scale(1,1)}}`,
    blob({ face: 'wide', mouthKind: 'open' }),
  ),
  roam: wrap(
    'Placeholder pet, roaming',
    `.blob{animation:crab 1.2s ease-in-out infinite}
     @keyframes crab{0%,100%{transform:translateX(-3px) rotate(-2deg)}50%{transform:translateX(3px) rotate(2deg)}}`,
    blob({ face: 'open', mouthKind: 'smile' }),
  ),
}

const THEME = {
  schemaVersion: 1,
  id: 'placeholder',
  name: 'Placeholder Blob',
  author: 'dsh-clawd contributors',
  version: '1.0.0',
  license: 'MIT',
  description: 'Original stand-in artwork drawn by scripts/make-placeholder-art.mjs so a fresh clone renders something. Replace it with your own theme.',
  viewBox: { x: 0, y: 0, width: 64, height: 64 },
  // The drawn creature occupies roughly x 8..56, y 2..58 of the 64x64 viewBox;
  // declaring it lets any host size the pet by the character, not by the frame.
  contentBox: { x: 8, y: 2, width: 48, height: 56 },
  objectScale: { widthRatio: 1, heightRatio: 1, offsetX: 0, offsetY: 0 },
  states: {
    idle: ['idle.svg'],
    thinking: ['thinking.svg'],
    working: ['working.svg'],
    attention: ['attention.svg'],
    error: ['error.svg'],
    notification: ['notification.svg'],
    sweeping: ['sweeping.svg'],
    juggling: ['juggling.svg'],
    carrying: ['carrying.svg'],
    sleeping: ['sleeping.svg'],
    yawning: ['yawning.svg'],
    dozing: ['dozing.svg'],
    collapsing: ['collapsing.svg'],
    waking: ['waking.svg'],
    roam: ['roam.svg'],
  },
  workingTiers: [
    { minSessions: 3, file: 'working.svg' },
    { minSessions: 2, file: 'juggling.svg' },
    { minSessions: 1, file: 'working.svg' },
  ],
  idleAnimations: [
    { file: 'idle.svg', duration: 8000 },
    { file: 'dozing.svg', duration: 6000 },
    { file: 'roam.svg', duration: 7000 },
  ],
  reactions: {
    // `drag` is a pose held for as long as the pointer is down, so it carries no
    // duration; the click reactions are one-shots and do.
    drag: { file: 'carrying.svg' },
    clickLeft: { file: 'attention.svg', duration: 2000 },
    clickRight: { file: 'error.svg', duration: 2000 },
    double: { file: 'juggling.svg', duration: 2200 },
    annoyed: { file: 'sweeping.svg', duration: 2200 },
  },
  timings: {
    minDisplay: { attention: 4000, error: 5000, notification: 2500, sweeping: 4000, carrying: 3000 },
    idleSleepMs: 180000,
    sleepStepMs: 30000,
  },
}

const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="128" height="128" role="img" aria-label="dsh-clawd">
  <title>dsh-clawd</title>
  <rect x="6" y="6" width="52" height="52" rx="14" fill="#8b6cf0"/>
  <rect x="6" y="30" width="52" height="28" rx="14" fill="#6d4fd6" opacity=".35"/>
  <circle cx="24" cy="30" r="4" fill="#fff"/><circle cx="40" cy="30" r="4" fill="#fff"/>
  <circle cx="24" cy="31" r="2" fill="#241a3d"/><circle cx="40" cy="31" r="2" fill="#241a3d"/>
  <path d="M27 42 q5 4 10 0" stroke="#241a3d" stroke-width="2.2" fill="none" stroke-linecap="round"/>
  <line x1="32" y1="6" x2="32" y2="0" stroke="#241a3d" stroke-width="0" />
</svg>
`

fs.mkdirSync(path.join(OUT, 'art'), { recursive: true })
fs.mkdirSync(path.join(ROOT, 'assets', 'branding'), { recursive: true })
for (const [name, body] of Object.entries(ART)) {
  fs.writeFileSync(path.join(OUT, 'art', `${name}.svg`), body, 'utf8')
}
fs.writeFileSync(path.join(OUT, 'theme.json'), `${JSON.stringify(THEME, null, 2)}\n`, 'utf8')
fs.writeFileSync(path.join(ROOT, 'assets', 'branding', 'icon.svg'), `${ICON}\n`, 'utf8')
process.stdout.write(`placeholder theme written: ${Object.keys(ART).length} files -> ${path.relative(ROOT, OUT)}\n`)
