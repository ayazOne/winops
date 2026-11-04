<#
.SYNOPSIS
    WinOps İstemci Kurulum Otomasyonu (v1.6.0)
    Her kurulumda doğrudan Sunucudan sıradaki numarayı (PC-01, PC-02, PC-03...) alır!
#>

[CmdletBinding()]
param (
    [Parameter(Mandatory = $false)]
    [string]$ServerUrl = "http://51.195.176.183:3001",

    [Parameter(Mandatory = $false)]
    [string]$GitHubRepo = "ayazOne/winops"
)

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

$InstallDir = "C:\WinOps\Client"
try {
    if (-not (Test-Path $InstallDir)) {
        New-Item -ItemType Directory -Path $InstallDir -Force -ErrorAction Stop | Out-Null
    }
    # Yazma testi
    Set-Content -Path "$InstallDir\.write_test" -Value "ok" -Force -ErrorAction Stop
    Remove-Item "$InstallDir\.write_test" -Force -ErrorAction SilentlyContinue
} catch {
    $InstallDir = "$env:LOCALAPPDATA\WinOps\Client"
    if (-not (Test-Path $InstallDir)) {
        New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    }
}

# Eski çalışan istemci süreçlerini durdur
$TaskName = "WinOpsClientAgent"
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe' OR Name = 'cmd.exe'" -ErrorAction SilentlyContinue | Where-Object {
    $_.CommandLine -match "ClientAgent\.ps1" -or $_.CommandLine -match "WinOps\\Client\\run\.cmd"
} | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}

# Doğrudan Sunucudan Sıradaki Numarayı Al (PC-01, PC-02, PC-03...)
$escapedHost = [uri]::EscapeDataString($env:COMPUTERNAME)
$assignResp = Invoke-RestMethod -Uri "$ServerUrl/api/assign-id?hostname=$escapedHost&t=$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())" -Method GET -TimeoutSec 10 -ErrorAction Stop

$ClientId = $assignResp.clientId
$Token = $assignResp.token

$authData = @{
    clientId = $ClientId
    token    = $Token
} | ConvertTo-Json
Set-Content -Path "$InstallDir\client-auth.json" -Value $authData -Encoding UTF8 -Force

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  WinOps İstemci Kurulumu -> $ClientId"     -ForegroundColor Green
Write-Host "  Sunucu     : $ServerUrl"                 -ForegroundColor Yellow
Write-Host "  Yetki Modu : $(if ($isAdmin) { 'Yönetici (SYSTEM)' } else { 'Standart Kullanıcı' })" -ForegroundColor Yellow
Write-Host "==========================================" -ForegroundColor Cyan

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
Write-Host "[1/3] En güncel ajan betiği indiriliyor..." -ForegroundColor Cyan
Invoke-RestMethod -Uri $rawAgentUrl -OutFile "$InstallDir\ClientAgent.ps1"

# 2. Başlatma komut dosyası
$runCmd = @"
@echo off
:loop
if not exist "$InstallDir\client-auth.json" exit /b 0
powershell.exe -ExecutionPolicy Bypass -NoProfile -WindowStyle Hidden -File "$InstallDir\ClientAgent.ps1" -ServerUrl "$ServerUrl" -ClientId "$ClientId" -Token "$Token" -GitHubRepo "$GitHubRepo"
if not exist "$InstallDir\client-auth.json" exit /b 0
timeout /t 2 /nobreak >nul
goto loop
"@
Set-Content -Path "$InstallDir\run.cmd" -Value $runCmd -Encoding ASCII

# 3. Kalıcılık
if ($isAdmin) {
    try {
        $Action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$InstallDir\run.cmd`""
        $Trigger = New-ScheduledTaskTrigger -AtStartup
        $Principal = New-ScheduledTaskPrincipal -UserId "NT AUTHORITY\SYSTEM" -LogonType ServiceAccount -RunLevel Highest
        $Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
        Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Principal $Principal -Settings $Settings -ErrorAction Stop | Out-Null
        Start-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        Write-Host "[2/3] İstemci SYSTEM servisi olarak kaydedildi." -ForegroundColor Cyan
    } catch {
        Set-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name "WinOpsClientAgent" -Value "`"$InstallDir\run.cmd`"" -Force -ErrorAction SilentlyContinue
        Write-Host "[2/3] İstemci başlangıç kaydı oluşturuldu." -ForegroundColor Cyan
    }
} else {
    Set-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name "WinOpsClientAgent" -Value "`"$InstallDir\run.cmd`"" -Force -ErrorAction SilentlyContinue
    Write-Host "[2/3] Kullanıcı başlangıç kaydı oluşturuldu." -ForegroundColor Cyan
}

Start-Process -FilePath "cmd.exe" -ArgumentList "/c `"$InstallDir\run.cmd`"" -WindowStyle Hidden

Write-Host "[3/3] Başarıyla Eklendi! Sunucu Sıra Numarası: $ClientId" -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Cyan
