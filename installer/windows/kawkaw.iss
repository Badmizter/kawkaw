; KawKaw Windows installer (Inno Setup 6). Built by .github/workflows/release.yml
; Installs per-user (no admin needed) to %LOCALAPPDATA%\Programs\KawKaw
#define AppVersion GetEnv("KAWKAW_VERSION")
#if AppVersion == ""
  #define AppVersion "0.2.3"
#endif

[Setup]
AppId={{7C1B6C2E-4A57-4B8E-9E1D-6B1A4C0B4A77}
AppName=KawKaw
AppVersion={#AppVersion}
AppPublisher=Nelson Maita
AppPublisherURL=https://github.com/Badmizter/kawkaw
DefaultDirName={localappdata}\Programs\KawKaw
DisableProgramGroupPage=yes
DisableDirPage=yes
PrivilegesRequired=lowest
OutputDir=..\..\out
OutputBaseFilename=KawKaw-Setup-{#AppVersion}
SetupIconFile=..\..\assets\kawkaw.ico
UninstallDisplayIcon={app}\assets\kawkaw.ico
WizardStyle=modern
Compression=lzma2/ultra
SolidCompression=yes
CloseApplications=force

[Files]
Source: "..\..\stage\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{autoprograms}\KawKaw"; Filename: "{app}\runtime\node.exe"; Parameters: """{app}\bridge\src\cli.js"" open"; IconFilename: "{app}\assets\kawkaw.ico"; Flags: runminimized
Name: "{autodesktop}\KawKaw"; Filename: "{app}\runtime\node.exe"; Parameters: """{app}\bridge\src\cli.js"" open"; IconFilename: "{app}\assets\kawkaw.ico"; Flags: runminimized; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create a desktop icon"

[Run]
Filename: "{app}\runtime\node.exe"; Parameters: """{app}\bridge\src\cli.js"" setup"; StatusMsg: "Connecting KawKaw to Claude..."; Flags: runhidden waituntilterminated
Filename: "{app}\runtime\node.exe"; Parameters: """{app}\bridge\src\cli.js"" daemon"; Flags: runhidden nowait
Filename: "{app}\dist\KawKaw.ccx"; Description: "Install the Premiere Pro panel (opens Creative Cloud)"; Flags: shellexec postinstall skipifsilent
Filename: "{app}\runtime\node.exe"; Parameters: """{app}\bridge\src\cli.js"" open"; Description: "Open KawKaw settings (API keys, ChatGPT link)"; Flags: runhidden postinstall skipifsilent nowait

[UninstallRun]
Filename: "{app}\runtime\node.exe"; Parameters: """{app}\bridge\src\cli.js"" stop"; Flags: runhidden waituntilterminated; RunOnceId: "kawkaw-stop"
Filename: "{app}\runtime\node.exe"; Parameters: """{app}\bridge\src\cli.js"" uninstall"; Flags: runhidden waituntilterminated; RunOnceId: "kawkaw-uninstall"

[Code]
// Stop a running KawKaw before upgrading so its files can be replaced.
function PrepareToInstall(var NeedsRestart: Boolean): String;
var Code: Integer; Node: String;
begin
  Node := ExpandConstant('{app}\runtime\node.exe');
  if FileExists(Node) then
  begin
    Exec(Node, '"' + ExpandConstant('{app}\bridge\src\cli.js') + '" stop', '', SW_HIDE, ewWaitUntilTerminated, Code);
    Sleep(800);
  end;
  Result := '';
end;
