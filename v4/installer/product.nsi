; Basic Ghost Labs - Good Boy. Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
;
; The Windows installer. One script for every Basic Ghost Labs program: the program is chosen by the /D settings below,
; so the recording software and the Minecraft launcher can be packaged the same way later and sit beside Good Boy.
;
;   makensis /DPRODUCT="Good Boy" /DSLUG=GoodBoy4 /DEXE=Good-Boy-4.exe /DVERSION=4.0.1 /DSOURCE=path\to\exe /DICON=path\to\icon.ico /DOUT=Good-Boy-4-Setup.exe installer\product.nsi
;
; It installs for the person using the computer only (no administrator password, nothing in Program Files), because the
; program updates itself and so must be able to write to its own folder. Settings, data and the saved token live outside
; the program, so installing over an older copy, or uninstalling, never touches them unless the person says so.
Unicode true
!ifndef PRODUCT
  !error "Give the program's name with /DPRODUCT"
!endif
!ifndef SLUG
  !error "Give a short name with no spaces with /DSLUG"
!endif
!ifndef EXE
  !error "Give the program's file name with /DEXE"
!endif
!ifndef SOURCE
  !error "Give the built program with /DSOURCE"
!endif
!ifndef ICON
  !error "Give the icon with /DICON"
!endif
!ifndef OUT
  !define OUT "${SLUG}-Setup.exe"
!endif
!ifndef VERSION
  !define VERSION "0.0.0"
!endif
; the folder inside the program's data that "delete my data" removes (leave empty when the program has none)
!ifndef DATADIR
  !define DATADIR ""
!endif
!define COMPANY "Basic Ghost Labs"
!define REGKEY "Software\${COMPANY}\${PRODUCT}"
!define UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\BasicGhostLabs${SLUG}"

!include "MUI2.nsh"
!include "FileFunc.nsh"

Name "${PRODUCT}"
OutFile "${OUT}"
RequestExecutionLevel user
InstallDir "$LOCALAPPDATA\Programs\${COMPANY}\${PRODUCT}"
; an existing install is updated where it is, wherever that was
InstallDirRegKey HKCU "${REGKEY}" "InstallDir"
BrandingText "${COMPANY}"
SetCompressor /SOLID lzma
VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "${PRODUCT}"
VIAddVersionKey "CompanyName" "${COMPANY}"
VIAddVersionKey "LegalCopyright" "Copyright (c) 2026 ${COMPANY}. All rights reserved."
VIAddVersionKey "FileDescription" "${PRODUCT} setup"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"

!define MUI_ICON "${ICON}"
!define MUI_UNICON "${ICON}"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\${EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "Open ${PRODUCT}"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Section "${PRODUCT}" SecMain
  SectionIn RO
  SetOutPath "$INSTDIR"
  ; A program that is open cannot be overwritten, but it can be renamed. The old file is set aside and removed (now if it
  ; can be, otherwise the program removes it the next time it starts). The open copy keeps running until it is closed.
  IfFileExists "$INSTDIR\${EXE}" 0 +3
    Delete "$INSTDIR\${EXE}.old"
    Rename "$INSTDIR\${EXE}" "$INSTDIR\${EXE}.old"
  File "/oname=${EXE}" "${SOURCE}"
  Delete "$INSTDIR\${EXE}.old"
  WriteUninstaller "$INSTDIR\Uninstall.exe"

  CreateDirectory "$SMPROGRAMS\${COMPANY}"
  CreateShortcut "$SMPROGRAMS\${COMPANY}\${PRODUCT}.lnk" "$INSTDIR\${EXE}"

  WriteRegStr HKCU "${REGKEY}" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${REGKEY}" "Version" "${VERSION}"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayName" "${PRODUCT}"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINSTKEY}" "Publisher" "${COMPANY}"
  WriteRegStr HKCU "${UNINSTKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayIcon" "$INSTDIR\${EXE}"
  WriteRegStr HKCU "${UNINSTKEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "${UNINSTKEY}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKCU "${UNINSTKEY}" "EstimatedSize" "$0"
SectionEnd

Section "Desktop shortcut" SecDesktop
  CreateShortcut "$DESKTOP\${PRODUCT}.lnk" "$INSTDIR\${EXE}"
SectionEnd

!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SecMain} "The program. Your settings, levels and saved token are kept somewhere else and are never changed by installing."
  !insertmacro MUI_DESCRIPTION_TEXT ${SecDesktop} "A shortcut on the desktop."
!insertmacro MUI_FUNCTION_DESCRIPTION_END

Section "Uninstall"
  ; the program may be open: it cannot be deleted, so it is removed when the computer next starts
  Delete /REBOOTOK "$INSTDIR\${EXE}"
  Delete "$INSTDIR\${EXE}.old"
  Delete "$INSTDIR\${EXE}.new"
  Delete "$INSTDIR\${EXE}.part"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  ; the parent folder goes only when it is empty, so another Basic Ghost Labs program beside this one is never touched
  RMDir "$LOCALAPPDATA\Programs\${COMPANY}"
  Delete "$SMPROGRAMS\${COMPANY}\${PRODUCT}.lnk"
  RMDir "$SMPROGRAMS\${COMPANY}"
  Delete "$DESKTOP\${PRODUCT}.lnk"
  DeleteRegKey HKCU "${UNINSTKEY}"
  DeleteRegKey HKCU "${REGKEY}"
  DeleteRegKey /ifempty HKCU "Software\${COMPANY}"
  ; data is only ever deleted when the person asks, and the answer to a silent uninstall is no
  !if "${DATADIR}" != ""
    IfSilent done
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Also delete your ${PRODUCT} settings and data?$\r$\n$\r$\nChoose No to keep them, so installing again picks up where you left off." IDNO done
    RMDir /r "$APPDATA\${DATADIR}"
    done:
  !endif
SectionEnd
