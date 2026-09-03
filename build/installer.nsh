; Stream Scheduler 2 — custom NSIS hooks, pulled in by electron-builder's
; `nsis.include` (see docs/SIGNING.md → "Windows in-app update").
;
; WHY THIS EXISTS. In-app updates on Windows failed with
;   "Failed to uninstall old application files. Please try running the installer again.: 2"
; on every version and every install location. Reproduced in a clean Windows VM
; and caught with Sysinternals Handle: at the moment the OLD uninstaller renames
; the app's files (it must, during an update), the just-quit "Stream Scheduler
; 2.exe" still holds icudtl.dat / resources\app.asar / *.pak open. electron-updater
; launches this installer BEFORE the app has finished quitting; the stock "is the
; app running?" check passes inside that teardown gap, and the stock uninstall
; retry (5 x 1 s) is shorter than the app's teardown.
;
; Both hooks run in the NEW installer, so they repair updates coming FROM the
; already-installed versions — nobody has to reinstall by hand.

; 1) Launched as an update? Wait for every "Stream Scheduler 2.exe" process
;    (main + renderer/GPU children — matched by NAME, so a process the path-based
;    check misses is still caught) to be gone, then give the kernel a moment to
;    release the exited process's file handles.
!macro customInit
  !ifndef SS2_WAIT_VAR
    !define SS2_WAIT_VAR
    Var /GLOBAL ss2WaitTicks
  !endif
  Push $R6
  Push $R7
  Push $R8
  ${GetParameters} $R7
  ClearErrors
  ${GetOptions} $R7 "--updated" $R6
  ${IfNot} ${Errors}
    StrCpy $ss2WaitTicks 0
    ss2_waitLoop:
      nsProcess::_FindProcess /NOUNLOAD "${APP_EXECUTABLE_FILENAME}"
      Pop $R8
      ${If} $R8 != 0
        Goto ss2_appGone          ; not running any more
      ${EndIf}
      IntOp $ss2WaitTicks $ss2WaitTicks + 1
      ${If} $ss2WaitTicks > 90
        Goto ss2_appGone          ; still up after 90 s: let the stock check close it
      ${EndIf}
      Sleep 1000
      Goto ss2_waitLoop
    ss2_appGone:
    Sleep 4000
  ${EndIf}
  Pop $R8
  Pop $R7
  Pop $R6
!macroend

; 2) If the old uninstaller fails, retry briefly (a genuinely busy file), then BYPASS it:
;    every already-deployed 2.4.4/2.4.5 shipped an uninstaller that fails NSIS's own
;    integrity check (exit code 2 before it touches a file - proven in the VM), so
;    retrying can never succeed there. Drop the stale uninstall entry and install
;    straight over the old files (the app is already gone; the new uninstaller and
;    registry entries are written by this install). $R0 = old uninstaller exit code.
!macro ss2HandleOldUninstall ROOT_KEY
  !ifndef SS2_RETRY_VAR
    !define SS2_RETRY_VAR
    Var /GLOBAL ss2UninstRetries
  !endif
  StrCpy $ss2UninstRetries 0
  ss2_retryLoop_${ROOT_KEY}:
    ${If} $R0 == 0
      Goto ss2_retryDone_${ROOT_KEY}
    ${EndIf}
    ${If} $ss2UninstRetries >= 3
      DetailPrint "Previous version's uninstaller failed (code $R0) - installing over it instead."
      DeleteRegKey ${ROOT_KEY} "${UNINSTALL_REGISTRY_KEY}"
      StrCpy $R0 0
      Goto ss2_retryDone_${ROOT_KEY}
    ${EndIf}
    IntOp $ss2UninstRetries $ss2UninstRetries + 1
    DetailPrint "Previous version's files may still be in use - retrying ($ss2UninstRetries/3)"
    Sleep 3000
    Push "${ROOT_KEY}"
    Call uninstallOldVersion
    Goto ss2_retryLoop_${ROOT_KEY}
  ss2_retryDone_${ROOT_KEY}:
!macroend

!macro customUnInstallCheck
  !insertmacro ss2HandleOldUninstall SHELL_CONTEXT
!macroend

!macro customUnInstallCheckCurrentUser
  !insertmacro ss2HandleOldUninstall HKEY_CURRENT_USER
!macroend
