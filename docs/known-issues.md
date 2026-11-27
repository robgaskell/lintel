# Known issues

## Windows: the .msi installer makes Lintel the default app for .md files

The `.exe` installer adds Lintel to **Open with** for `.md` and `.markdown` files and keeps
the app they opened with before. The `.msi` installer, built by Tauri (tauri-bundler
2.10.6), cannot do that: it makes Lintel their default app.

## Windows: after uninstalling, .md files may open with nothing

After Lintel has updated itself, uninstalling it may leave `.md` and `.markdown` files
linked to Lintel's file type, which the uninstaller has removed. If they then open with
nothing, choose their app again in **Windows Settings > Apps > Default apps**.
