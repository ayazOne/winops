<#
.SYNOPSIS
    WinOps Sunucu Kurulum Otomasyonu
    Sunucu dosyalarını C:\WinOps\Server dizinine kurar ve servisi başlatır.
#>

[CmdletBinding()]
param (
    [Parameter(Mandatory = $false)]
    [int]$Port = 3000,

    [Parameter(Mandatory = $false)]
    [string]$TelegramBotToken = "",

    [Parameter(Mandatory = $false)]
    [string]$TelegramChatId = ""
)

$ErrorActionPreference = "Stop"

Write-Host "==========================================" -ForegroundColor Green
Write-Host "  WinOps Yönetim Sunucusu Kuruluyor...    " -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Green

# 1. Node.js Kontrolü
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Warning "Node.js sistemde bulunamadı. Winget ile otomatik kuruluyor..."
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        winget install OpenJS.NodeJS -e --silent --accept-package-agreements --accept-source-agreements
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
    } else {
        throw "Node.js kurulu değil. Lütfen https://nodejs.org adresinden yükleyin."
    }
}

$InstallDir = "C:\WinOps\Server"
if (-not (Test-Path $InstallDir)) {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
}

# Çevre değişkenleri (.env / bat hazırlığı)
$envScript = @"
@echo off
set PORT=$Port
set TELEGRAM_BOT_TOKEN=$TelegramBotToken
set TELEGRAM_CHAT_ID=$TelegramChatId
node "$InstallDir\server.js"
"@
Set-Content -Path "$InstallDir\start.bat" -Value $envScript -Encoding UTF8

Write-Host "[1/3] Sunucu dizini hazırlandı: $InstallDir" -ForegroundColor Cyan

# Sunucu dosyasını kopyala / indir
$serverJsPath = "$InstallDir\server.js"
if (-not (Test-Path $serverJsPath)) {
    # Eğer doğrudan bu repo içindeyse kopyala
    if (Test-Path "$PSScriptRoot\server.js") {
        Copy-Item -Path "$PSScriptRoot\server.js" -Destination $serverJsPath -Force
    }
}

# 2. Windows Zamanlanmış Görev Olarak Ekle (Arka planda kalıcı çalışması için)
$TaskName = "WinOpsServerService"
$Action = New-ScheduledTaskAction -Execute "$InstallDir\start.bat"
$Trigger = New-ScheduledTaskTrigger -AtStartup
$Principal = New-ScheduledTaskPrincipal -UserId "NT AUTHORITY\SYSTEM" -LogonType ServiceAccount -RunLevel Highest

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Principal $Principal | Out-Null
Start-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue

Write-Host "[2/3] Zamanlanmış Görev ($TaskName) oluşturuldu ve başlatıldı." -ForegroundColor Cyan
Write-Host "[3/3] Kurulum Tamamlandı!" -ForegroundColor Green
Write-Host ""
Write-Host "Yönetim Paneline Erişin: http://localhost:$Port" -ForegroundColor Yellow
Write-Host "==========================================" -ForegroundColor Green
