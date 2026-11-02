!macro NSIS_HOOK_PREINSTALL
  ; Detecta instalaciones Electron anteriores de este producto en el usuario actual.
  ; Solo ejecuta un desinstalador en una carpeta que también contiene app.asar.
  StrCpy $0 0

  legacy_migajas_uninstall_next:
    EnumRegKey $1 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall" $0
    StrCmp $1 "" legacy_migajas_uninstall_done
    IntOp $0 $0 + 1

    ReadRegStr $2 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\$1" "DisplayName"
    StrCpy $3 $2 16
    StrCmp $3 "Migajas Launcher" 0 legacy_migajas_uninstall_next

    ReadRegStr $4 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\$1" "InstallLocation"
    StrCmp $4 "" legacy_migajas_uninstall_next
    IfFileExists "$4\resources\app.asar" 0 legacy_migajas_uninstall_next
    IfFileExists "$4\Migajas Launcher.exe" 0 legacy_migajas_uninstall_next
    IfFileExists "$4\Uninstall Migajas Launcher.exe" 0 legacy_migajas_uninstall_next

    DetailPrint "Eliminando la instalación anterior de Migajas Launcher..."
    ExecWait '"$4\Uninstall Migajas Launcher.exe" /S /KEEP_APP_DATA --updated _?=$4' $5
    IntCmp $5 0 legacy_migajas_uninstall_done
    MessageBox MB_ICONSTOP|MB_OK "No se pudo quitar la instalación anterior de Migajas Launcher (código $5). No se continuará para evitar instalaciones duplicadas."
    Abort

  legacy_migajas_uninstall_done:
!macroend
