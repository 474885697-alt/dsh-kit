---
name: windows-quiet-pc
description: 当用户抱怨 Windows 电脑风扇狂转、噪音大、发热高、待机也吵，想定位是哪个进程/计划任务/电源策略导致时使用。给出只读取证命令、常见元凶（Windows 更新、杀软扫描、浏览器后台、显卡驱动、Defender 全盘扫描、充电策略）与分步降噪手段。
---

# Windows 风扇噪音排查

## 先取证（只读）

```powershell
# CPU 占用前 15
Get-Process | Sort-Object CPU -Descending | Select-Object -First 15 Name, Id, CPU, WS

# 实时占用（观察 10 秒）
Get-Counter '\Process(*)\% Processor Time' -SampleInterval 1 -MaxSamples 10 |
  ForEach-Object { $_.CounterSamples | Where-Object CookedValue -gt 20 } |
  Select-Object InstanceName, CookedValue

# 电源计划与当前频率
powercfg /getactivescheme
Get-CimInstance Win32_Processor | Select-Object Name, CurrentClockSpeed, MaxClockSpeed, LoadPercentage

# 温度（需要管理员，部分机器无此命名空间）
Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature -ErrorAction SilentlyContinue |
  Select-Object InstanceName, @{n='C';e={($_.CurrentTemperature/10)-273.15}}
```

## 常见元凶与对策

| 现象 | 检查 | 对策 |
| --- | --- | --- |
| 空闲也 20%+ CPU | `Get-Process` 排序、任务计划 `Get-ScheduledTask | Where State -eq Ready` | 关掉/推迟 Windows 更新、杀软定时扫描 |
| 磁盘 100% | `Get-Counter '\PhysicalDisk(*)\% Disk Time'` | 关 SysMain、Windows Search 索引范围 |
| 一插电就吵 | `powercfg /getactivescheme` | 建「平衡/节能」方案，处理器最大状态 99% 可关睿频 |
| 待机仍转 | 检查后台浏览器标签、Electron 应用 | 退出而非最小化；关硬件加速 |
| 温度高但占用低 | 出风口积灰、硅脂老化 | 清灰、换硅脂；笔记本抬高进风 |

调频率上限（可逆）：

```powershell
powercfg /setacvalueindex SCHEME_CURRENT SUB_PROCESSOR PROCTHROTTLEMAX 99
powercfg /setactive SCHEME_CURRENT
```

降噪前先记录基线（CPU 温度、空闲占用），改完对比，避免「感觉安静了」的假象。