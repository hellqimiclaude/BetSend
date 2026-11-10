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

; --- removing the old version ------------------------------------------------
;
; This replaces electron-builder's own file-removal block, and the only
; thing it changes is patience.
;
; An upgrade run by the auto-updater passes --updated, and on that path the
; uninstaller does not delete the old files, it *renames* every one of them
; into a scratch folder first, so that a failure half way through can be put
; back. A rename fails if anything at all still holds the file, and the
; stock version then restores what it moved and aborts with exit code 2 --
; which the installer reports as:
;
;   Failed to uninstall old application files. Please try running the
;   installer again.: 2
;
; It is not quite a single attempt: the installer re-runs the whole
; uninstaller up to five times, a second apart, so there is perhaps twenty
; seconds of tolerance in total. That is not enough on a real machine. The
; app was force-killed a moment earlier and Windows has not finished tearing
; the process down; Defender is part way through an on-access scan of a
; folder whose contents all changed seconds ago; a search indexer has a
; handle open. Each of those can outlast twenty seconds, and when one does
; the upgrade stops dead -- silently, because nobody is watching an
; installer the updater started.
;
; So: retry inside each of those runs too, for about eighteen seconds,
; which takes the five of them to well over a minute before giving up with
; the same error as before. Nothing else differs -- same rename, same
; restore on failure, same abort at the end.
!macro customRemoveFiles
  Var /GLOBAL removalAttempt

  ${if} ${isUpdated}
    StrCpy $removalAttempt 0

    tryRemoval:
      IntOp $removalAttempt $removalAttempt + 1
      CreateDirectory "$PLUGINSDIR\old-install"

      Push ""
      Call un.atomicRMDir
      Pop $R0

      ${if} $R0 != 0
        DetailPrint "Attempt $removalAttempt: still in use: $R0"

        ; Put back whatever did get moved, so a retry starts from a whole
        ; installation rather than half of one.
        Push ""
        Call un.restoreFiles
        Pop $R1

        ${if} $removalAttempt < 12
          Sleep 1500
          Goto tryRemoval
        ${endIf}

        Abort `Can't rename "$INSTDIR" to "$PLUGINSDIR\old-install": $R0 is in use.`
      ${endIf}
  ${endIf}

  RMDir /r $INSTDIR
!macroend
