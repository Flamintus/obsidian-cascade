# Cascade

Indents content under each heading, draws a vertical guide per level, and numbers headings automatically — so a long note reads like the outline it already is.

Works in **Reading view** (including PDF export) and in **Editing view** (Live Preview and Source), each enabled and tuned independently.

<!-- Add a screenshot before submitting: ![Cascade](docs/screenshot.png) -->

## Features

Three functions, each of which can be turned on or off on its own:

- **Indentation** — content sitting under a heading is indented one step per heading level.
- **Vertical guides** — one bar per open parent level, matching the guides Obsidian already draws for nested lists.
- **Automatic numbering** — headings are numbered `1`, `1.1`, `1.1.1`, with a configurable starting level.

## How it works

Levels and numbers are read from the **Markdown source**, never inferred from the rendered DOM. Both views call the same `buildHeadingMap` function on the same text, so they cannot drift apart.

This is also what makes the result immune to virtualization, which both views use. Walking the DOM would lose the heading that serves as the anchor, and CSS counters would restart from zero while scrolling.

The JavaScript only sets `data-hib-*` attributes. All rendering lives in `styles.css`, so the look can be overridden from a theme or a CSS snippet.

Applied depth:

| Element | Depth |
| --- | --- |
| Heading line of level N | N−1 steps |
| Content under a heading of level N | N steps |
| Anything before the first heading | 0 |

## Settings

Each mode — Reading and Editing — carries its own copy of these.

| Setting | Default | Effect |
| --- | --- | --- |
| Step | 40 px | Indentation added per level |
| Bar width | 1 px | Thickness of the vertical guide |
| Bar color | theme border | Any CSS color; empty follows the theme |
| Bleed | auto | How far the guide extends past the block |
| Heading bleed | auto | Same, above a heading line |
| Numbering | on | Automatic heading numbers |
| Numbering start | 2 | Heading level that carries the first rank |
| Number gap | 8 px | Space between the number and the heading text |

Editing view only, since Reading view already renders lists as blocks:

| Setting | Default | Effect |
| --- | --- | --- |
| List indent | auto | Bullet position |
| List spacing | auto | Space between list items |
| List hanging | auto | Bullet hanging offset |

Reading view only, since Editing view already handles both cases:

| Setting | Default | Effect |
| --- | --- | --- |
| First heading space | auto | Space above the first heading |
| Table space | auto | Space around tables |

Empty means automatic: the value is derived from the active theme's own spacing variables.

## Installation

### Community plugins

Not yet listed. Once accepted: **Settings → Community plugins → Browse → Cascade**.

### BRAT

Install the *BRAT* plugin, then **Add beta plugin** with this repository. BRAT keeps it updated from GitHub releases.

### Manual

Download `main.js`, `manifest.json` and `styles.css` from the latest release into `<vault>/.obsidian/plugins/cascade/`, then reload Obsidian and enable the plugin.

## License

MIT — see [LICENSE](LICENSE).
