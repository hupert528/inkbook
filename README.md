# Inkbook

Lightweight handwritten notebooks for Obsidian, built for iPad + Apple Pencil.
One file (`main.js`, about 50 KB), no dependencies, no build step.

## Install

1. In your vault, open the hidden folder `.obsidian/plugins/` (create `plugins` if it is missing).
2. Make a folder called `inkbook` there and copy in **`main.js`**, **`manifest.json`** and **`styles.css`**.
3. In Obsidian: Settings → Community plugins → turn off Restricted mode → enable **Inkbook**.

**Getting it onto the iPad:** if the vault is in iCloud Drive, do the steps above on any device and it
syncs across (on iPad you can also copy the folder with the Files app — show hidden files is not
needed if you paste directly into `.obsidian/plugins`). With Obsidian Sync, enable syncing of
"Installed community plugins" and "All other file types" (notebooks are `.inknote` files).

## Use

- **New notebook:** pencil icon in the left ribbon, the command "Inkbook: New notebook", or long-press /
  right-click a folder → "New ink notebook". Notebooks are ordinary files, so make a folder per
  subject and as many notebooks as you like.
- **Pencil draws, fingers navigate.** One finger scrolls a zoomed page, two fingers pinch-zoom.
- **Pages:** swipe sideways with a finger to turn pages. On the last page, keep swiping
  (right-to-left, like turning a page forward) until "Release for new page" appears.
- **Page style** (grid button): squared, lined, dotted, blank; grid size; white or cream paper.
- **Erase:** scribble back and forth over ink with the pen, or use the eraser tool.
- **Straight lines and circles:** draw, then hold the pencil still for half a second — or use the
  shape pen, which always corrects.
- **Lasso:** circle some ink, then drag it to move, or use the popup to copy / cut / duplicate /
  delete. Paste works on any page or in another notebook. Tapping a colour recolours the selection.
- **Export** (⋯ menu): whole notebook as a vector PDF, or the current page as PNG. The file is saved
  next to the notebook; on iPad the share sheet opens too.

Defaults (page style, stabilisation strength, pressure, finger drawing…) are in Settings → Inkbook.

## Testing without Obsidian

`dev/index.html` runs the drawing engine in a normal browser with the Obsidian API stubbed out
(serve the `inkbook` folder with `python -m http.server`). It is not needed for the plugin.

## Install with BRAT (easiest on iPad)

1. Install the **BRAT** community plugin and enable it.
2. BRAT settings → **Add beta plugin** → paste this repository's URL → Add.
3. Enable **Inkbook** under Community plugins. BRAT keeps it updated from new GitHub releases.

(Each release must have `main.js`, `manifest.json` and `styles.css` attached.)
