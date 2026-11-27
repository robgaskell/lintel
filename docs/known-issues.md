# Known issues

## Windows: after uninstalling, .md files may open with nothing

After Lintel has updated itself, uninstalling it may leave `.md` and `.markdown` files
linked to Lintel's file type, which the uninstaller has removed. If they then open with
nothing, choose their app again in **Windows Settings > Apps > Default apps**.

## Linux: one file can open in two tabs on a case-insensitive drive

On Linux, a drive that ignores letter case, such as a USB stick formatted as FAT or exFAT,
lets one file be opened as `Notes.md` and as `notes.md`. Lintel then opens it in two tabs,
and saving one can overwrite edits made in the other. Open each file with one spelling.

## Quitting or logging out during an update

While an update installs, Lintel stays open when its last window is closed. It cannot
refuse a quit from the Dock, a log out or a shut down, and on macOS these end the install
part way. Wait for Lintel to relaunch first. If Lintel then does not open, download it
again from the GitHub releases page.

## Saving breaks hard links

Lintel saves by writing a new file and moving it over the old one, so a failed save never
leaves half a file. If the file has hard links, they keep the old text: the save separates
them. Symbolic links are fine, because Lintel saves to the file they point to.

## macOS: File > Open shows Markdown files only

On macOS the Open dialog lists only `.md` and `.markdown` files, because it has no way to
switch to "All files". To open another text file, drop it on the Lintel window.

## macOS: some ways of quitting skip the unsaved changes prompt

Quit from the Dock, logging out, or a script's `quit` command closes Lintel at once, without
asking about unsaved changes, and those changes are lost. Quit from the Lintel menu or with
Cmd+Q to be asked first.

## A damaged settings file is replaced with defaults

If Lintel's `settings.json` cannot be read, Lintel starts with the default settings and
keeps no copy of the damaged file. Settings are also written straight into the file, not
through a temporary file, so a crash while saving them can damage it. Documents are never
affected.

## Linux: "All files" in the Open dialog needs a dot in the name

On Linux the Open dialog's "All files" filter lists only names with a dot in them, such as
`notes.txt`. To open a file such as `README`, drop it on the Lintel window.

## Windows: images and links with a drive letter do not work

Image and link paths that start with a drive letter, such as `C:\pictures\chart.png`, are not
supported. The image shows its alt text and the link does nothing. Use a path relative to
the document instead, such as `pictures/chart.png`.

## Windows: images on network drives do not show

On Windows, Lintel does not read images from network locations, including mapped drives
such as `Z:`. A document stored on a network drive shows its images as alt text. Copy the
document and its images to a local folder to see them.

## Windows: tabs cannot be dragged between groups

On Windows, dragging a tab into another group does not work, because Lintel keeps Windows
file drop turned on so `.md` files can be dropped on the window. To move a tab, use Split
Right or Split Down in the tab's menu or the View menu.

## Open in New Window loses undo history and scroll position

When a tab moves to another window, its text, unsaved changes and cursor line move with it,
but its undo history and scroll position do not. Undo in the new window starts from the move.

## Linux and Windows: some folder changes are noticed late

On Linux, if the folder of an open document is deleted and another program puts it back,
Lintel does not notice until you save that document or open a file from the folder. On
Windows, if the folder of an open document is renamed (and probably if it is moved to the
Recycle Bin), the tab shows "Deleted on disk" only after something else changes in that
folder.

## Lint is off for very large files

Lintel does not lint documents over 1,000,000 bytes (about 1 MB), so typing stays quick. The
status bar then shows no lint count.

## Lint config files Lintel does not read

Lintel reads the nearest `.markdownlint.json`, `.markdownlint.jsonc`, `.markdownlint.yaml`
or `.markdownlint.yml`. It does not read `.markdownlint-cli2.*` files, `.markdownlintrc`,
or `.markdownlint.cjs` and `.mjs` files, which would run code. It also ignores an `extends`
key, which could point anywhere, and the status bar's lint area says so. Lintel can
therefore report different issues from the markdownlint command line on the same files.

## Printing

### Windows: printed pages may show "tauri.localhost"

On Windows the print dialog may add a header and footer with the page's address,
`tauri.localhost`. Turn off the dialog's headers and footers option to remove them. This is
wry issue #1300.

### Linux: printing is not checked yet

File > Print and Export as PDF on Linux use WebKitGTK's print dialog, which has not been
tried yet. The release smoke test checks it.

### Windows: Ctrl+P prints a blank page

On Windows, the WebView2 browser engine has its own Ctrl+P shortcut, and Lintel does not
turn off WebView2's own print shortcut yet. Ctrl+P prints a blank page; use File > Print.
Straight after File > Print, Ctrl+P can print that same document again, until you edit it,
switch tabs, or it reloads from disk.

## Word export

### Journey diagrams may lose their labels

Export as Word draws each Mermaid diagram as a picture. Most diagram types draw their labels
as plain text for this, but journey diagrams still use web-page labels, and their label text
may be missing from the picture in Word.

### Web images show as their alt text

Export as Word never downloads anything. An image from the web, written in Markdown or as
an HTML `<img>`, appears in the Word file as its alt text, not as a picture.

### A diagram's own flowchart settings are ignored

Export as Word draws diagram labels as plain text, and so ignores a diagram's own
`%%{init: ...}%%` settings for labels and for flowcharts (the `flowchart` key). A flowchart
that changes its own layout or curves this way can look different in Word from the preview.

### Links to emoji-only headings stay plain text

In Export as Word, a link to a heading whose text is only emoji or punctuation, such as
`# 🚀`, stays as plain text, because Word names that heading's bookmark differently.

## Exports: some links become plain text

In Export as HTML and Export as Word, a link to a network path (`\\server\share` or
`//server/share`), any `file:` address, or an address that is not `http`, `https` or
`mailto` keeps its text but is no longer a link. On Windows, opening such a link can send
your sign-in details to another computer. Links to other files by relative path stay. An
address with a double quote mark in it, or one that starts with a quote mark, also loses
its link, because Windows ignores the quotes.

### Links with a lone % lose their link

In Export as HTML and Export as Word, a web address with a `%` that is not followed by two
letters or digits of a `%` code, such as `https://example.com/?off=50%`, keeps its text but
is no longer a link. So does an address with `%25`, the code for `%` itself. Lintel cannot
be sure where such an address leads, so it leaves it as text.
