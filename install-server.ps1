<#
.SYNOPSIS
    WinOps Sunucu Kurulum Otomasyonu (Port 3001 - Zero-Cache 10sn Otonom Güncelleme)
#>

[CmdletBinding()]
param (
    [Parameter(Mandatory = $false)]
    [int]$Port = 3001,

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
Write-Host "  WinOps Sunucu Kuruluyor (Port: $Port)"    -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Green

# 1. Yalnızca eski WinOps süreçlerini kapat (Diğer Node.js servislerine / Port 3000'e dokunmaz!)
$TaskName = "WinOpsServerService"
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue

Get-CimInstance Win32_Process -Filter "Name = 'cmd.exe' OR Name = 'node.exe'" -ErrorAction SilentlyContinue | Where-Object {
    $_.CommandLine -match "C:\\WinOps\\Server"
} | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 1

# 2. Node.js Kontrolü ve Tam Yolu
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Warning "Node.js sistemde bulunamadı. Winget ile kuruluyor..."
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        winget install OpenJS.NodeJS -e --silent --accept-package-agreements --accept-source-agreements
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
    } else {
        throw "Lütfen Node.js kurun: https://nodejs.org"
    }
}
$nodeExe = (Get-Command node).Source

$InstallDir = "C:\WinOps\Server"
if (-not (Test-Path $InstallDir)) {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
}

# 3. GitHub CDN önbelleğini aşmak için en son Commit SHA'yı al (0sn gecikme)
$commitSha = "main"
try {
    $refsResp = Invoke-WebRequest -Uri "https://github.com/$GitHubRepo/info/refs?service=git-upload-pack&t=$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())" -UseBasicParsing -TimeoutSec 8
    $refsText = if ($refsResp.Content -is [byte[]]) { [System.Text.Encoding]::ASCII.GetString($refsResp.Content) } else { [string]$refsResp.Content }
    if ($refsText -match '([0-9a-f]{40})\s+refs/heads/main') {
        $commitSha = $Matches[1]
    }
} catch {}

$rawServerUrl = "https://raw.githubusercontent.com/$GitHubRepo/$commitSha/server/server.js?t=$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
Write-Host "[1/4] En güncel sunucu kodu indiriliyor (Commit: $($commitSha.Substring(0, [Math]::Min(7, $commitSha.Length))))..." -ForegroundColor Cyan
Invoke-RestMethod -Uri $rawServerUrl -OutFile "$InstallDir\server.js"

# 4. Kendi Kendini Yeniden Başlatan (1sn Self-Healing Loop) Başlatma Betiği
$envScript = @"
@echo off
set PORT=$Port
set GITHUB_REPO=$GitHubRepo
set TELEGRAM_BOT_TOKEN=$TelegramBotToken
set TELEGRAM_CHAT_ID=$TelegramChatId
:loop
"$nodeExe" "$InstallDir\server.js"
timeout /t 1 /nobreak >nul
goto loop
"@
Set-Content -Path "$InstallDir\start.bat" -Value $envScript -Encoding ASCII

# 5. Masaüstü Kısayolu
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

# 6. Windows Görevini Ayarla ve Arka Planda Hemen Başlat
$Action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$InstallDir\start.bat`""
$Trigger = New-ScheduledTaskTrigger -AtStartup
$Principal = New-ScheduledTaskPrincipal -UserId "NT AUTHORITY\SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Principal $Principal -Settings $Settings | Out-Null
Start-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue

Start-Sleep -Seconds 1
if (-not (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) {
    Start-Process -FilePath "cmd.exe" -ArgumentList "/c `"$InstallDir\start.bat`"" -WindowStyle Hidden
}

Write-Host "[2/4] Güvenlik duvarı kuralı ekleniyor (Port $Port)..." -ForegroundColor Cyan
New-NetFirewallRule -DisplayName "WinOps Server $Port" -Direction Inbound -LocalPort $Port -Protocol TCP -Action Allow -ErrorAction SilentlyContinue | Out-Null

Write-Host "[3/4] Masaüstüne 'WinOps Takip Konsolu' kısayolu eklendi!" -ForegroundColor Cyan
Write-Host "[4/4] Sunucu Port $Port üzerinde başlatıldı! 10sn otonom GitHub güncellemesi aktif!" -ForegroundColor Green

Start-Sleep -Seconds 2
& "$InstallDir\Open-Dashboard.cmd"

Write-Host "Panel: http://localhost:$Port" -ForegroundColor Yellow
Write-Host "==========================================" -ForegroundColor Green
