<#
.SYNOPSIS
    WinOps İstemci Kurulum Otomasyonu (v1.8.0)
    %100 Görünmez Arka Plan (Zero-Window VBS) & Düşük CPU Modu
#>

[CmdletBinding()]
param (
    [Parameter(Mandatory = $false)]
    [string]$ServerUrl = "http://51.195.176.183:3001",

    [Parameter(Mandatory = $false)]
    [string]$ClientId = "AUTO",

    [Parameter(Mandatory = $false)]
    [string]$GitHubRepo = "ayazOne/winops"
)

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

if ($env:CLIENT_ID -and ($ClientId -eq "AUTO" -or -not $ClientId)) {
    $ClientId = $env:CLIENT_ID
}

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

$InstallDir = "C:\WinOps\Client"
try {
    if (-not (Test-Path $InstallDir)) {
        New-Item -ItemType Directory -Path $InstallDir -Force -ErrorAction Stop | Out-Null
    }
    Set-Content -Path "$InstallDir\.write_test" -Value "ok" -Force -ErrorAction Stop
    Remove-Item "$InstallDir\.write_test" -Force -ErrorAction SilentlyContinue
} catch {
    $InstallDir = "$env:LOCALAPPDATA\WinOps\Client"
    if (-not (Test-Path $InstallDir)) {
        New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    }
}

# 1. Eski run.cmd döngüsünü etkisizleştir ve açık kalan tüm eski süreçleri kapat
$TaskName = "WinOpsClientAgent"
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue

foreach ($dir in @("C:\WinOps\Client", "$env:LOCALAPPDATA\WinOps\Client")) {
    if (Test-Path "$dir\run.cmd") {
        Set-Content -Path "$dir\run.cmd" -Value "@echo off`r`nexit /b 0" -Encoding ASCII -Force -ErrorAction SilentlyContinue
    }
}

Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe' OR Name = 'cmd.exe' OR Name = 'wscript.exe'" -ErrorAction SilentlyContinue | Where-Object {
    $_.ProcessId -ne $PID -and (
        $_.CommandLine -match "ClientAgent\.ps1" -or
        $_.CommandLine -match "WinOps\\Client\\run\.cmd" -or
        $_.CommandLine -match "silent-runner\.vbs"
    )
} | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}

# 2. Sunucudan Sıradaki Numarayı veya İstenen Numarayı (Örn: PC-12) Al
$escapedHost = [uri]::EscapeDataString($env:COMPUTERNAME)
$escapedClient = [uri]::EscapeDataString($ClientId)
$assignUri = "$ServerUrl/api/assign-id?hostname=$escapedHost&clientId=$escapedClient&t=$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
$assignResp = Invoke-RestMethod -Uri $assignUri -Method GET -TimeoutSec 10 -ErrorAction Stop

$ClientId = $assignResp.clientId
$Token = $assignResp.token

$authData = @{
    clientId = $ClientId
    token    = $Token
} | ConvertTo-Json
Set-Content -Path "$InstallDir\client-auth.json" -Value $authData -Encoding UTF8 -Force

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  WinOps İstemci Kurulumu -> $ClientId (v1.8.0)" -ForegroundColor Green
Write-Host "  Sunucu     : $ServerUrl"                 -ForegroundColor Yellow
Write-Host "  Çalışma Modu: %100 Görünmez Arka Plan (Zero-CPU)" -ForegroundColor Yellow
Write-Host "==========================================" -ForegroundColor Cyan

# 3. En güncel Commit SHA ile GitHub CDN önbelleğini aşarak indir
$commitSha = "main"
try {
    $refsResp = Invoke-WebRequest -Uri "https://github.com/$GitHubRepo/info/refs?service=git-upload-pack&t=$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())" -Headers @{ "User-Agent" = "git/2.40.0" } -UseBasicParsing -TimeoutSec 8
    $refsText = if ($refsResp.Content -is [byte[]]) { [System.Text.Encoding]::ASCII.GetString($refsResp.Content) } else { [string]$refsResp.Content }
    if ($refsText -match '([0-9a-f]{40})\s+refs/heads/main') {
        $commitSha = $Matches[1]
    }
} catch {}

$rawAgentUrl = "https://raw.githubusercontent.com/$GitHubRepo/$commitSha/client/ClientAgent.ps1?t=$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
Write-Host "[1/3] En güncel ajan betiği indiriliyor..." -ForegroundColor Cyan
Invoke-RestMethod -Uri $rawAgentUrl -OutFile "$InstallDir\ClientAgent.ps1"

# 4. Tamamen görünmez (penceresiz) VBS başlatıcısı oluştur
$vbsPath = "$InstallDir\silent-runner.vbs"
$vbsContent = @"
Set fso = CreateObject("Scripting.FileSystemObject")
baseDir = fso.GetParentFolderName(WScript.ScriptFullName)
scriptPath = baseDir & "\ClientAgent.ps1"
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & scriptPath & """ -ServerUrl ""$ServerUrl"" -GitHubRepo ""$GitHubRepo"" -SilentMode", 0, False
"@
Set-Content -Path $vbsPath -Value $vbsContent -Encoding ASCII -Force

# 5. Kalıcılık (Pencere açmayan wscript.exe //B ile)
if ($isAdmin) {
    try {
        $Action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "//B //NoLogo `"$vbsPath`""
        $Trigger = New-ScheduledTaskTrigger -AtStartup
        $Principal = New-ScheduledTaskPrincipal -UserId "NT AUTHORITY\SYSTEM" -LogonType ServiceAccount -RunLevel Highest
        $Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
        Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Principal $Principal -Settings $Settings -ErrorAction Stop | Out-Null
        Write-Host "[2/3] İstemci arka plan SYSTEM servisi olarak kaydedildi." -ForegroundColor Cyan
    } catch {
        Set-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name "WinOpsClientAgent" -Value "wscript.exe //B //NoLogo `"$vbsPath`"" -Force -ErrorAction SilentlyContinue
        Write-Host "[2/3] İstemci sessiz başlangıç kaydı oluşturuldu." -ForegroundColor Cyan
    }
} else {
    Set-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name "WinOpsClientAgent" -Value "wscript.exe //B //NoLogo `"$vbsPath`"" -Force -ErrorAction SilentlyContinue
    Write-Host "[2/3] Kullanıcı sessiz başlangıç kaydı oluşturuldu." -ForegroundColor Cyan
}

# 6. Ajanı tamamen görünmez olarak arka planda başlat
Start-Process -FilePath "wscript.exe" -ArgumentList "//B //NoLogo `"$vbsPath`"" -WindowStyle Hidden

Write-Host "[3/3] Başarıyla Eklendi ve Arka Planda Başlatıldı! Atanan İstemci: $ClientId" -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Cyan
