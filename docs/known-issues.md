# Known issues

## Windows: the installer makes Lintel the default app for .md files

The Windows installers register Lintel for `.md` and `.markdown` by setting it as the
default handler, not only as an "Open with" choice. The
installers built by Tauri (tauri-bundler 2.10.6) offer no way to do the second without the
first. Uninstalling with the `.exe` installer's uninstaller puts back the handler it
replaced.

To pick another app: right-click a .md file, choose **Open with > Choose another app**,
select the app and tick **Always use this app**.
