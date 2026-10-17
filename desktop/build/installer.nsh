; Explorer's right-click menu entry.
;
; Written under HKCU, matching the per-user install: no administrator rights
; are needed, and two people on one machine each get their own.
;
; "%1" is the file the shell passes. Windows runs this verb once per selected
; file, so a thirty-file selection launches the app thirty times -- the app
; gathers those back into one transfer itself.

!macro customInstall
  WriteRegStr HKCU "Software\Classes\*\shell\BetSend" "" "Send with BetSend"
  WriteRegStr HKCU "Software\Classes\*\shell\BetSend" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\*\shell\BetSend\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --send "%1"'
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\*\shell\BetSend"
!macroend
