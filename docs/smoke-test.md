# Smoke test: Windows and Linux

Run once on Windows and on Ubuntu 24.04 (arm64) with an installed build. macOS is checked
in each step as it is built. Mark each line pass or fail, and note what happened on a fail.

## Opening files (M5.1)

- [ ] Windows and Linux: with Lintel running, `lintel <file>.md` from a terminal adds a tab and the terminal keeps focus. Double-clicking a .md file opens it in Lintel.
- [ ] Windows, `.exe` installer: give `.md` files another default app (for example Notepad), then install Lintel. Double-clicking a .md file still opens Notepad, and right-click > **Open with** lists Lintel. Opening with Lintel adds a tab. (So the double-click line above is checked with Lintel chosen as the default.)
- [ ] Windows, `.exe` installer: uninstall Lintel. `.md` files still open with Notepad, and **Open with** no longer lists Lintel.
- [ ] Windows and Linux: `lintel missing.md notes.bin` from a terminal shows no dialog. The window's status bar says "Could not open 2 files: missing.md, notes.bin", and hovering over it shows why.
- [ ] Windows and Linux: `lintel <folder>` opens nothing and shows no message.
