<#
.SYNOPSIS
    WinOps Sunucu Kurulum Otomasyonu (Otonom Güncelleme & NOC Konsol)
#>

[CmdletBinding()]
param (
    [Parameter(Mandatory = $false)]
    [int]$Port = 3000,

    [Parameter(Mandatory = $false)]
    [string]$TelegramBotToken = "",

    [Parameter(Mandatory = $false)]
    [string]$TelegramChatId = "",

    [Parameter(Mandatory = $false)]
    [string]$GitHubRepo = "ayazOne/winops"
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

Write-Host "==========================================" -ForegroundColor Green
Write-Host "  WinOps Sunucu Kuruluyor (GitHub: $GitHubRepo)" -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Green

# 1. Eski çalışan sunucu süreçlerini temizle (Port çakışmasını önlemek için)
$TaskName = "WinOpsServerService"
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue | Where-Object {
    $_.CommandLine -match "WinOps" -or $_.CommandLine -match "server\.js"
} | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}

# 2. Node.js Kontrolü
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Warning "Node.js sistemde bulunamadı. Winget ile kuruluyor..."
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        winget install OpenJS.NodeJS -e --silent --accept-package-agreements --accept-source-agreements
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
    } else {
        throw "Lütfen Node.js kurun: https://nodejs.org"
    }
}

$InstallDir = "C:\WinOps\Server"
if (-not (Test-Path $InstallDir)) {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
}

# 3. server.js dosyasını GitHub'dan indir
$rawServerUrl = "https://raw.githubusercontent.com/$GitHubRepo/main/server/server.js?t=$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())"
Write-Host "[1/4] Sunucu dosyaları GitHub'dan indiriliyor..." -ForegroundColor Cyan
Invoke-RestMethod -Uri $rawServerUrl -OutFile "$InstallDir\server.js"

# 4. Kendi Kendini Yeniden Başlatan (Self-Healing Loop) Başlatma Betiği
$envScript = @"
@echo off
set PORT=$Port
set GITHUB_REPO=$GitHubRepo
set TELEGRAM_BOT_TOKEN=$TelegramBotToken
set TELEGRAM_CHAT_ID=$TelegramChatId
:loop
node "$InstallDir\server.js"
timeout /t 2 /nobreak >nul
goto loop
"@
Set-Content -Path "$InstallDir\start.bat" -Value $envScript -Encoding ASCII

# 5. Masaüstü Kısayolu (Edge App Mode)
$launcherCmd = @"
@echo off
where msedge.exe >nul 2>&1
if %errorlevel% equ 0 (
    start msedge.exe --app=http://localhost:$Port
) else (
    start http://localhost:$Port
)
"@
Set-Content -Path "$InstallDir\Open-Dashboard.cmd" -Value $launcherCmd -Encoding ASCII

$desktopPath = [Environment]::GetFolderPath("Desktop")
if ($desktopPath -and (Test-Path $desktopPath)) {
    Copy-Item -Path "$InstallDir\Open-Dashboard.cmd" -Destination "$desktopPath\WinOps Takip Konsolu.cmd" -Force
}

# 6. Windows Görevini Ayarla ve Başlat
$Action = New-ScheduledTaskAction -Execute "$InstallDir\start.bat"
$Trigger = New-ScheduledTaskTrigger -AtStartup
$Principal = New-ScheduledTaskPrincipal -UserId "NT AUTHORITY\SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Principal $Principal -Settings $Settings | Out-Null
Start-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue

Write-Host "[2/4] Güvenlik duvarı kuralı ekleniyor (Port $Port)..." -ForegroundColor Cyan
New-NetFirewallRule -DisplayName "WinOps Server $Port" -Direction Inbound -LocalPort $Port -Protocol TCP -Action Allow -ErrorAction SilentlyContinue | Out-Null

Write-Host "[3/4] Masaüstüne 'WinOps Takip Konsolu' kısayolu eklendi!" -ForegroundColor Cyan
Write-Host "[4/4] Sunucu başarıyla kuruldu ve otonom güncelleme aktif edildi!" -ForegroundColor Green

# Takip ekranını otomatik aç
Start-Sleep -Seconds 2
& "$InstallDir\Open-Dashboard.cmd"

Write-Host "Panel: http://localhost:$Port" -ForegroundColor Yellow
Write-Host "==========================================" -ForegroundColor Green
