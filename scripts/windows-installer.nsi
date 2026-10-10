; Installer for the native (Rust) MDstage app. Needs NSIS 3.
;
;   makensis /DVERSION=2.0.0 /DARCH=x64 scripts\windows-installer.nsi
;
; Expects target\release\mdstage.exe and writes target\bundle\MDstage-windows-<arch>-setup.exe.
; Installs for the current user, so it needs no administrator rights.
; (Paths below are relative to this file's folder.)

Unicode true
!include "MUI2.nsh"

!ifndef VERSION
  !define VERSION "0.0.0"
!endif
!ifndef ARCH
  !define ARCH "x64"
!endif
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\MDstage"

Name "MDstage"
OutFile "..\target\bundle\MDstage-windows-${ARCH}-setup.exe"
InstallDir "$LOCALAPPDATA\Programs\MDstage"
InstallDirRegKey HKCU "Software\MDstage" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma

!define MUI_ICON "..\crates\mdstage-app\assets\mdstage.ico"
!define MUI_UNICON "..\crates\mdstage-app\assets\mdstage.ico"
!define MUI_FINISHPAGE_RUN "$INSTDIR\MDstage.exe"

!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "German"

Section "MDstage"
  SetOutPath "$INSTDIR"
  File "/oname=MDstage.exe" "..\target\release\mdstage.exe"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateShortcut "$SMPROGRAMS\MDstage.lnk" "$INSTDIR\MDstage.exe"

  WriteRegStr HKCU "Software\MDstage" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "MDstage"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "Julius B. Müller"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\MDstage.exe"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
SectionEnd

; Settings (%APPDATA%\MDstage) and show files stay where they are.
Section "Uninstall"
  Delete "$INSTDIR\MDstage.exe"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  Delete "$SMPROGRAMS\MDstage.lnk"
  DeleteRegKey HKCU "${UNINSTALL_KEY}"
  DeleteRegKey HKCU "Software\MDstage"
SectionEnd
