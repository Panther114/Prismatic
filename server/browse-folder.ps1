# Modern Vista+ folder picker (IFileOpenDialog with FOS_PICKFOLDERS).
# Looks like the standard Windows file explorer dialog, not the old tree browser.
$ErrorActionPreference = "Stop"

if (-not ("Prismatic.ModernFolderPicker" -as [type])) {
  Add-Type -ReferencedAssemblies System.Runtime.InteropServices.dll -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace Prismatic {
  public static class ModernFolderPicker {
    private const uint FOS_PICKFOLDERS = 0x00000020;
    private const uint FOS_FORCEFILESYSTEM = 0x00000040;
    private const uint FOS_PATHMUSTEXIST = 0x00000800;
    private const uint FOS_NOCHANGEDIR = 0x00000008;
    private const uint SIGDN_FILESYSPATH = 0x80058000;
    private const int S_OK = 0;
    private const int HRESULT_CANCELLED = unchecked((int)0x800704C7);

    [ComImport]
    [Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")]
    private class FileOpenDialogRCW {}

    [ComImport]
    [Guid("42F85136-DB7E-439C-85F1-E4075D135FC8")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IFileDialog {
      [PreserveSig] int Show([In] IntPtr parent);
      void SetFileTypes([In] uint cFileTypes, [In] IntPtr rgFilterSpec);
      void SetFileTypeIndex([In] uint iFileType);
      void GetFileTypeIndex(out uint piFileType);
      void Advise([In] IntPtr pfde, out uint pdwCookie);
      void Unadvise([In] uint dwCookie);
      void SetOptions([In] uint fos);
      void GetOptions(out uint pfos);
      void SetDefaultFolder([In] IShellItem psi);
      void SetFolder([In] IShellItem psi);
      void GetFolder(out IShellItem ppsi);
      void GetCurrentSelection(out IShellItem ppsi);
      void SetFileName([In, MarshalAs(UnmanagedType.LPWStr)] string pszName);
      void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
      void SetTitle([In, MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
      void SetOkButtonLabel([In, MarshalAs(UnmanagedType.LPWStr)] string pszText);
      void SetFileNameLabel([In, MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
      void GetResult(out IShellItem ppsi);
      void AddPlace([In] IShellItem psi, int alignment);
      void SetDefaultExtension([In, MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);
      void Close([MarshalAs(UnmanagedType.Error)] int hr);
      void SetClientGuid([In] ref Guid guid);
      void ClearClientData();
      void SetFilter([MarshalAs(UnmanagedType.Interface)] IntPtr pFilter);
    }

    [ComImport]
    [Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellItem {
      void BindToHandler(IntPtr pbc, [MarshalAs(UnmanagedType.LPStruct)] Guid bhid, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, out IntPtr ppv);
      void GetParent(out IShellItem ppsi);
      void GetDisplayName(uint sigdnName, out IntPtr ppszName);
      void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
      void Compare(IShellItem psi, uint hint, out int piOrder);
    }

    public static string Pick(string title) {
      var dialog = (IFileDialog)new FileOpenDialogRCW();
      uint options;
      dialog.GetOptions(out options);
      dialog.SetOptions(options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST | FOS_NOCHANGEDIR);
      if (!string.IsNullOrEmpty(title)) {
        dialog.SetTitle(title);
      }
      dialog.SetOkButtonLabel("Select Folder");

      int hr = dialog.Show(IntPtr.Zero);
      if (hr == HRESULT_CANCELLED) return null;
      if (hr != S_OK) Marshal.ThrowExceptionForHR(hr);

      IShellItem item;
      dialog.GetResult(out item);
      IntPtr pszPath;
      item.GetDisplayName(SIGDN_FILESYSPATH, out pszPath);
      try {
        return Marshal.PtrToStringUni(pszPath);
      } finally {
        if (pszPath != IntPtr.Zero) Marshal.FreeCoTaskMem(pszPath);
      }
    }
  }
}
'@
}

try {
  $path = [Prismatic.ModernFolderPicker]::Pick("Choose a music folder to watch")
  if ([string]::IsNullOrWhiteSpace($path)) { exit 0 }
  [Console]::Out.Write($path)
  exit 0
} catch {
  [Console]::Error.Write($_.Exception.Message)
  exit 1
}
