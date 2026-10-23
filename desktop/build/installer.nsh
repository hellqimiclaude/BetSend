; Explorer's right-click menu entry, and the firewall rule that lets a
; colleague's machine reach this one.
;
; The registry entry is written under HKCU, matching the per-user install: no
; administrator rights are needed, and two people on one machine each get
; their own.
;
; "%1" is the file the shell passes. Windows runs this verb once per selected
; file, so a thirty-file selection launches the app thirty times -- the app
; gathers those back into one transfer itself.
;
; --send="%1" with the equals sign, not a space. Chromium rewrites the
; command line before the app sees it, gathering switches at the front and
; pushing positional arguments to the end, which separates a space-form
; switch from its value. An attached value travels with the switch.

!define BETSEND_FW_RULE "BetSend direct transfers"

!macro customInstall
  WriteRegStr HKCU "Software\Classes\*\shell\BetSend" "" "Send with BetSend"
  WriteRegStr HKCU "Software\Classes\*\shell\BetSend" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\*\shell\BetSend\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --send="%1"'

  ; --- the firewall ---------------------------------------------------------
  ;
  ; Receiving a file straight from a colleague's PC means listening on a
  ; port, and Windows blocks that by default. The alternative to asking here
  ; is the dialog Windows throws the first time the app listens, which
  ; appears without warning, is easy to dismiss by accident, and leaves
  ; somebody wondering why files only ever arrive the slow way.
  ;
  ; The rule is scoped to this executable rather than to a port number. It is
  ; tighter -- nothing else on the machine gains anything -- and it keeps
  ; working if the app has to take a different port because something else
  ; already has 7345.
  ;
  ; profile=any on purpose. A rule for Private and Domain does nothing at all
  ; on a network Windows has decided is Public, and whether an office LAN is
  ; classified Public is not something anybody installing this will know.
  ;
  ; Declining is a supported answer. Without the rule the app still sends and
  ; receives; everything simply goes through the server, which is where it
  ; went before this feature existed.
  ;
  ; The rule is removed and re-added every install rather than added only
  ; when missing. That costs one explained prompt on an upgrade, and buys a
  ; rule that is always right: netsh is happy to create a second rule of the
  ; same name, and an install into a different directory would otherwise
  ; leave one pointing at an executable that is no longer there -- which
  ; would stop direct transfers arriving with nothing at all to show why.

  IfSilent 0 ask

  ; A silent install is an IT deployment or a CI run. Run netsh directly:
  ; it succeeds if the installer is already elevated and fails harmlessly if
  ; not. What it must never do is raise a UAC prompt, because there would be
  ; nobody there to answer it and the install would hang.
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="${BETSEND_FW_RULE}"'
  Pop $0
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="${BETSEND_FW_RULE}" dir=in action=allow profile=any enable=yes program="$INSTDIR\${APP_EXECUTABLE_FILENAME}"'
  Pop $0
  DetailPrint "Firewall rule: netsh exited with $0"
  Goto done

ask:
  MessageBox MB_YESNO|MB_ICONQUESTION \
    "BetSend can receive files sent straight from a colleague's PC, which is much faster than going through the server.$\r$\n$\r$\nThat needs a Windows Firewall rule, so Windows will ask for administrator permission next.$\r$\n$\r$\nIf you skip this, BetSend still works -- files will go through the server instead." \
    IDNO done

  ; Delete and add in one elevated command, so a reinstall does not stack up
  ; duplicate rules and does not ask twice.
  ExecShellWait "runas" "cmd.exe" \
    '/c netsh advfirewall firewall delete rule name="${BETSEND_FW_RULE}" >nul 2>&1 & netsh advfirewall firewall add rule name="${BETSEND_FW_RULE}" dir=in action=allow profile=any enable=yes program="$INSTDIR\${APP_EXECUTABLE_FILENAME}"' \
    SW_HIDE

done:
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\*\shell\BetSend"

  ; Tidy the rule away if this uninstall happens to be elevated, and say
  ; nothing if it is not. A second UAC prompt during an uninstall, for a
  ; rule that now points at an executable which no longer exists and so
  ; allows precisely nothing, would be an interruption bought for no safety
  ; at all.
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="${BETSEND_FW_RULE}"'
  Pop $0
!macroend
