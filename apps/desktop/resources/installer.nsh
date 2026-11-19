; Fast per-user install. Do not run the previous Uninstall.exe — that path
; shows “Inbox Flow cannot be closed” forever on Retry (error 2 / locked files).
; Wizard (oneClick=false): Welcome → Installing → Finish → launch EXE splash.

!macro customHeader
  BrandingText "Inbox Flow · inboxflow.io"
!macroend

!macro customInit
  nsExec::ExecToLog 'taskkill /F /IM "Inbox Flow.exe" /T'
  nsExec::ExecToLog 'taskkill /F /IM "InboxFlow.exe" /T'
  !ifdef UNINSTALL_REGISTRY_KEY
    DeleteRegKey HKLM "${UNINSTALL_REGISTRY_KEY}"
    DeleteRegKey HKCU "${UNINSTALL_REGISTRY_KEY}"
  !endif
  !ifdef UNINSTALL_REGISTRY_KEY_2
    DeleteRegKey HKLM "${UNINSTALL_REGISTRY_KEY_2}"
    DeleteRegKey HKCU "${UNINSTALL_REGISTRY_KEY_2}"
  !endif
  !ifdef INSTALL_REGISTRY_KEY
    DeleteRegKey HKLM "${INSTALL_REGISTRY_KEY}"
    DeleteRegKey HKCU "${INSTALL_REGISTRY_KEY}"
  !endif
  nsExec::ExecToLog 'cmd /c rmdir /s /q "C:\Program Files\Inbox Flow"'
  nsExec::ExecToLog 'cmd /c rmdir /s /q "C:\Program Files (x86)\Inbox Flow"'
!macroend

!macro customCheckAppRunning
  nsExec::ExecToLog 'taskkill /F /IM "Inbox Flow.exe" /T'
  nsExec::ExecToLog 'taskkill /F /IM "InboxFlow.exe" /T'
!macroend

!macro customUnInstallCheck
  nsExec::ExecToLog 'taskkill /F /IM "Inbox Flow.exe" /T'
  nsExec::ExecToLog 'taskkill /F /IM "InboxFlow.exe" /T'
  ClearErrors
!macroend

!macro customUnInstallCheckCurrentUser
  nsExec::ExecToLog 'taskkill /F /IM "Inbox Flow.exe" /T'
  nsExec::ExecToLog 'taskkill /F /IM "InboxFlow.exe" /T'
  ClearErrors
!macroend
