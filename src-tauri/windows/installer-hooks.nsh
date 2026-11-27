; Lintel joins "Open with" for markdown files and leaves their default app alone (Ruling 240).
; Tauri's template runs APP_ASSOCIATE first, which makes Lintel.Markdown the default and keeps
; the old default in the "Lintel.Markdown_backup" value. Its uninstaller puts that value back.

!macro LINTEL_OPEN_WITH EXT
  ReadRegStr $R0 SHCTX "Software\Classes\.${EXT}" "Lintel.Markdown_backup"
  ${If} $R0 == ""
    DeleteRegValue SHCTX "Software\Classes\.${EXT}" ""
  ${Else}
    WriteRegStr SHCTX "Software\Classes\.${EXT}" "" "$R0"
  ${EndIf}
  WriteRegStr SHCTX "Software\Classes\.${EXT}\OpenWithProgids" "Lintel.Markdown" ""
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro LINTEL_OPEN_WITH "md"
  !insertmacro LINTEL_OPEN_WITH "markdown"
  ; SHCNE_ASSOCCHANGED, so Explorer reads the change now.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegValue SHCTX "Software\Classes\.md\OpenWithProgids" "Lintel.Markdown"
  DeleteRegValue SHCTX "Software\Classes\.markdown\OpenWithProgids" "Lintel.Markdown"
!macroend
