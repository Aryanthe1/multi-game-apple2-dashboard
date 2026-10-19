---
name: Cathode Indie Terminal
colors:
  surface: '#0c150d'
  surface-dim: '#0c150d'
  surface-bright: '#323c32'
  surface-container-lowest: '#071009'
  surface-container-low: '#151e15'
  surface-container: '#192219'
  surface-container-high: '#232c23'
  surface-container-highest: '#2d372e'
  on-surface: '#dbe6d8'
  on-surface-variant: '#bacbb5'
  inverse-surface: '#dbe6d8'
  inverse-on-surface: '#293329'
  outline: '#859581'
  outline-variant: '#3b4b3a'
  surface-tint: '#00e554'
  primary: '#f1ffeb'
  on-primary: '#00390e'
  primary-container: '#33ff66'
  on-primary-container: '#007225'
  inverse-primary: '#006e24'
  secondary: '#d3fbff'
  on-secondary: '#00363a'
  secondary-container: '#00eefc'
  on-secondary-container: '#00686f'
  tertiary: '#fffaf9'
  on-tertiary: '#670020'
  tertiary-container: '#ffd4d7'
  on-tertiary-container: '#c40044'
  error: '#ffb4ab'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#6dff7f'
  primary-fixed-dim: '#00e554'
  on-primary-fixed: '#002106'
  on-primary-fixed-variant: '#005319'
  secondary-fixed: '#7df4ff'
  secondary-fixed-dim: '#00dbe9'
  on-secondary-fixed: '#002022'
  on-secondary-fixed-variant: '#004f54'
  tertiary-fixed: '#ffd9dc'
  tertiary-fixed-dim: '#ffb2ba'
  on-tertiary-fixed: '#400011'
  on-tertiary-fixed-variant: '#910030'
  background: '#0c150d'
  on-background: '#dbe6d8'
  surface-variant: '#2d372e'
typography:
  headline-lg:
    fontFamily: Space Mono
    fontSize: 32px
    fontWeight: '700'
    lineHeight: 40px
    letterSpacing: 0.05em
  headline-lg-mobile:
    fontFamily: Space Mono
    fontSize: 24px
    fontWeight: '700'
    lineHeight: 32px
    letterSpacing: 0.04em
  headline-md:
    fontFamily: Space Mono
    fontSize: 22px
    fontWeight: '700'
    lineHeight: 30px
    letterSpacing: 0.03em
  headline-sm:
    fontFamily: Space Mono
    fontSize: 18px
    fontWeight: '700'
    lineHeight: 26px
    letterSpacing: 0.02em
  title-lg:
    fontFamily: Space Mono
    fontSize: 16px
    fontWeight: '700'
    lineHeight: 24px
    letterSpacing: 0.02em
  title-md:
    fontFamily: Space Mono
    fontSize: 14px
    fontWeight: '700'
    lineHeight: 20px
    letterSpacing: 0.01em
  title-sm:
    fontFamily: Space Mono
    fontSize: 12px
    fontWeight: '700'
    lineHeight: 18px
    letterSpacing: 0.02em
  body-lg:
    fontFamily: Space Mono
    fontSize: 15px
    fontWeight: '400'
    lineHeight: 24px
    letterSpacing: 0.01em
  body-md:
    fontFamily: Space Mono
    fontSize: 13px
    fontWeight: '400'
    lineHeight: 20px
    letterSpacing: 0.01em
  body-sm:
    fontFamily: Space Mono
    fontSize: 11px
    fontWeight: '400'
    lineHeight: 16px
    letterSpacing: 0.01em
  label-lg:
    fontFamily: Space Mono
    fontSize: 13px
    fontWeight: '700'
    lineHeight: 18px
    letterSpacing: 0.08em
  label-md:
    fontFamily: Space Mono
    fontSize: 11px
    fontWeight: '700'
    lineHeight: 16px
    letterSpacing: 0.08em
  label-sm:
    fontFamily: Space Mono
    fontSize: 9px
    fontWeight: '700'
    lineHeight: 12px
    letterSpacing: 0.1em
spacing:
  gutter: 1rem
  gutter-sm: 0.5rem
  gutter-lg: 1.5rem
  margin: 1.5rem
  margin-mobile: 0.75rem
  margin-desktop: 2rem
  space-xs: 0.25rem
  space-sm: 0.5rem
  space-md: 1rem
  space-lg: 1.5rem
  space-xl: 2rem
---

## Brand & Style

This design system blends 1980s monochrome Apple II green-screen computing with vibrant, high-saturation indie arcade aesthetics. It pairs raw command-line utility with hyper-charged chromatic accents.

### Target Audience & Feel
- **Audience:** Retro-enthusiast developers, indie game modders, demoscene hackers, and cyber-nostalgic creators who value high-density information displays paired with tactile visual feedback.
- **Emotional Response:** Intense technical focus, the tactile buzz of a humming CRT monitor, terminal authority, and the rewarding visual burst of arcade achievement badges.

### Visual Movement
- **Phosphor Brutalism meets Neo-Arcade:** Monospaced structural grids, strictly hard-edged framing, and scanline shaders provide the underlying mechanical architecture. Modern high-octane indie neon highlights punctuate the deep, pitch-black raster field.
- **Surface Reality:** Monochromatic green persistence phosphor establishes hierarchy, while micro-accents in vivid candy tones indicate runtime states, critical alerts, and unlocked artifacts.

## Colors

The palette establishes high contrast between deep cathode ray tube blacks, radiant green phosphor, and saturated arcade accent tones.

### Palette Architecture
- **Phosphor Green Base:**
  - `primary` (`#33FF66`): The standard terminal phosphor output. Used for active text, essential borders, and dynamic telemetry.
  - `primary-dim` (`#22AA44`): Phosphor persistence decay. Used for secondary labels, inactive borders, and structural framing.
  - `primary-dark` (`#001100`): Deep cathode glow tint, used for focused containers and table alternating stripes.
- **Indie Arcade Accents:**
  - `secondary` (`#00F0FF` / Electric Cyan): System input, cursor heads, and command feedback.
  - `tertiary` (`#FF3366` / Candy Pink): Error strikes, vital drops, and killswitch toggles.
  - `warning` (`#FFB000` / CRT Amber): Warm phosphor fallback, memory leaks, and pending inputs.
  - `hyper-accent-lemon` (`#FFDD00`): Score multipliers and rare inventory items.
  - `hyper-accent-violet` (`#7B2CBF`): Sub-level architecture and esoteric state badges.
- **Raster Neutrals:**
  - `neutral` (`#050D06`): True screen-off CRT obsidian substrate.
  - `neutral-dark` (`#020703`): Background void behind scanlines.
  - `neutral-surface` (`#08180A`): Elevated sub-terminal panels.

### Contrast Enforcement
All interactive foreground items must maintain a minimum 7:1 contrast ratio against `#050D06`. Saturated indie colors must be reserved for micro-accents, chips, badges, and status lights rather than continuous body reading.

## Typography

The typography uses `Space Mono` across all tiers to simulate unyielding terminal matrix controllers.

### Text Behavior & Case Rules
- **Headline & Titles:** Always displayed in full uppercase (`text-transform: uppercase`) to reinforce command-interpreter conventions.
- **Labels & Badges:** Micro sizes require high letter-spacing (`0.08em` to `0.1em`) to remain crisp through raster scanline overlays.
- **Terminal Glyphs:** Characters such as `>`, `$`, `_`, and `■` serve as structural text ornaments across listings and system readouts.
- **Text Bloom:** Primary text styles receive a subtle phosphor light leak via `text-shadow: 0 0 6px rgba(51, 255, 102, 0.45)`.

## Layout & Spacing

Layout conforms to an 8px baseline matrix, mirroring rigid monospace terminal column-and-row terminal math.

### Grid Framework
- **Desktop (1200px+):** 12-column layout with 24px (`space-lg`) gutters and 32px (`margin-desktop`) canvas padding.
- **Tablet (768px - 1199px):** 8-column layout with 16px (`space-md`) gutters and 24px canvas padding.
- **Mobile (< 768px):** 4-column layout with 8px (`space-sm`) gutters and 12px (`margin-mobile`) canvas padding.

### Structural Flow
- Interfaces must be structured as docked modules or ASCII-bordered tiles instead of floating freeform panels.
- Screen layouts are contained within an outer frame evoking a 4:3 or 16:10 display aperture, capped with an integrated status header and breadcrumb command tape.

## Elevation & Depth

Depth is not achieved through soft drop shadows. It relies strictly on luminous phosphor bloom, scanlines, and hard-edged 1px ASCII boundary lines.

### Depth Mechanics
- **Ground Floor (Base Canvas):** `#020703` overlayed with a repeated scanline gradient (`repeating-linear-gradient(0deg, rgba(0, 0, 0, 0.4) 0px, rgba(0, 0, 0, 0.4) 1px, transparent 1px, transparent 2px)`).
- **Level 1 (Panels & Frames):** Background `#050D06`, 1px solid border `#22AA44`.
- **Level 2 (Active Modals & Focus Panes):** Background `#08180A`, 1px solid border `#33FF66`, accented by a phosphor outer bloom (`box-shadow: 0 0 12px rgba(51, 255, 102, 0.25)`).
- **Indie Accents (Overlays):** Solid 1px neon borders in Cyan (`#00F0FF`) or Candy Pink (`#FF3366`) paired with dual-layer bloom (`box-shadow: 0 0 6px currentColor, 0 0 16px currentColor`).

## Shapes

The geometry is strictly zero-radius (`0`). Curved corners are forbidden to preserve the raw raster cathode aesthetic.

### Framing Conventions
- All containers use crisp rectangular cuts.
- Secondary frames emulate ASCII box-drawing mechanics (`┌─┐`, `└─┘`, `│`, `─`) via custom pseudo-elements, monospace border glyphs, or crisp 1px borders with decorative notched corners.
- Interactive widgets (buttons, checkboxes, chips) maintain absolute orthogonal corners.

## Components

### Buttons
- **Primary:** Background `#001100`, border `1px solid #33FF66`, text `#33FF66`. Hover swaps to background `#33FF66`, text `#050D06`, with `box-shadow: 0 0 12px #33FF66`.
- **Arcade Variant:** Background `#FF3366`, text `#050D06`, border `1px solid #FF3366`. Hover swaps to transparent background, text `#FF3366`, with candy pink glow.
- **Terminal Utility:** Border `1px solid #22AA44`, background `transparent`, text `#22AA44`. Always prefixed with `[ ` and suffixed with ` ]`.

### Chips & Badges
- **Status Chips:** Solid 1px borders with monospace bracket syntax (e.g., `[SYS:OK]`, `[WARN:HEAT]`).
- **Indie Achievement Badges:** High-saturation fills (`#00F0FF`, `#FFDD00`, `#7B2CBF`) with black text, zero border-radius, and uppercase bold titles.

### Lists & Data Grids
- **Tables:** Monospace character-aligned columns. Headers marked by repeated dashes (`-----------------`).
- **Row Hover:** Entire row background shifts to `#001100` with the lead character transforming into a bright green cursor block (`> `).

### Checkboxes & Radios
- **Checkboxes:** Visual text-render: `[ ]` for unselected, `[X]` for selected, glowing in `#33FF66`.
- **Radios:** Rendered as `( )` for unselected, `(*)` for selected in `#00F0FF`.
- No native OS inputs; inputs rely on custom styled spans matching the monospace font geometry.

### Input Fields
- Single-line and multi-line areas feature a continuous baseline or full 1px `#22AA44` border.
- Active state transitions the border to `#33FF66` with a blinking rectangular block cursor (`2px wide, 1em high, background #33FF66`, animated at 1Hz step-start).
- Prefixed with terminal path indicators (e.g., `A:\> `).

### Cards & Viewports
- Outlined by 1px `#22AA44` or Unicode ASCII style double lines (`╔══╗╚══╝`).
- Header bars display metadata strips: title aligned left, memory addresses (e.g., `0x7FF01`) aligned right.