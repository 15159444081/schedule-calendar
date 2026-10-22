' 日程系统 · 启动器（双击运行，不弹黑框）
' 自动寻找可用的 pythonw.exe，启动 server.py

Option Explicit
Dim fso, sh, base, pyw, toolsDir, f
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

base = fso.GetParentFolderName(WScript.ScriptFullName)
pyw = ""

' 1) Hermes 自带的 python
toolsDir = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\hermes\tools"
If fso.FolderExists(toolsDir) Then
  For Each f In fso.GetFolder(toolsDir).SubFolders
    If fso.FileExists(f.Path & "\pythonw.exe") Then pyw = f.Path & "\pythonw.exe"
  Next
End If

' 2) 系统 Python
If pyw = "" Then
  If fso.FileExists("C:\Python313\pythonw.exe") Then pyw = "C:\Python313\pythonw.exe"
End If

' 3) 交给 PATH
If pyw = "" Then pyw = "pythonw.exe"

sh.CurrentDirectory = base
sh.Run """" & pyw & """ """ & base & "\server.py""", 0, False
