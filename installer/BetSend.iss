; Inno Setup script for the BetSend installer.
;
; Compiled by .github/workflows/release.yml on a Windows runner; see
; installer/build-payload.ps1 for how the payload is assembled.
;
; The package is self-contained: it carries its own Node.js runtime and the
; already-built app, so the office PC needs no Node, no npm and no C++
; compiler. That last one matters -- better-sqlite3 used to try to compile
; itself on machines without Visual Studio, which is how this started.

#define AppName       "BetSend"
#define AppPublisher  "BetSend"
#define AppUrl        "https://github.com/hellqimiclaude/BetSend"
#ifndef AppVersion
  #define AppVersion "1.5.2"
#endif

[Setup]
AppId={{8B5F2C41-9D3E-4A7B-B612-7E4D9C1A2F30}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppUrl}
AppSupportURL={#AppUrl}
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
OutputBaseFilename=BetSend-Setup-{#AppVersion}
OutputDir=..\dist-installer
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
; Registering a startup task and opening the firewall both need elevation.
PrivilegesRequired=admin
; `x64` rather than `x64compatible`, which only exists in Inno Setup 6.3 and
; later -- this has to compile on whatever the build machine happens to have.
ArchitecturesAllowed=x64
ArchitecturesInstallIn64BitMode=x64
UninstallDisplayIcon={app}\node\node.exe
UninstallDisplayName={#AppName}
SetupLogging=yes
; Ask Windows which processes hold the files about to be replaced, and close
; them. The code below stops BetSend the tidy way first, but it can only stop
; what it recognises -- a server somebody started by hand from a command
; prompt, or one running under a different account, is not something a name
; match reliably finds. Restart Manager does not guess: it asks the kernel
; who has the handle. Without this the first locked file ends the upgrade
; with "DeleteFile failed; code 5" and a dialog offering only to cancel.
CloseApplications=force
; Our own [Run] step starts BetSend again, so Setup must not also try.
RestartApplications=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
Source: "..\dist-payload\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\Open {#AppName}";  Filename: "{code:BetSendUrl}"
Name: "{group}\BetSend folder";   Filename: "{app}"
Name: "{group}\Uninstall {#AppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{code:BetSendUrl}"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create a shortcut on the desktop"; GroupDescription: "Shortcuts:"

[Run]
; Hand over to the same script the source install uses, so there is one
; implementation of "write the config, open the firewall, register the task".
Filename: "powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\scripts\install.ps1"" -Prebuilt -Quiet -NodeExe ""{app}\node\node.exe""{code:SettingsArgs}"; \
  StatusMsg: "Setting up BetSend..."; Flags: runhidden waituntilterminated

Filename: "{code:BetSendUrl}"; Description: "Open BetSend now"; \
  Flags: postinstall shellexec nowait skipifsilent

[UninstallRun]
Filename: "powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\scripts\uninstall.ps1"""; \
  Flags: runhidden waituntilterminated; RunOnceId: "RemoveBetSendService"

[UninstallDelete]
Type: filesandordirs; Name: "{app}\logs"
Type: files;          Name: "{app}\config.json"

[Code]
var
  SettingsPage: TInputQueryWizardPage;
  AdminToken: String;
  { LoadStringFromFile takes an AnsiString even in Unicode Inno Setup. }
  AdminTokenRaw: AnsiString;

{ --- wizard ------------------------------------------------------------- }

procedure InitializeWizard;
begin
  SettingsPage := CreateInputQueryPage(wpSelectTasks,
    'BetSend settings',
    'Where should files be kept, and which address should colleagues use?',
    'These can be changed later from the Admin page inside BetSend.');

  SettingsPage.Add('Port (use 80 so nobody has to type a port number):', False);
  SettingsPage.Add('Folder for the files people send:', False);

  { Seeded from the previous install, so an upgrade shows what is running
    rather than offering to change it back to the defaults. }
  SettingsPage.Values[0] := GetPreviousData('Port', '8080');
  SettingsPage.Values[1] := GetPreviousData('StorageDir', ExpandConstant('{commonappdata}\BetSend'));
end;

function GetPort(Param: String): String;
begin
  Result := Trim(SettingsPage.Values[0]);
  if Result = '' then Result := '8080';
end;

function GetStorageDir(Param: String): String;
begin
  Result := Trim(SettingsPage.Values[1]);
  if Result = '' then Result := ExpandConstant('{commonappdata}\BetSend');
end;

procedure RegisterPreviousData(PreviousDataKey: Integer);
begin
  SetPreviousData(PreviousDataKey, 'Port', GetPort(''));
  SetPreviousData(PreviousDataKey, 'StorageDir', GetStorageDir(''));
end;

{
  The port and folder arguments, or nothing at all.

  install.ps1 keeps an existing config.json but honours either argument
  when it is passed -- and this always passed both. On a silent upgrade
  the wizard never runs, so they came from the page's hardcoded defaults
  and were written over whatever the administrator had chosen. An install
  on port 80, or with files kept on another drive, came back on 8080
  pointing at an empty folder in ProgramData, database included. Nothing
  said so; the files were still there, under the old path.

  So a silent upgrade passes nothing and the existing config stands. An
  interactive run still passes what the page shows, because somebody
  looking at that page may have come to change it -- and the page is now
  seeded from the previous install, so what it shows is the truth rather
  than a default.
}
function SettingsArgs(Param: String): String;
begin
  if WizardSilent() and FileExists(ExpandConstant('{app}\config.json')) then
    Result := ''
  else
    Result := ' -Port ' + GetPort('') + ' -StorageDir "' + GetStorageDir('') + '"';
end;

function BetSendUrl(Param: String): String;
var
  Port: String;
begin
  { The shortcut on this machine, so localhost is right here. }
  Port := GetPort('');
  if Port = '80' then
    Result := 'http://localhost'
  else
    Result := 'http://localhost:' + Port;
end;

{
  The address to hand to colleagues.

  The computer name rather than the IP: this machine almost certainly gets
  its address from DHCP, so the IP changes on a lease expiry or a reboot, and
  every bookmark and desktop app in the building stops working at once.
}
function SharedUrl(Param: String): String;
var
  Port: String;
begin
  Port := GetPort('');
  if Port = '80' then
    Result := 'http://' + Lowercase(GetComputerNameString)
  else
    Result := 'http://' + Lowercase(GetComputerNameString) + ':' + Port;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  Port: Integer;
begin
  Result := True;
  if CurPageID = SettingsPage.ID then
  begin
    Port := StrToIntDef(GetPort(''), -1);
    if (Port < 1) or (Port > 65535) then
    begin
      MsgBox('That is not a valid port number. 8080 is a good default; use 80 to leave the port out of the address.',
             mbError, MB_OK);
      Result := False;
      Exit;
    end;
    if Pos(':', GetStorageDir('')) <> 2 then
    begin
      MsgBox('Please give a full path for the files folder, such as D:\BetSendData.' + #13#10 +
             'It has to be a local drive: BetSend runs as a system service and cannot reach mapped network drives.',
             mbError, MB_OK);
      Result := False;
    end;
  end;
end;

{ --- upgrading over a running copy -------------------------------------- }

{
  Stop BetSend before replacing its files.

  Without this, upgrading an installed copy fails on the first file it tries
  to overwrite: the running server holds node.exe open, and Windows answers
  "DeleteFile failed; code 5. Access is denied." with nothing to do about it
  but cancel. Ending the scheduled task takes the supervisor and the node
  process with it.
}
procedure StopBetSend();
var
  ResultCode: Integer;
  ScriptPath: String;
  Script: String;
begin
  {
    No /f. It is valid for /create and /delete and not for /end, which
    rejects the whole command with "Invalid argument/option" -- so this
    call has never once ended the task since it was written. Nothing
    noticed because the result is deliberately ignored, on the grounds that
    a failure here usually just means it was not running. It usually did
    not mean that.

    The result is still ignored, for the original reason, but the command
    now works. /end does not prompt, so there was nothing for /f to
    suppress in the first place.
  }
  Exec(ExpandConstant('{sys}\schtasks.exe'), '/end /tn "BetSend"', '',
       SW_HIDE, ewWaitUntilTerminated, ResultCode);

  {
    Then anything the task did not own.

    Written to a file and run with -File rather than passed as -Command.
    The quoting otherwise has to survive Pascal, then CreateProcess, then
    PowerShell, and a script that is subtly mangled by one of them still
    exits zero -- which reads as "nothing was running" and leaves the file
    locked. A file has one layer of quoting instead of three.
  }
  ScriptPath := ExpandConstant('{tmp}\stop-betsend.ps1');

  {
    The path arrives as a parameter rather than being pasted into the
    script. AddQuotes only adds quotes when a string contains spaces, so
    embedding it would write `$app = C:\BetSend` for anybody who installed
    somewhere without a space in it -- a PowerShell syntax error, in a
    hidden window, reported as nothing at all.
  }
  Script :=
    'param([Parameter(Mandatory = $true)][string] $app)' + #13#10 +
    { Win32_Process, not Get-Process: reading .Path on a process owned by
      another account can fail outright, and a Where-Object filtering on a
      property that threw matches nothing at all -- indistinguishable from
      there being nothing to stop. }
    'function Find-BetSend {' + #13#10 +
    '  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |' + #13#10 +
    '    Where-Object { $_.Name -eq ''node.exe'' } |' + #13#10 +
    {  The command line as well as the executable. The server does not have
       to have been started by us: somebody running it from a command prompt
       to watch the log, with a Node of their own, holds better-sqlite3 open
       exactly the same way. That is the case that actually went wrong. }
    '    Where-Object {' + #13#10 +
    '      ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($app, ''OrdinalIgnoreCase'')) -or' + #13#10 +
    '      ($_.CommandLine -and $_.CommandLine.ToLower().Contains($app.ToLower()))' + #13#10 +
    '    }' + #13#10 +
    '}' + #13#10 +
    'Find-BetSend | ForEach-Object {' + #13#10 +
    '  Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue' + #13#10 +
    '}' + #13#10 +
    { Wait for them to actually go, rather than guessing with a sleep that
      is too long on a good day and too short on the day it matters. }
    'for ($i = 0; $i -lt 40; $i++) {' + #13#10 +
    '  if (-not (Find-BetSend)) { break }' + #13#10 +
    '  Start-Sleep -Milliseconds 250' + #13#10 +
    '}' + #13#10;

  if SaveStringToFile(ScriptPath, Script, False) then
    Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
         '-NoProfile -ExecutionPolicy Bypass -File ' + AddQuotes(ScriptPath) +
         ' -app ' + AddQuotes(ExpandConstant('{app}')),
         '', SW_HIDE, ewWaitUntilTerminated, ResultCode);

  { The handle outlives the process by a moment even once it has gone. }
  Sleep(1000);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  NeedsRestart := False;
  StopBetSend();
  Result := '';
end;

{ --- finish page -------------------------------------------------------- }

procedure CurStepChanged(CurStep: TSetupStep);
var
  TokenPath: String;
begin
  if CurStep = ssPostInstall then
  begin
    { install.ps1 leaves the generated token here; the finish page is the only
      place whoever runs setup is shown it. Remove it once it has been read. }
    TokenPath := ExpandConstant('{app}\admin-token.txt');
    if LoadStringFromFile(TokenPath, AdminTokenRaw) then
    begin
      AdminToken := Trim(String(AdminTokenRaw));
      DeleteFile(TokenPath);
    end
    else
      AdminToken := '(see config.json in the installation folder)';
  end;
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if CurPageID = wpFinished then
  begin
    WizardForm.FinishedLabel.Caption :=
      'BetSend is running and will start again with Windows.' + #13#10 + #13#10 +
      'Colleagues reach it at:  ' + SharedUrl('') + #13#10 +
      'On this machine:  ' + BetSendUrl('') + #13#10 + #13#10 +
      'Hand round the name, not the IP address: this machine almost certainly' + #13#10 +
      'gets its address from DHCP, and when that changes every bookmark in the' + #13#10 +
      'building stops working at once.' + #13#10 + #13#10 +
      'Admin token:  ' + AdminToken + #13#10 +
      'It is also saved in config.json inside the installation folder.' + #13#10 + #13#10 +
      'Next: open BetSend, go to Admin, and paste in your staff list.';
  end;
end;
