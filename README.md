# dsh-clawd

A pixel pet for the **DeepSeek Harness Web GUI**. It sits in the corner, follows
what the Harness is doing — thinking, running tools, waiting for your approval,
finishing a turn, failing, compacting, juggling subagents — falls asleep when
nothing happens, and can be dragged anywhere.

```
turn/start        → thinking        approval/asked   → waiting for you
tool/call         → working         compaction/start → compacting
turn/end 完成     → done (one-shot) subagent session → juggling
tool/result 失败  → error (one-shot) idle 3 min       → yawns, dozes, sleeps
```

Nothing is guessed from the UI: the host half listens to the Harness'
`session/event` feed, folds it into the pet's state, and publishes the result.
The browser half only renders what it is told.

## Install

```bash
# from a checkout, into the profile that serves this GUI:
dsh plugin --profile web add link:/absolute/path/to/dsh-clawd
```

Or, from the Harness itself, install the bundle
`link:/absolute/path/to/dsh-clawd` through `plugin_manager`.

The plugin activates immediately; the pet appears in the bottom-right corner
behind `Settings → Clawd`.

## Bring in Clawd, Calico and Cloudling

This repository ships only artwork it is allowed to redistribute (the
`placeholder` theme, MIT). Everything else belongs to the `clawd-on-desk`
project and is *All Rights Reserved* — Clawd is Anthropic's character, Calico is
© 鹿鹿 — so none of it is committed. If that project is installed on your
machine, one command materializes **all of its bundled themes** locally, into
the git-ignored `assets/local-themes/`:

```bash
node scripts/setup-local-art.mjs --from /path/to/clawd-on-desk
#   OK    calico    (15 states, 28 files, 11469 KiB)
#   OK    clawd     (15 states, 48 files, 344 KiB)
#   OK    cloudling (15 states, 29 files, 563 KiB)
# then: Settings → Clawd → Reload themes
```

Nothing is copied verbatim from upstream: each `theme.json` is **translated**
into this plugin's manifest schema (states, tiers, idle pool, reactions,
timings, content box), and upstream's own scaffold theme is skipped. `--link`
symlinks the artwork instead of copying it (~12 MiB saved); `--only clawd,calico`
selects themes; `--force` regenerates ones already materialized.

### When a theme's artwork renders empty

Some upstream exports paint nothing in an `<img>`: their character is assembled
by an inline script, which the browser never runs for an `<img>` (upstream
renders those files through a live `<object>` instead). Cloudling ships eight
such files — `sweeping`, `carrying`, `sleeping`, `building`, the sleep
transitions — which would show an **empty frame**.

`npm run audit-local-art` renders every referenced file in headless Chromium,
measures the painted pixels inside the theme's `contentBox`, and writes
`audit.json` next to the theme. The plugin reads that file and substitutes the
idle pose for a state whose only artwork paints nothing. Two caveats, both
honest limitations rather than oversights:

* A file that paints *a fragment* of the character (cloudling's `juggling` shows
  only the paper plane, `conducting` only a baton) cannot be told apart from a
  legitimate pose by measurement — silhouette statistics flag real poses such as
  Calico's carrying animation too. Those two are listed under
  `manualUnrenderable` in the audit, which every re-run preserves; edit that list
  to curate a theme by hand.
* Nothing here executes scripts from theme artwork. `<img>` is used throughout
  precisely because it does not, so third-party art cannot reach into the GUI's
  document.

See [PROVENANCE.md](PROVENANCE.md) for the licensing this design exists to
respect.

## Settings

`Settings → Clawd`: show/hide, theme, size, opacity, a chime on turn end, reset
the position, reload themes. Defaults also come from the plugin's row in
`cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-clawd
      name: dsh-clawd
      config:
        enabled: true
        theme: clawd
        size: 64
```

User changes are stored in `$DSH_HOME/dsh-clawd/settings.json` and win over the
row config. Position is stored there too, and is written when you finish
dragging.

## Themes

A theme is a directory with `theme.json` plus its artwork. Lookup order, later
roots winning on id collision:

| Root | Purpose |
|---|---|
| `assets/themes/` | themes shipped with the plugin |
| `assets/local-themes/` | local-only artwork (git-ignored) |
| `$DSH_HOME/dsh-clawd/themes/` | themes you add at runtime |
| `$DSH_HOME/dsh-clawd-themes/` | same, flat alternative |

```bash
node scripts/create-theme.mjs my-cat --name "My Cat"   # scaffold from the MIT placeholder
node scripts/validate-theme.mjs                        # validate every root
```

`theme.json` fields: `schemaVersion` (must be `1`), `id`, `name`, `author`,
`description`, `viewBox`, `contentBox`, `objectScale`, `states` (`[file]` or
`{ files, fallbackTo }`), `workingTiers` / `jugglingTiers`
(`[{ minSessions, file }]`), `idleAnimations` (`[{ file, duration }]`),
`reactions` (`drag`, `clickLeft`, `clickRight`, `double`, `annoyed`), `timings`.
`states.idle`, `states.working` and `states.thinking` are required; artwork may
live beside `theme.json` or in an `art/` subdirectory, and may be SVG, PNG, GIF,
APNG, WebP or JPEG. SVG with embedded CSS `@keyframes` plays natively in an
`<img>`, which is what the built-in themes use.

A reaction is either a one-shot or a held pose: `drag` shows for exactly as long
as the pointer is down (the client holds it and releases it on pointerup, blur,
or unmount), while `clickLeft`, `clickRight`, `double` and `annoyed` play for
their `duration` (default `timings.reactionMs`). Give a held kind no `duration`;
one is ignored for it.

`contentBox` is the rectangle inside `viewBox` that the character actually
occupies. The settings "size" is the height of *that* rectangle, so artwork with
generous transparent margins — the Clawd set draws a 23×20 cat inside a 45×45
viewBox — still fills the size you asked for. Omit it and the whole viewBox is
the content.

## How it is put together

```
lib/state.js     the ONE state table: names, priorities, one-shots, timings,
                 the session-event fold. Host, scripts and validator read it;
                 the browser half has no copy of it.
lib/machine.js   the state machine: per-session records, one-shot queue with
                 minDisplay/autoReturn, approval & compaction holds, the idle →
                 sleep chain, the dominant-state resolution. Injectable clock.
lib/theme.js     theme discovery, validation, state → artwork resolution.
lib/index.js     host half: session/event wiring, settings store, and the
                 /dsh-clawd/ routes (state.json, live SSE, art, themes.json,
                 guarded settings/react/refresh writes).
lib/client.js    browser half: shell.overlay pet + settings.section page.
```

Routes are registered under one prefix and never accept a path from a request:
artwork is served by looking a *name* up in the table built from the validated
manifests. Every route runs the Harness' own Host/Origin + browser-auth fence
(`connection.requestRejection`) plus a loopback/same-origin check.

## Development

```bash
npm test                    # node:test suite over the state machine, host and client halves
npm run check               # syntax-check every entry point
npm run validate-theme      # validate every theme this plugin can see
npm run setup-local-art -- --from /path/to/clawd-on-desk
npm run audit-local-art     # measure what each theme's artwork actually paints
```

Editing `lib/client.js` hot-reloads in the browser (the Harness' client HMR
watches the served bundle). Editing the host half needs a plugin reload or a
Harness restart.

## License

MIT for the code and for the artwork this repository ships — see
[LICENSE](LICENSE). Clawd is Anthropic's character; this is an unofficial,
non-commercial fan work, and no restricted artwork is distributed here. See
[PROVENANCE.md](PROVENANCE.md) for the item-by-item inventory.

`docs/SPEC.md` is the development specification this implementation follows,
including the two research reports it is based on.
