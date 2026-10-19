; Explorer's right-click menu entry.
;
; Written under HKCU, matching the per-user install: no administrator rights
; are needed, and two people on one machine each get their own.
;
; "%1" is the file the shell passes. Windows runs this verb once per selected
; file, so a thirty-file selection launches the app thirty times -- the app
; gathers those back into one transfer itself.
;
; --send="%1" with the equals sign, not a space. Chromium rewrites the
; command line before the app sees it, gathering switches at the front and
; pushing positional arguments to the end, which separates a space-form
; switch from its value. An attached value travels with the switch.

!macro customInstall
  WriteRegStr HKCU "Software\Classes\*\shell\BetSend" "" "Send with BetSend"
  WriteRegStr HKCU "Software\Classes\*\shell\BetSend" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\*\shell\BetSend\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --send="%1"'
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\*\shell\BetSend"
!macroend
