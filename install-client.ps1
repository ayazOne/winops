<#
.SYNOPSIS
    WinOps İstemci Kurulum Otomasyonu (Zero-Cache 10sn Otonom Güncelleme)
#>

[CmdletBinding()]
param (
    [Parameter(Mandatory = $false)]
    [string]$ServerUrl = "http://51.195.176.183:3001",

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

# Eski çalışan istemci süreçlerini durdur
$TaskName = "WinOpsClientAgent"
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe' OR Name = 'cmd.exe'" -ErrorAction SilentlyContinue | Where-Object {
    $_.CommandLine -match "ClientAgent\.ps1" -or $_.CommandLine -match "WinOps\\Client\\run\.cmd"
} | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}

$InstallDir = "C:\WinOps\Client"
if (-not (Test-Path $InstallDir)) {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
}

# 1. En güncel Commit SHA ile GitHub CDN önbelleğini aşarak indir
$commitSha = "main"
try {
    $refsResp = Invoke-WebRequest -Uri "https://github.com/$GitHubRepo/info/refs?service=git-upload-pack&t=$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())" -UseBasicParsing -TimeoutSec 8
    $refsText = if ($refsResp.Content -is [byte[]]) { [System.Text.Encoding]::ASCII.GetString($refsResp.Content) } else { [string]$refsResp.Content }
    if ($refsText -match '([0-9a-f]{40})\s+refs/heads/main') {
        $commitSha = $Matches[1]
    }
} catch {}

$rawAgentUrl = "https://raw.githubusercontent.com/$GitHubRepo/$commitSha/client/ClientAgent.ps1?t=$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
Write-Host "[1/3] En güncel ajan betiği indiriliyor (Commit: $($commitSha.Substring(0, [Math]::Min(7, $commitSha.Length))))..." -ForegroundColor Cyan
Invoke-RestMethod -Uri $rawAgentUrl -OutFile "$InstallDir\ClientAgent.ps1"

# 2. Başlatma komut dosyası (Self-Healing Loop)
$runCmd = @"
@echo off
:loop
powershell.exe -ExecutionPolicy Bypass -NoProfile -WindowStyle Hidden -File "$InstallDir\ClientAgent.ps1" -ServerUrl "$ServerUrl" -ClientId "$ClientId" -GitHubRepo "$GitHubRepo"
timeout /t 2 /nobreak >nul
goto loop
"@
Set-Content -Path "$InstallDir\run.cmd" -Value $runCmd -Encoding ASCII

# 3. Scheduled Task (Açılışta otomatik başlasın) ve Hemen Başlat
$Action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$InstallDir\run.cmd`""
$Trigger = New-ScheduledTaskTrigger -AtStartup
$Principal = New-ScheduledTaskPrincipal -UserId "NT AUTHORITY\SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Principal $Principal -Settings $Settings | Out-Null
Start-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue

# Hemen çalışmasını garantiye al
Start-Process -FilePath "cmd.exe" -ArgumentList "/c `"$InstallDir\run.cmd`"" -WindowStyle Hidden

Write-Host "[2/3] İstemci servisi kaydedildi ve başlatıldı." -ForegroundColor Cyan
Write-Host "[3/3] Kurulum tamamlandı (v1.3.0)! 10 saniyelik otonom güncelleme aktif." -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Cyan
