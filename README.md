# Lintel

Lintel is a desktop app for reading and editing Markdown files, for macOS, Windows and
Linux. Each file opens in a tab, which you can show as the raw Markdown, the rendered page,
or both side by side.

## Install

Download the installer for your system from the
[Releases page](https://github.com/robgaskell/lintel/releases).

Lintel's installers are not signed by Apple or Microsoft, so the first time you open
Lintel your system warns you. The steps below get past that warning once.

### macOS (Apple silicon and Intel)

1. Open the `.dmg` file and drag Lintel to your Applications folder.
2. Open Lintel. macOS says it cannot check Lintel. Close that message.
3. Open **System Settings > Privacy & Security**. Near the bottom, next to the message
   about Lintel, click **Open Anyway**, then confirm.

### Windows 10 and 11 (x64)

1. Run the `.exe` installer.
2. If Windows shows "Windows protected your PC", click **More info**, then **Run anyway**.

The installer adds Lintel to **Open with** for `.md` and `.markdown` files. It does not
change the app those files open with by default.

### Linux (x64 and arm64)

Download the `.deb` (for Ubuntu, Debian and similar) or the `.rpm` (for Fedora and
similar) that matches your computer: `amd64` or `x86_64` for Intel and AMD, `arm64` or
`aarch64` for ARM. Then install it from the folder you downloaded it to:

```sh
sudo apt install ./Lintel_*_amd64.deb       # Intel or AMD
sudo apt install ./Lintel_*_arm64.deb       # ARM
# or
sudo dnf install ./Lintel-*.x86_64.rpm      # Intel or AMD
sudo dnf install ./Lintel-*.aarch64.rpm     # ARM
```

The packages are built on Ubuntu 22.04.

## The `lintel` command

`lintel notes.md` opens `notes.md` in Lintel from a terminal. If Lintel is already
running, the file opens in a new tab.

To add the command on any system, open Lintel's Settings, go to **Files**, and choose
**Install command-line tool**. If the folder it uses is not on your PATH, Lintel says so.
The command returns to the prompt at once, and closing the terminal leaves Lintel open.

On Linux the package also puts the program itself at `/usr/bin/lintel`. Running that from
a terminal keeps Lintel attached to it: closing the terminal closes Lintel without asking
about unsaved changes. Use the installed command instead.

## Updates

Lintel checks github.com for a new version 10 seconds after it starts and then once a day,
and downloads it in the background. When an update is ready, the status bar shows
**Update ready: restart**. Lintel asks about unsaved changes before it installs.

To stop these checks, open Lintel's Settings, go to **Updates**, and turn off **Check for
updates automatically**. **Check now** still checks when you ask. Lintel makes no other
network requests, except for web images you choose to load.

## Known issues

See [docs/known-issues.md](docs/known-issues.md).

## Support Lintel

Lintel is free. If it helps you, you can leave a tip on [Ko-fi](https://ko-fi.com/robgaskell).
Tips go first towards Apple's yearly fee to sign the Mac app, so it opens without a warning.

## Releasing

Maintainers: see [docs/releasing.md](docs/releasing.md).

## Licence

Lintel is released under the MIT licence. The licences of the software it includes are in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
