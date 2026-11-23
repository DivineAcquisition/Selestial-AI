# Layout

How every signed-in page is framed, so the sidebar, header, toolbars, forms, popups, save bars and the
team console never get in each other's way. The numbers live once, in `src/app/globals.css` ("Application
layout" and "Overlay layers"); the pieces that use them live in `src/components/app/layout.tsx`.

Added November 21, 2026, with the layout refinement pass.

## 1. The frame

| Part | Where it is set | Notes |
|---|---|---|
| Sidebar width | `--app-sidebar-width` (17rem) | Fixed beside the page from 1024px; a drawer below that. |
| Header height | `--app-header-height` (3.5rem) | The header and any support banner sit in one sticky block. |
| Header + banner | `--app-chrome-height` | Measured by the shell from what is on screen. |
| Page toolbar | `--app-toolbar-height` | Reported by a page's own sticky toolbar (`useStickyToolbar`), 0 otherwise. |
| Sticky offset | `--app-sticky-top`, `top-app-sticky` | Chrome + toolbar + 1rem. Every sticky inspector uses it. |
| Page gutters | `--app-gutter`, `px-app-gutter`, `-mx-app-gutter` | 0.75rem on a phone, 1.5rem from 640px. A full-bleed bar breaks out with `-mx-app-gutter`, never a guessed `-mx-4`. |
| Content widths | `--app-width-focused` / `-detail` / `-wide` | 52rem, 72rem, 93.75rem. |
| Bottom bar | `--app-bottom-bar` | Height of a bar fixed to the bottom (`useBottomBar`). The page keeps that much room under its last row. |
| Console lift | `--app-dock-lift` | How much of the bottom a sticky bar covers right now (`useDockLift`, `StickyBar`). The console rises above it. |
| Console clearance | `--app-dock-clearance` | Room under every page's last row so the console never sits on it. |
| Chat panel | `--app-panel-width` | Width of the chat panel while open. From 1280px the page makes room for it instead of sitting under it. |

The page (`<main>`) is a size container named `main`. **A layout chooses its columns from the room left
after the sidebar and any open panel, not from the screen width**: use `@4xl/main:grid-cols-…`, not
`lg:grid-cols-…`, for a page's own columns. At a 1024px screen the sidebar has already taken 272px, so a
viewport `lg:` breakpoint gave a three-column builder about 180px for its form; a container query keeps it
in one column until it has room.

Rough guide, by what a layout needs:

| Layout | Columns from |
|---|---|
| Two proportional columns (2fr / 3fr) | `@3xl/main` (48rem) |
| Main area + 20–22rem inspector | `@4xl/main` (56rem) |
| Steps rail + main + inspector | `@5xl/main` (64rem), wider rails at `@6xl` / `@7xl` |

## 2. Four page layouts

| Layout | Use | How |
|---|---|---|
| Focused form | Settings, guided setup | `Page width="focused"`, or the Settings frame |
| Wide workspace | Tables, schedules, boards, pipelines | `Page width="wide"` (the default) |
| Main + inspector | Builders, the booking workspace | `WithInspector`, or a grid with an `@4xl/main` inspector column that sticks at `top-app-sticky` and scrolls on its own (`max-h-app-sticky`) |
| Detail view | A client, cleaner, property, agreement | `Page width="detail"` |

A page never adds its own gutters or a second maximum width inside another one: the shell provides both.

**Settings** puts its menu beside the form only from `@4xl/main`; below that it is one compact bar with
the full menu in a sheet. At a 1024px screen the form now has the full width instead of about 420px.

## 3. Page headers and tabs

`PageHeader` (in `layout.tsx`; `shell.tsx` re-exports it with the usual space beneath) puts the title and
description at the same starting point on every page. Actions go **secondary first, primary last**, so
the primary action is always at the end of the row. On a narrow page the actions drop below the title
and wrap in the same order. An eyebrow or breadcrumbs sit above the title.

`PageTabs` is a workspace's tab strip (Services & Pricing, Agreements). When the tabs do not fit, the
strip scrolls sideways inside itself; the page never grows wider. The open tab is scrolled into view.

## 4. Forms

`Field` has three parts: the label, the control, and the words beneath (error, hint, aside). The words sit
outside the label, so they are announced as the field's description, not as part of its name.

In a grid made only of fields, the fields share rows (CSS subgrid): a label that wraps onto two lines, or a
hint under one field, never pushes a neighbour's control out of line. Nothing to opt into; a grid with
anything else in it is left alone. Group related fields in one grid: date / start / end, city / state /
postal code (city wider), price / unit, quantity / measure. Long text (scope, instructions, addresses)
gets the full width of its column.

A control never forces its column wider than the grid gave it: the searchable select's input is
`w-0 flex-1`, so a narrow column holds it.

## 5. Overlay layers

One scale, lowest first. A collision is fixed by choosing the right layer, never by a bigger number.

| Utility | z | For |
|---|---|---|
| `z-raised` | 10 | Sticky within a section: a table header, a composer |
| `z-sticky` | 20 | A page's sticky toolbar, save bar or step footer |
| `z-header` | 30 | The application header (and banner) |
| `z-floating` | 40 | The team console; bars fixed to the bottom |
| `z-panel` | 45 | The chat panel beside the page (not modal) |
| `z-modal` | 50 | Dialogs, sheets, drawers and their backdrop |
| `z-popover` | 60 | Select lists, menus, popovers, suggestions: above a modal, so they work inside one |
| `z-alert` | 70 | A confirmation that interrupts everything |

With a dialog or sheet open, the console, chat panel and header are all beneath its backdrop, so nothing
behind it stays clickable.

Portaled popups (Select, SearchableSelect, menus, popovers) are placed by their positioner with
`overlayCollisionPadding()`: 12px from the screen's edges and clear of the sticky header, so a list that
opens upward never hides the header. Inline suggestion lists that must stay inside a dialog's interaction
(address search, list input) use `usePlacement`: they open below or above their field, whichever has room
within the screen and the nearest clipping container, and cap their height to fit.

## 6. Bottom of the screen

- A **bar fixed to the bottom** (the booking summary on a phone) starts where the sidebar ends
  (`left-app-content`), stops at an open chat panel (`right-app-content`), pads for the phone's home
  indicator, and reports its height with `useBottomBar`. The page keeps that room under its last row, and
  focused fields are scrolled clear of it (`scroll-padding-bottom`).
- A **sticky action bar** (`StickyBar`: save bars, review rows, step footers, the Chat composer) stays in
  the page's flow. While it is in use it lifts the console above it, measured from where the bar really
  sits, so neither covers the other at any scroll position.
- A **page toolbar** (the booking workspace's top bar) sticks under the header only on a page at least
  36rem wide and a screen at least 36rem tall (`tall:` variant). On a phone, or at 200% zoom, it scrolls
  away so it never takes a quarter of the screen.

## 7. The sidebar's rows

Every row sits on the same columns: 8px, a 24px mark (icon or avatar), 10px, the name (with its status
beneath it), then a trailing badge or the 32px arrow. Icons, avatars, names and arrows line up across all
three departments and the company sections. A work tab sits on a guide line through the middle of the
mark column, and its name starts where an agent's name starts.

- The open page is filled (`aria-current="page"`); an active work tab is also marked on the guide line.
- An agent whose tab is open shows its name in bold, without a fill: that is "contains the open page",
  not "is the open page".
- An open group shows only its turned arrow (`aria-expanded`). Opening a group never navigates, and
  following a link never opens or closes a group.
- A status goes beneath the name, so a long status ("Waiting on replies", "1234 unfilled") never pushes
  the arrow out of line. It is cut short on screen if it must be, with the whole label in its tooltip and
  its accessible name.
- An agent that is not released has no arrow unless one of its tabs really exists (`disclosedTabs`).
- The open page's link is scrolled into view when the page changes, only if it is out of view.
- Settings is pinned below the scrolling list.
