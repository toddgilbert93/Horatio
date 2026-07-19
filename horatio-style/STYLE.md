# Horatio — Design Style Package

Classical presence, digital craft. A low-poly Shakespearean bust on deep forest green; parchment light against near-black ink. Built for an Electron desktop app.

---

## Vision

Horatio should feel like a quiet study: scholarly, deliberate, slightly theatrical — never corporate SaaS, never neon terminal chic. The brand mark (faceted bust) carries history; the UI stays calm enough that memory, sessions, and Blender work remain the focus.

**Mood:** archival · precise · warm dark · literary  
**Avoid:** purple gradients, glassmorphism glow, generic Inter UI, busy card grids, emoji ornament

---

## Color tokens

| Token | Hex | Role |
| --- | --- | --- |
| `--color-lightest` | `#FBF9F6` | Off-white surfaces, primary text on dark, bust tone |
| `--color-light-accent` | `#E3D7C5` | Borders, muted text, secondary fills, hairline rules |
| `--color-dark-accent` | `#30372E` | Elevated panels, sidebar/chrome, bust icon background |
| `--color-dark` | `#041300` | Deepest background, primary ink, dark glyph fill |

### Usage map

| Surface | Background | Foreground | Accent / rule |
| --- | --- | --- | --- |
| App shell (default) | `--color-dark` | `--color-lightest` | `--color-dark-accent` |
| Elevated panel / sidebar | `--color-dark-accent` | `--color-lightest` | `--color-light-accent` |
| Light sheet / modal / prefs | `--color-lightest` | `--color-dark` | `--color-light-accent` |
| Selected / emphasis | `--color-dark-accent` | `--color-light-accent` | — |

### CSS variables

```css
:root {
  --color-lightest: #fbf9f6;
  --color-light-accent: #e3d7c5;
  --color-dark-accent: #30372e;
  --color-dark: #041300;

  --font-display: "Jacquard 12", serif;
  --font-body: "Montaga", serif;

  --radius-none: 0;
  --radius-sm: 2px;
  --radius-md: 4px;
}
```

Keep radii tight. Prefer hairlines (`1px` `--color-light-accent` at ~40–60% opacity on dark) over heavy borders or shadows.

---

## Typography

| Role | Family | Source | Use |
| --- | --- | --- | --- |
| Display / stylized | **Jacquard 12** | [Google Fonts](https://fonts.google.com/specimen/Jacquard+12) | App name, section titles, empty states, About |
| Body / UI | **Montaga** | [Google Fonts](https://fonts.google.com/specimen/Montaga) | Labels, lists, notes, forms, chrome |

### Load (Electron / web)

```html
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link
  href="https://fonts.googleapis.com/css2?family=Jacquard+12&family=Montaga&display=swap"
  rel="stylesheet"
/>
```

For offline Electron builds, bundle `.woff2` files under `assets/fonts/` and `@font-face` locally — do not rely on network at runtime.

### Scale (suggested)

| Token | Size | Weight | Family |
| --- | --- | --- | --- |
| `--type-brand` | 28–40px | 400 | Jacquard 12 |
| `--type-title` | 20–24px | 400 | Jacquard 12 |
| `--type-body` | 14–16px | 400 | Montaga |
| `--type-ui` | 12–13px | 400 | Montaga |
| `--type-meta` | 11px | 400 | Montaga |

Letter-spacing: slightly open on Jacquard display (±0.02em). Body stays natural.

---

## 3D bust (in-app)

Live spinning mark for Electron / React hosts. Tuned for **≤300×300px**. Lives in [`export/`](./export/).

| File | Role |
| --- | --- |
| [`export/bust1.glb`](./export/bust1.glb) | Model (~2.4 MB) |
| [`export/BustViewer.tsx`](./export/BustViewer.tsx) | Canvas wrapper — drop-in component |
| [`export/Bust.tsx`](./export/Bust.tsx) | Mesh + Y-axis rotation |
| [`export/materials.ts`](./export/materials.ts) | `plaster` \| `bone` (default) \| `bronze` |
| [`export/index.ts`](./export/index.ts) | Public exports |

**Peers:** `three`, `@react-three/fiber`, `@react-three/drei` (React 18+)

```tsx
import { BustViewer } from './export'

<div style={{ width: 200, height: 200 }}>
  <BustViewer rotating={isActive} materialId="bone" />
</div>
```

| Prop | Default | Notes |
| --- | --- | --- |
| `rotating` | `true` | Gate with an app event when ready |
| `speed` | `0.35` | Y-axis radians / second |
| `materialId` | `'bone'` | Bone uses light accent `#E3D7C5` |
| `modelUrl` | bundled GLB | Override if served elsewhere |

Canvas background is `--color-dark` (`#041300`). Prefer this over the static PNG for splash, About, idle/empty states — keep the PNG for Dock / OS icons.

---

## Brand marks

### Primary — Bust icon

| File | Notes |
| --- | --- |
| [`big-icon.png`](./big-icon.png) | Master, 720×720. Low-poly classical bust on `--color-dark-accent` green. |
| [`assets/brand/bust-icon.png`](./assets/brand/bust-icon.png) | Same master, package path. |

**Use for:** macOS Dock / Windows taskbar / Linux launcher, About dialog, splash / first-run, marketing.

**Do not:** crop tightly (leave breathing room), place on busy photos, tint the bust green, or overlay badges/stickers on the icon.

### Secondary — Stylized H

| File | Fill | Use |
| --- | --- | --- |
| [`tiny-icon.svg`](./tiny-icon.svg) | `#FFFFFF` | Master white glyph (transparent). |
| [`assets/brand/h-mark.svg`](./assets/brand/h-mark.svg) | `#FFFFFF` | Package copy of master. |
| [`assets/tray/h-mark.svg`](./assets/tray/h-mark.svg) | `#FFFFFF` | Tray / menu bar (macOS template-style). |
| [`assets/tray/h-mark-dark.svg`](./assets/tray/h-mark-dark.svg) | `#041300` | Light chrome, light sheets. |
| [`assets/tray/h-mark-accent.svg`](./assets/tray/h-mark-accent.svg) | `#E3D7C5` | Dark panels, subtle in-app mark. |

**Use for:** system tray, window chrome, compact nav, favicon-scale UI. Prefer SVG; keep 1:1 box.

---

## Electron asset kit

### App icon sizes

Hand-authored PNGs under [`assets/app-icon/`](./assets/app-icon/).

**Rule:** bust mark at **≥128px**; stylized **H** at **&lt;128px** (bust reads poorly at tray/favicon scale).

| File | Size | Mark |
| --- | --- | --- |
| `icon-16.png` | 16 | H |
| `icon-32.png` | 32 | H |
| `icon-64.png` | 64 | H |
| `icon-128.png` | 128 | Bust |
| `icon-256.png` | 256 | Bust |
| `icon-512.png` | 512 | Bust |
| `icon.png` | 1024 | Bust — electron-builder / forge default source (copy of `icon-1024.png`) |
| `icon-1024.png` | 1024 | Bust |

**Packaging**

- **macOS:** build `.icns` from these PNGs (`iconutil` or electron-builder `icon`).
- **Windows:** build `.ico` multi-size (16 / 32 / 48 / 256) — mix H + bust per size rule.
- **Linux:** ship `icon-512.png` (or set of PNGs) for `.desktop`.

### Still needed (build step)

| Asset | Why |
| --- | --- |
| `icon.icns` | macOS app bundle — generated from `assets/app-icon/` via `iconutil`, lives at `desktop/build/icon.icns` |
| `icon.ico` | Windows installer / exe |
| Tray Template PNGs @1x/@2x | Optional: use H mark as `iconTemplate.png` + `@2x` for native macOS menu bar tinting |
| Bundled font files | Jacquard 12 + Montaga `.woff2` for offline Electron |

---

## UI principles (desktop)

1. **One job per region** — session list, timeline, notes, artifacts stay distinct; no dashboard soup.
2. **Brand in chrome, not decoration** — product name in Jacquard where the window introduces itself; bust only at app-icon / About scale.
3. **Atmosphere from palette, not texture spam** — dark shell + parchment accents; skip noise overlays.
4. **Motion: sparse** — soft fade/slide on session change or panel reveal (2–3 intentional motions max).
5. **Native where it helps** — macOS Preferences (⌘,), standard menus; custom UI for the memory/timeline surface only.

---

## Folder map

```
horatio-style/
├── STYLE.md                 ← this file
├── big-icon.png             ← bust master (source drop-in)
├── tiny-icon.svg            ← H master (source drop-in)
├── export/                  ← spinning 3D bust (R3F)
│   ├── BustViewer.tsx
│   ├── Bust.tsx
│   ├── materials.ts
│   ├── bust1.glb
│   └── index.ts
└── assets/
    ├── brand/
    │   ├── bust-icon.png
    │   └── h-mark.svg
    ├── app-icon/            ← sized PNGs for Electron packaging
    │   ├── icon.png
    │   └── icon-{16…1024}.png
    └── tray/
        ├── h-mark.svg
        ├── h-mark-dark.svg
        └── h-mark-accent.svg
```

---

## Quick reference

```
#FBF9F6  lightest
#E3D7C5  light accent
#30372E  dark accent
#041300  dark

Display  Jacquard 12
Body     Montaga
```
