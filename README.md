# Inkbook

Lightweight handwritten notebooks for Obsidian (Apple pencil compatibility)
Everything stored locally and/or in cloud

## Install

1 -  Install BRAT in community plugins on obsidian and enabl
2 - Copy the repository link into BRAT install



## Features

- **New notebook:** pencil icon in the left ribbon, the command "Inkbook: New notebook", or long-press /
  right-click a folder → "New ink notebook". Notebooks are ordinary files, so make a folder per
  subject and as many notebooks as you like.
- **Pencil draws, fingers navigate.** One finger scrolls a zoomed page, two fingers pinch-zoom.
- **Pages:** swipe sideways with a finger to turn pages. On the last page, keep swiping
  (right-to-left, like turning a page forward) until "Release for new page" appears.
- **Settings** (gear button): page style (squared, lined, dotted, blank), grid size, white or cream
  paper, and the pencil options (draw with finger, scribble to erase, hold to straighten).
- **Erase:** scribble back and forth over ink with the pen, or use the eraser tool. The eraser has
  two modes: **Precise** rubs out only the ink under the circle (cutting strokes in two where
  needed); **Stroke** removes every stroke it passes over.
- **Straight lines and circles:** draw, then pause with the pencil still down for a moment (about
  a fifth of a second). Still holding, move the pencil to adjust: a line's end follows it, a circle
  grows or shrinks.
- **Picks up where you left off:** each notebook reopens on the page, zoom and scroll position you
  last had.
- **Lasso:** circle some ink, then drag it to move, or use the popup to copy / cut / duplicate /
  delete. Tap a single stroke, text box or picture to select just that. Corner handles resize, the
  handle on top turns. Paste works on any page or in another notebook. Tapping a colour recolours
  the selection.
- **Text boxes** (T "Add text" tool, last of the tools): tap the page and type; tap a text box to change it. Colour and the three
  text sizes apply while typing. Tap elsewhere or hide the keyboard to finish. Move, resize or turn a
  text box with the lasso; the lasso popup also has **Edit text**.
- **Pictures** (picture button, or paste on desktop): a photo from the camera roll / Files, or a
  picture already in the vault. Camera photos are scaled down to 2000 px and saved as JPEG in your
  attachments folder (usually 200–500 KB each); the notebook only links to them, so keep them in
  the vault. Pictures sit under the ink, so you can write on them.
- **Undo** also covers adding, deleting, moving and importing pages.
- **All pages:** tap the page number (or the grid button next to it) for a thumbnail overview. Tap a
  page to jump to it; drag a page by its ⠿ handle (or hold the page) to move it; tap **Select** to
  pick pages to export as a PDF or delete.
- **Bookmarks:** the bookmark button next to the page number marks the current page (it turns red).
  In All pages, bookmarked pages have a red ribbon — tap any ribbon to add or remove a bookmark —
  and **Bookmarks** shows only those pages.
- **Import a PDF** (⋯ menu): from the vault or from the device (Files app on iPad). Each PDF page
  becomes a notebook page you can write on. On desktop you can also paste a PDF file with Ctrl/Cmd+V.
  PDFs from the device are saved into your attachments folder; the notebook links to them, so keep
  the PDF in the vault.
- **Export** (⋯ menu): whole notebook or chosen pages as PDF (ink stays vector; imported PDF pages
  are embedded at 200 dpi), or the current page as PNG. The file is saved next to the notebook; on
  iPad the share sheet opens too.

Defaults (page style, stabilisation strength, pressure, finger drawing…) are in Settings → Inkbook.

## Testing without Obsidian

`dev/index.html` runs the drawing engine in a normal browser with the Obsidian API stubbed out
(serve the `inkbook` folder with `python -m http.server`). It is not needed for the plugin.
