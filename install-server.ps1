<#
.SYNOPSIS
    WinOps Sunucu Kurulum Otomasyonu (GitHub Raw Bootstrap)
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

# 1. Node.js Kontrolü
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

# 2. server.js dosyasını GitHub'dan indir
$rawServerUrl = "https://raw.githubusercontent.com/$GitHubRepo/main/server/server.js?t=$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())"
Write-Host "[1/3] Sunucu dosyaları GitHub'dan indiriliyor..." -ForegroundColor Cyan
Invoke-RestMethod -Uri $rawServerUrl -OutFile "$InstallDir\server.js"

# 3. Başlatma Betiği
$envScript = @"
@echo off
set PORT=$Port
set GITHUB_REPO=$GitHubRepo
set TELEGRAM_BOT_TOKEN=$TelegramBotToken
set TELEGRAM_CHAT_ID=$TelegramChatId
node "$InstallDir\server.js"
"@
Set-Content -Path "$InstallDir\start.bat" -Value $envScript -Encoding UTF8

# 4. Windows Görevini Ayarla (Açılışta çalışması için)
$TaskName = "WinOpsServerService"
$Action = New-ScheduledTaskAction -Execute "$InstallDir\start.bat"
$Trigger = New-ScheduledTaskTrigger -AtStartup
$Principal = New-ScheduledTaskPrincipal -UserId "NT AUTHORITY\SYSTEM" -LogonType ServiceAccount -RunLevel Highest

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Principal $Principal | Out-Null
Start-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue

Write-Host "[2/3] Güvenlik duvarı kuralı ekleniyor (Port $Port)..." -ForegroundColor Cyan
New-NetFirewallRule -DisplayName "WinOps Server $Port" -Direction Inbound -LocalPort $Port -Protocol TCP -Action Allow -ErrorAction SilentlyContinue | Out-Null

Write-Host "[3/3] Sunucu başarıyla kuruldu ve başlatıldı!" -ForegroundColor Green
Write-Host "Panel: http://localhost:$Port" -ForegroundColor Yellow
Write-Host "==========================================" -ForegroundColor Green
