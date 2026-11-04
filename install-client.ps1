<#
.SYNOPSIS
    WinOps İstemci Kurulum Otomasyonu (GitHub Raw Bootstrap)
#>

[CmdletBinding()]
param (
    [Parameter(Mandatory = $false)]
    [string]$ServerUrl = "http://51.195.176.183:3000",

    [Parameter(Mandatory = $false)]
    [string]$ClientId = $env:COMPUTERNAME,

    [Parameter(Mandatory = $false)]
    [string]$GitHubRepo = "ayazOne/winops"
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  WinOps İstemci Dağıtımı ($ClientId)"      -ForegroundColor Cyan
Write-Host "  Sunucu     : $ServerUrl"                 -ForegroundColor Yellow
Write-Host "  GitHub Repo: $GitHubRepo"                -ForegroundColor Yellow
Write-Host "==========================================" -ForegroundColor Cyan

$InstallDir = "C:\WinOps\Client"
if (-not (Test-Path $InstallDir)) {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
}

# 1. ClientAgent.ps1 dosyasını GitHub'dan indir
$rawAgentUrl = "https://raw.githubusercontent.com/$GitHubRepo/main/client/ClientAgent.ps1?t=$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())"
Write-Host "[1/3] Ajan betiği GitHub'dan indiriliyor..." -ForegroundColor Cyan
Invoke-RestMethod -Uri $rawAgentUrl -OutFile "$InstallDir\ClientAgent.ps1"

# 2. Başlatma komut dosyası
$runCmd = @"
powershell.exe -ExecutionPolicy Bypass -NoProfile -WindowStyle Hidden -File "$InstallDir\ClientAgent.ps1" -ServerUrl "$ServerUrl" -ClientId "$ClientId" -GitHubRepo "$GitHubRepo"
"@
Set-Content -Path "$InstallDir\run.cmd" -Value $runCmd -Encoding ASCII

# 3. Scheduled Task (Açılışta otomatik başlasın)
$TaskName = "WinOpsClientAgent"
$Action = New-ScheduledTaskAction -Execute "$InstallDir\run.cmd"
$Trigger = New-ScheduledTaskTrigger -AtStartup
$Principal = New-ScheduledTaskPrincipal -UserId "NT AUTHORITY\SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Principal $Principal -Settings $Settings | Out-Null
Start-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue

Write-Host "[2/3] İstemci servisi (Scheduled Task) kaydedildi ve başlatıldı." -ForegroundColor Cyan
Write-Host "[3/3] Kurulum başarıyla tamamlandı!" -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Cyan
