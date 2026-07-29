# Fitness Visualizer — Theme & Design Tokens

This app extends the shared [`theme.css`](theme.css) (documented in the
sibling-wide [`README.md`](README.md)) with its own **complete,
independently-designed light and dark theme**, plus a colorblind-safe
activity-type palette. None of this touches `theme.css` itself — it's all
scoped under `.app-fitness` in `fitness-visualizer/index.html`'s `<style>`
block, so sibling apps are unaffected.

## Why two *complete* themes, not one theme with dark overrides

The previous dark mode was a partial token flip on top of the light palette —
a handful of variables swapped, everything else inherited. It worked, but
light and dark didn't feel like two deliberate looks, and a few colors ended
up with weak contrast in one mode or the other.

Both themes below are designed as self-contained palettes and checked against
WCAG AA (4.5:1 for body text, 3:1 for large text/UI elements) against their
own `--bg`.

## Token reference

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#ffffff` | `#0b0c10` | Page background |
| `--surface` | `#f6f7fa` | `#15171d` | Section background, one step up from `--bg` |
| `--surface-2` | `#eef0f5` | `#1c1f27` | Secondary/inset background (wells, chips) |
| `--surface-raised` | `#ffffff` | `#1b1e26` | Elevated cards (elev-2) |
| `--surface-sunken` | `#eceef3` | `#08090c` | Inputs, recessed wells |
| `--border` | `#e1e4ea` | `#272b35` | Hairline divider |
| `--border-mid` | `#c7cbd6` | `#3a3f4c` | Emphasized border |
| `--text` | `#14161c` | `#f1f2f6` | Primary text — 17.9:1 / 17.7:1 |
| `--text-mid` | `#4b4f5c` | `#b7bbc9` | Secondary text — 9.1:1 / 9.4:1 |
| `--text-muted` | `#6b7080` | `#868c9c` | Tertiary text — 5.4:1 / 5.0:1 (AA) |
| `--accent` | `#1d4ed8` | `#6d9bff` | Primary interactive color — 6.3:1 / 8.4:1 |
| `--accent-strong` | `#1e3a8a` | `#9dbdff` | Hover/active/pressed |
| `--accent-light` / `--accent-quiet` | `#eaf1ff` | `#16233f` | Accent-tinted background (same value, two names — `accent-quiet` is the semantic name used going forward) |
| `--correct` / `-bg` / `-bd` | `#16a34a` / `#f0fdf4` / `#86efac` | `#4ade80` / `#0d2818` / `#1f5c3a` | Success state |
| `--wrong` / `-bg` / `-bd` | `#dc2626` / `#fef2f2` / `#fca5a5` | `#f87171` / `#2c1113` / `#7a2020` | Error state |
| `--warn` / `-bg` / `-bd` | `#b45309` / `#fffbeb` / `#fde68a` | `#fbbf24` / `#2a2000` / `#5a4200` | Warning state (duplicate banner, etc.) |
| `--elev-0..3` | → `bg` / `surface` / `surface-raised` / `#ffffff` | → `bg` / `surface` / `surface-raised` / `#22262f` | Background-based elevation — cards stack via bg delta, not shadow |
| `--shadow-elev1..3` | subtle → pronounced | subtle → pronounced (darker) | Used sparingly — modals, popovers, floating controls |

All tokens are set in two places in `index.html`:
- `.app-fitness { ... }` — light theme
- `html.dark-mode .app-fitness { ... }` — dark theme (class toggled on `<html>` by `toggleTheme()` in `app.js`)

On first visit (no stored preference), the theme follows
`prefers-color-scheme`; an explicit toggle click is stored in
`localStorage['fitness-theme']` and wins from then on.

## Activity-type colors

Defined once in [activity-colors.js](activity-colors.js) and imported by every
module that needs them (`map/heatmap.js`, `charts/distance.js`,
`charts/weekly.js`, `charts/records.js`) — previously this was copy-pasted in
four places and could drift.

Based on the **Okabe-Ito** palette, designed so all colors stay distinguishable
under protanopia, deuteranopia, and tritanopia (the three most common forms of
color blindness) — not just typical color vision. Same hex values are used in
both themes; Okabe-Ito colors sit at a lightness/saturation that reads clearly
against both white and near-black surfaces.

| Type | Color | Hex |
|---|---|---|
| Run | Vermillion | `#D55E00` |
| Ride | Blue | `#0072B2` |
| Walk | Bluish green | `#009E73` |
| Hike | Orange | `#E69F00` |
| Swim | Sky blue | `#56B4E9` |
| Other | Neutral gray | `#8A8D99` |

Reference: https://jfly.uni-koeln.de/color/

## Component pass

- **Buttons** — three variants instead of seven-plus ad hoc classes:
  - **Primary** — solid accent fill (`.go-btn.ready`, `.upload-choose-btn`)
  - **Secondary** — outlined, neutral (`.tl-btn`, `.bs-btn-secondary`, `.dup-btn-review`)
  - **Ghost** — text-only (`.bs-btn-ghost`, close buttons)
- **Tabs** — pill style everywhere (explore panel tabs now match the top nav's pills; previously underline-only)
- **Cards** — elevation tokens (`--surface-raised` on `--surface`, thin `--border`) instead of heavy shadow + thick borders
- **Typography** — reduced to 3 display sizes (`--fz-display-1/2/3`), relies on the shared system's 2 body sizes, and 1 label size (`--fz-label: 10px`) replacing the previously scattered 9–11px micro-label sizes
