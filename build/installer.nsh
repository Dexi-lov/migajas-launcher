; Se ejecuta al DESINSTALAR. electron-builder también ejecuta el desinstalador viejo al ACTUALIZAR,
; por eso todo va protegido con isUpdated (al actualizar no se debe borrar nada del jugador).
!macro customUnInstall
  ${ifNot} ${isUpdated}
    ; Caché de instaladores que descargó el auto-updater (cada versión puede pesar cientos de MB).
    ; Windows no distingue mayúsculas, así que sirve aunque la carpeta esté en minúsculas.
    RMDir /r "$LOCALAPPDATA\${APP_PACKAGE_NAME}-updater"
  ${endIf}
!macroend
