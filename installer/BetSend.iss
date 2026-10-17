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
  #define AppVersion "1.1.4"
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
  Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\scripts\install.ps1"" -Prebuilt -Quiet -NodeExe ""{app}\node\node.exe"" -Port {code:GetPort} -StorageDir ""{code:GetStorageDir}"""; \
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

  SettingsPage.Values[0] := '8080';
  SettingsPage.Values[1] := ExpandConstant('{commonappdata}\BetSend');
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

function BetSendUrl(Param: String): String;
var
  Port: String;
begin
  Port := GetPort('');
  if Port = '80' then
    Result := 'http://localhost'
  else
    Result := 'http://localhost:' + Port;
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
      'Colleagues reach it at:  ' + BetSendUrl('') + #13#10 +
      '(on their own machines, swap "localhost" for this computer''s name or IP)' + #13#10 + #13#10 +
      'Admin token:  ' + AdminToken + #13#10 +
      'It is also saved in config.json inside the installation folder.' + #13#10 + #13#10 +
      'Next: open BetSend, go to Admin, and paste in your staff list.';
  end;
end;
