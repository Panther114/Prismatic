; Production NSIS hooks for Prismatic (electron-builder).
; Used with oneClick: false so install/uninstall show full wizard pages.

!macro customHeader
  !define MUI_FINISHPAGE_TITLE "Prismatic installed successfully"
  !define MUI_FINISHPAGE_TEXT "Prismatic has been installed on your computer.$\r$\n$\r$\nClick Finish to close Setup. You can launch Prismatic from the Start menu or desktop shortcut."
  !define MUI_FINISHPAGE_RUN_TEXT "Launch Prismatic now"
  !define MUI_UNCONFIRMPAGE_TEXT_TOP "Prismatics will be removed from your computer. Click Uninstall to continue."
  !define MUI_UNFINISHPAGE_TITLE "Prismatic uninstalled successfully"
  !define MUI_UNFINISHPAGE_TEXT "Prismatic was successfully removed from your computer.$\r$\n$\r$\nClick Finish to close this wizard."
!macroend

!macro customInstall
  DetailPrint "Copying Prismatic application files..."
  DetailPrint "Installation completed successfully."
!macroend

!macro customUnInstall
  DetailPrint "Removing Prismatic application files..."
  DetailPrint "Uninstall completed successfully."
!macroend
