<#
.SYNOPSIS
    WinOps İstemci Kurulum Otomasyonu
    İstemciyi C:\WinOps\Client dizinine kurar, başlangıç görevini ayarlar.
#>

[CmdletBinding()]
param (
    [Parameter(Mandatory = $false)]
    [string]$ServerUrl = "http://192.168.1.100:3000",

    [Parameter(Mandatory = $false)]
    [string]$ClientId = $env:COMPUTERNAME
)

$ErrorActionPreference = "Stop"

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  WinOps İstemci Dağıtım Kurulumu         " -ForegroundColor Cyan
Write-Host "  İstemci ID : $ClientId                  " -ForegroundColor Yellow
Write-Host "  Sunucu     : $ServerUrl                 " -ForegroundColor Yellow
Write-Host "==========================================" -ForegroundColor Cyan

$InstallDir = "C:\WinOps\Client"
if (-not (Test-Path $InstallDir)) {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
}

$agentScriptPath = "$InstallDir\ClientAgent.ps1"
if (-not (Test-Path $agentScriptPath)) {
    if (Test-Path "$PSScriptRoot\ClientAgent.ps1") {
        Copy-Item -Path "$PSScriptRoot\ClientAgent.ps1" -Destination $agentScriptPath -Force
    }
}

# 1. Başlatma Betiği Oluştur (PowerShell WindowStyle Hidden)
$runScript = @"
powershell.exe -ExecutionPolicy Bypass -NoProfile -WindowStyle Hidden -File "$InstallDir\ClientAgent.ps1" -ServerUrl "$ServerUrl" -ClientId "$ClientId"
"@
Set-Content -Path "$InstallDir\run.cmd" -Value $runScript -Encoding ASCII

# 2. Windows Zamanlanmış Görevini Oluştur (Açılışta SYSTEM olarak çalışır)
$TaskName = "WinOpsClientAgent"
$Action = New-ScheduledTaskAction -Execute "$InstallDir\run.cmd"
$Trigger = New-ScheduledTaskTrigger -AtStartup
$Principal = New-ScheduledTaskPrincipal -UserId "NT AUTHORITY\SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Principal $Principal -Settings $Settings | Out-Null

# Görevi anında başlat
Start-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue

Write-Host "[✓] İstemci başarıyla kuruldu ve arka plan görevi başlatıldı!" -ForegroundColor Green
Write-Host "[✓] Görev Adı: $TaskName" -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Cyan
