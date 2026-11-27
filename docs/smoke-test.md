# Smoke test: Windows and Linux

Run once on Windows and on Ubuntu 24.04 (arm64) with an installed build. macOS is checked
in each step as it is built. Mark each line pass or fail, and note what happened on a fail.

## Opening files (M5.1)

- [ ] Windows and Linux: with Lintel running, `lintel <file>.md` from a terminal adds a tab and the terminal keeps focus. Double-clicking a .md file opens it in Lintel.
- [ ] Windows, `.exe` installer: give `.md` files another default app (for example Notepad), then install Lintel. Double-clicking a .md file still opens Notepad, and right-click > **Open with** lists Lintel. Opening with Lintel adds a tab. (So the double-click line above is checked with Lintel chosen as the default.)
- [ ] Windows, `.exe` installer: uninstall Lintel. `.md` files still open with Notepad, and **Open with** no longer lists Lintel.
- [ ] Windows and Linux: `lintel missing.md notes.bin` from a terminal shows no dialog. The window's status bar says "Could not open 2 files: missing.md, notes.bin", and hovering over it shows why.
- [ ] Windows and Linux: `lintel <folder>` opens nothing and shows no message.

## Command-line tool and default app (M5.2)

- [ ] Windows: Install command-line tool, then `lintel x.md` in a new terminal works. Make default opens the Default apps settings page.
- [ ] Linux: Install command-line tool works. After Make default, `xdg-mime query default text/markdown` prints `lintel.desktop`.

## Printing (M7.1)

- [ ] Windows and Linux: File > Print opens a dialog and prints a page. Note any failure in docs/known-issues.md.
- [ ] Windows and Linux: File > Export as PDF shows a hint, then the print dialog. The hint names the dialog's PDF option (Windows: "Microsoft Print to PDF"; Linux: "Print to File", then PDF), and choosing it saves a PDF. Note any other wording.
- [ ] Windows: press Ctrl+P with a document open. Note whether Lintel's print of the document opens or WebView2's print of the app window, and correct the Ctrl+P entry in docs/known-issues.md to match. If a printed page shows `tauri.localhost`, check that turning off headers and footers removes it.
