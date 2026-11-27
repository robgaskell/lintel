# Smoke test: Windows and Linux

Run once, after the v0.1.0 tag, with builds installed from its draft release (see
docs/releasing.md), on:

- Windows 10 or 11 (x64), with the `.exe`
- Ubuntu 24.04 arm64, with the `arm64` `.deb`
- an x64 Linux machine or VM, with the `amd64` `.deb`
- an RPM system such as a Fedora VM, with the `.rpm` for its architecture

"Linux" lines apply to every Linux system above. macOS is checked in each step as it is
built. Mark each line pass or fail, and note what happened on a fail.

## Installing (M8.2)

- [ ] Windows: run the `.exe` installer. If SmartScreen shows "Windows protected your PC", **More info > Run anyway** lets it run, as the README says. Lintel installs and opens.
- [ ] Ubuntu 24.04 arm64: `sudo apt install ./Lintel_*_arm64.deb` installs with no missing packages, and Lintel opens from the app list.
- [ ] Linux, after installing the package and before Install command-line tool: `grep MimeType /usr/share/applications/Lintel.desktop` lists `text/markdown`, and `command -v lintel` prints `/usr/bin/lintel`.
- [ ] x64 Linux: `sudo apt install ./Lintel_*_amd64.deb` installs with no missing packages, and Lintel opens and shows a `.md` file.
- [ ] RPM system: `uname -m` names the architecture. `sudo dnf install ./Lintel-*.aarch64.rpm` (on `aarch64`) or `sudo dnf install ./Lintel-*.x86_64.rpm` (on `x86_64`) installs, and Lintel opens.

## Opening files (M5.1)

- [ ] Windows and Linux: with Lintel running, `lintel <file>.md` from a terminal adds a tab and the terminal keeps focus. Double-clicking a .md file opens it in Lintel.
- [ ] Windows, `.exe` installer: give `.md` files another default app (for example Notepad), then install Lintel. Double-clicking a .md file still opens Notepad, and right-click > **Open with** lists Lintel. Opening with Lintel adds a tab. (So the double-click line above is checked with Lintel chosen as the default.)
- [ ] Windows, `.exe` installer: uninstall Lintel. `.md` files still open with Notepad, and **Open with** no longer lists Lintel.
- [ ] Windows and Linux: `lintel missing.md notes.bin` from a terminal shows no dialog. The window's status bar says "Could not open 2 files: missing.md, notes.bin", and hovering over it shows why.
- [ ] Windows and Linux: `lintel <folder>` opens nothing and shows no message.
- [ ] Windows: open `Notes.md`, then run `lintel notes.md` (the same file in different letter case) from a terminal. Lintel shows one tab for it, not two.

## Command-line tool and default app (M5.2)

- [ ] Windows: Install command-line tool, then `lintel x.md` in a new terminal works. Make default opens the Default apps settings page.
- [ ] Linux: Install command-line tool, then in a new terminal `command -v lintel` prints `~/.local/bin/lintel` (expanded), and `lintel x.md` returns to the prompt at once. Closing that terminal leaves Lintel open.
- [ ] Linux: after Make default, `xdg-mime query default text/markdown` prints `Lintel.desktop`, `ls ~/.local/share/applications/` lists no Lintel entry, and double-clicking a .md file opens it in Lintel.

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

## Keyboard and tabs on Windows (Rulings 62 and 182)

- [ ] Windows, with the cursor in the editor: type a word, wait two seconds, type a second word, then press Ctrl+Z once. Only the second word goes, not both. Ctrl+Shift+Z once brings back only that word.
- [ ] Windows, with the cursor in the editor: Ctrl+S saves, Ctrl+W closes the tab, and Ctrl+Q quits (asking first about unsaved edits).
- [ ] Windows: dropping a `.md` file from Explorer on the window opens it in a tab. Dragging a tab into another group does not work, as docs/known-issues.md says; Split Right and Split Down in the tab's menu and the View menu move the tab instead.
