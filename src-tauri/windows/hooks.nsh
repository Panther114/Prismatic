; Prismatic NSIS hooks — fix taskbar/Start-menu identity and clean Electron residue.
; Uses Tauri symbols: PRODUCTNAME, MAINBINARYNAME, BUNDLEID, INSTDIR, DESKTOP, SMPROGRAMS, etc.

!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "Configuring Windows shortcuts (icon + AppUserModelID)…"

  ; Start Menu: recreate with an explicit icon path so taskbar pins do not get IconLocation ",0"
  ${If} ${FileExists} "$SMPROGRAMS\${PRODUCTNAME}.lnk"
    Delete "$SMPROGRAMS\${PRODUCTNAME}.lnk"
  ${EndIf}
  ${If} ${FileExists} "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
    Delete "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
  ${EndIf}

  CreateShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk" \
    "$INSTDIR\${MAINBINARYNAME}.exe" "" \
    "$INSTDIR\${MAINBINARYNAME}.exe" 0
  !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\${PRODUCTNAME}.lnk"

  ; Desktop shortcut when the finish-page flow (or silent install) created one
  ${If} ${FileExists} "$DESKTOP\${PRODUCTNAME}.lnk"
    Delete "$DESKTOP\${PRODUCTNAME}.lnk"
    CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" \
      "$INSTDIR\${MAINBINARYNAME}.exe" "" \
      "$INSTDIR\${MAINBINARYNAME}.exe" 0
    !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"
  ${EndIf}

  ; Refresh shell icon cache for this install location
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'

  ; --- Electron → Tauri migration residue (safe; does not touch Music/Prismatic) ---
  DetailPrint "Cleaning legacy Electron updater residue…"
  RMDir /r "$LOCALAPPDATA\prismatic-updater"

  ; Stale Electron profile from 1.x (Chromium caches under %APPDATA%\Prismatic).
  ; Only remove known Electron subfolders; never touch the music library.
  ${If} ${FileExists} "$APPDATA\Prismatic\prismatic-desktop.log"
    DetailPrint "Removing legacy Electron app profile under APPDATA\Prismatic…"
    RMDir /r "$APPDATA\Prismatic\Cache"
    RMDir /r "$APPDATA\Prismatic\Code Cache"
    RMDir /r "$APPDATA\Prismatic\GPUCache"
    RMDir /r "$APPDATA\Prismatic\DawnGraphiteCache"
    RMDir /r "$APPDATA\Prismatic\DawnWebGPUCache"
    RMDir /r "$APPDATA\Prismatic\blob_storage"
    RMDir /r "$APPDATA\Prismatic\Service Worker"
    RMDir /r "$APPDATA\Prismatic\Session Storage"
    RMDir /r "$APPDATA\Prismatic\Shared Dictionary"
    RMDir /r "$APPDATA\Prismatic\Network"
    RMDir /r "$APPDATA\Prismatic\Partitions"
    RMDir /r "$APPDATA\Prismatic\WebStorage"
    RMDir /r "$APPDATA\Prismatic\IndexedDB"
    RMDir /r "$APPDATA\Prismatic\Local Storage"
    Delete "$APPDATA\Prismatic\prismatic-desktop.log"
    Delete "$APPDATA\Prismatic\Local State"
    Delete "$APPDATA\Prismatic\Preferences"
    Delete "$APPDATA\Prismatic\DIPS"
    Delete "$APPDATA\Prismatic\SharedStorage"
  ${EndIf}

  ; Old machine-wide Electron install path (if still present and not this INSTDIR)
  ${If} ${FileExists} "$PROGRAMFILES64\Prismatic\Prismatic.exe"
  ${AndIf} "$INSTDIR" != "$PROGRAMFILES64\Prismatic"
    DetailPrint "Found legacy Program Files install; leaving it for the user to uninstall (paths differ)."
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Unpin before files go away so the taskbar does not keep a dead pin
  !insertmacro UnpinShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk"
  !insertmacro UnpinShortcut "$DESKTOP\${PRODUCTNAME}.lnk"
!macroend
