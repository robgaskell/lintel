# Smoke test: Windows and Linux

Run once on Windows and on Ubuntu 24.04 (arm64) with an installed build. macOS is checked
in each step as it is built. Mark each line pass or fail, and note what happened on a fail.

## Opening files (M5.1)

- [ ] Windows and Linux: with Lintel running, `lintel <file>.md` from a terminal adds a tab and the terminal keeps focus. Double-clicking a .md file opens it in Lintel.
- [ ] Windows, `.exe` installer: give `.md` files another default app (for example Notepad), then install Lintel. Double-clicking a .md file still opens Notepad, and right-click > **Open with** lists Lintel. Opening with Lintel adds a tab. (So the double-click line above is checked with Lintel chosen as the default.)
- [ ] Windows, `.exe` installer: uninstall Lintel. `.md` files still open with Notepad, and **Open with** no longer lists Lintel.
- [ ] Windows and Linux: `lintel missing.md notes.bin` from a terminal shows no dialog. The window's status bar says "Could not open 2 files: missing.md, notes.bin", and hovering over it shows why.
- [ ] Windows and Linux: `lintel <folder>` opens nothing and shows no message.
- [ ] Windows: open `Notes.md`, then run `lintel notes.md` (the same file in different letter case) from a terminal. Lintel shows one tab for it, not two.

## Command-line tool and default app (M5.2)

- [ ] Windows: Install command-line tool, then `lintel x.md` in a new terminal works. Make default opens the Default apps settings page.
- [ ] Linux: Install command-line tool works. After Make default, `xdg-mime query default text/markdown` prints `lintel.desktop`.

## Printing (M7.1)

- [ ] Windows, before any File > Print since Lintel started: open a document and press Ctrl+P. As docs/known-issues.md says, Ctrl+P prints a blank page; use File > Print. Note whether it prints a blank page, the document, or something else.
- [ ] Windows and Linux: File > Print opens a dialog and prints a page. Note any failure in docs/known-issues.md.
- [ ] Windows and Linux: File > Export as PDF shows a hint, then the print dialog. The hint names the dialog's PDF option (Windows: "Microsoft Print to PDF"; Linux: "Print to File", then PDF), and choosing it saves a PDF. Note any other wording.
- [ ] Windows: if a printed page shows `tauri.localhost`, check that turning off headers and footers removes it.

## Unsaved edits (M7.1)

- [ ] Windows: type in a document without saving, then press F5 and then Ctrl+R. The window does not reload, and the unsaved edits are still there.

## HTML export (M7.2)

- [ ] Windows and Linux: File > Export as HTML… offers `<name>.html`. Change the name to one without `.html` and save. Note whether the saved file ends in `.html`; if it does not, add that to docs/known-issues.md.

## Word export (M7.3)

- [ ] Windows and Linux: File > Export as Word… offers `<name>.docx`. Change the name to one without `.docx` and save. Note whether the saved file ends in `.docx`; if it does not, add that to docs/known-issues.md.
- [ ] Windows and Linux: open the exported file in Word (on Linux, LibreOffice). It opens without a repair prompt, and a flowchart shows as a picture with its labels.
