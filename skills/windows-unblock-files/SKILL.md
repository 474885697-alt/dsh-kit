---
name: windows-unblock-files
description: 当从网上下载的脚本/压缩包/文档被 Windows 标记为「来自其他计算机」而无法运行、解压或打开，或 PowerShell 报「禁止运行脚本」时使用。给出 MOTW 检测、单文件解除、目录批量解除、Zone.Identifier 原理与执行策略的取舍。
---

# 解除下载文件的「来自其他计算机」标记（MOTW）

## 判断有没有被标记

```powershell
Get-Item .\setup.exe -Stream Zone.Identifier -ErrorAction SilentlyContinue
Get-Content .\setup.exe -Stream Zone.Identifier -ErrorAction SilentlyContinue
```

有 `ZoneId=3` 就是「来自 Internet」。

## 单文件解除

```powershell
Unblock-File -Path .\setup.exe
```

等价于删除 `Zone.Identifier` 备用数据流：

```powershell
Remove-Item .\setup.exe -Stream Zone.Identifier -ErrorAction SilentlyContinue
```

## 目录批量解除（先看再动）

```powershell
Get-ChildItem -Path .\downloads -Recurse -File |
  Where-Object { Get-Item $_.FullName -Stream Zone.Identifier -ErrorAction SilentlyContinue } |
  Select-Object FullName
# 确认无误后
Get-ChildItem -Path .\downloads -Recurse -File | Unblock-File
```

## 脚本被策略拦下

报错形如「无法加载文件 … 因为在此系统上禁止运行脚本」时，不要直接 `Set-ExecutionPolicy Unrestricted`。优先：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\script.ps1
```

只对本次调用放行，不改系统设置。确实要改时用 `-Scope CurrentUser`，并记住这是安全边界。

解压前先看清楚内容：`Expand-Archive` 会对每个文件保留 MOTW，解压后再批量解除更稳妥。