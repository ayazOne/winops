param (
    [string]$ServerUrl = "http://127.0.0.1:3000",
    [string]$ClientId = $env:COMPUTERNAME
)

Write-Host ">>> WinOps İstemcisi Kuruluyor ($ClientId) -> $ServerUrl" -ForegroundColor Cyan
$InstallDir = "C:\WinOps\Client"
New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null

$agentCode = @'
<#
.SYNOPSIS
    WinOps Client Maintenance Agent
    Kurumsal Windows istemcileri için güvenli bakım ve senkronizasyon istemcisi.
#>

[CmdletBinding()]
param (
    [Parameter(Mandatory = $false)]
    [string]$ServerUrl = "http://127.0.0.1:3000",

    [Parameter(Mandatory = $false)]
    [string]$ClientId = $env:COMPUTERNAME,

    [Parameter(Mandatory = $false)]
    [int]$PollIntervalSeconds = 15
)

# TLS 1.2 zorunluluğu
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

Write-Host "=============================================" -ForegroundColor Cyan
Write-Host " WinOps İstemci Ajanı Başlatılıyor...        " -ForegroundColor Cyan
Write-Host " İstemci ID : $ClientId                      " -ForegroundColor Yellow
Write-Host " Sunucu URL : $ServerUrl                     " -ForegroundColor Yellow
Write-Host "=============================================" -ForegroundColor Cyan

function Get-LocalIPv4 {
    try {
        $ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.InterfaceAlias -notmatch 'Loopback|vEthernet' -and $_.IPAddress -notmatch '^169\.254\.' } | Select-Object -First 1).IPAddress
        if (-not $ip) { $ip = "127.0.0.1" }
        return $ip
    } catch {
        return "127.0.0.1"
    }
}

function Get-UptimeFormatted {
    try {
        $bootTime = (Get-CimInstance -ClassName Win32_OperatingSystem).LastBootUpTime
        $uptime = (Get-Date) - $bootTime
        return "{0}g {1}s {2}dk" -f $uptime.Days, $uptime.Hours, $uptime.Minutes
    } catch {
        return "Bilinmiyor"
    }
}

# --- Onaylı ve Güvenli Bakım Eylemleri (Whitelist Dispatcher) ---
function Invoke-MaintenanceAction {
    param (
        [string]$Action,
        [hashtable]$Params
    )

    $output = ""
    switch ($Action) {
        "sync-ntp" {
            Write-Host "[Bakım] NTP Saat Senkronizasyonu başlatılıyor..." -ForegroundColor Cyan
            try {
                # Windows Time servisini kontrol et ve başlat
                $svc = Get-Service -Name w32time -ErrorAction SilentlyContinue
                if ($svc.Status -ne 'Running') {
                    Start-Service -Name w32time -ErrorAction Stop
                }
                $res = & w32tm /resync /force 2>&1 | Out-String
                $output = "Saat Senkronizasyonu Başarılı:`n$res`nGüncel Sistem Saati: $((Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))"
            } catch {
                $output = "NTP Senkronizasyon Hatası: $($_.Exception.Message)"
            }
        }

        "clean-temp" {
            Write-Host "[Bakım] Geçici dosya & önbellek temizliği yapılıyor..." -ForegroundColor Cyan
            $cleanedCount = 0
            $tempPaths = @($env:TEMP, "C:\Windows\Temp")
            
            foreach ($path in $tempPaths) {
                if (Test-Path $path) {
                    Get-ChildItem -Path $path -Recurse -Force -ErrorAction SilentlyContinue | ForEach-Object {
                        try {
                            Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction Stop
                            $cleanedCount++
                        } catch {
                            # Kilitli veya kullanılan dosyalar atlanır
                        }
                    }
                }
            }
            $output = "Önbellek temizliği tamamlandı. Temizlenen dosya/klasör sayısı: $cleanedCount"
        }

        "restart-service" {
            $serviceName = $Params["serviceName"]
            if ([string]::IsNullOrWhiteSpace($serviceName) -or $serviceName -match '[^a-zA-Z0-9_\-]') {
                $output = "Hata: Geçersiz servis adı formatı!"
            } else {
                Write-Host "[Bakım] Servis yeniden başlatılıyor: $serviceName" -ForegroundColor Cyan
                try {
                    Restart-Service -Name $serviceName -Force -ErrorAction Stop
                    $output = "Servis '$serviceName' başarıyla yeniden başlatıldı. Durum: $((Get-Service -Name $serviceName).Status)"
                } catch {
                    $output = "Servis başlatma başarısız: $($_.Exception.Message)"
                }
            }
        }

        "sys-info" {
            Write-Host "[Bakım] Sistem bilgisi toplanıyor..." -ForegroundColor Cyan
            try {
                $os = (Get-CimInstance Win32_OperatingSystem).Caption
                $cpu = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
                $osInfo = Get-CimInstance Win32_OperatingSystem
                $freeRamMB = [math]::Round($osInfo.FreePhysicalMemory / 1024, 2)
                $totalRamMB = [math]::Round($osInfo.TotalVisibleMemorySize / 1024, 2)
                $disk = Get-PSDrive C | Select-Object @{Name="FreeGB";Expression={[math]::Round($_.Free/1GB,2)}}, @{Name="UsedGB";Expression={[math]::Round($_.Used/1GB,2)}}

                $output = @"
İşletim Sistemi: $os
CPU Kullanımı   : %$cpu
RAM Durumu      : Boş: $freeRamMB MB / Toplam: $totalRamMB MB
C: Disk Durumu  : Boş: $($disk.FreeGB) GB / Kullanılan: $($disk.UsedGB) GB
Çalışma Süresi  : $(Get-UptimeFormatted)
"@
            } catch {
                $output = "Sistem bilgisi alınırken hata: $($_.Exception.Message)"
            }
        }

        default {
            $output = "Hata: '$Action' tanımlı veya izin verilen bir bakım eylemi değil!"
        }
    }

    return $output
}

# --- Ana Döngü (Heartbeat ve Görev Takibi) ---
while ($true) {
    try {
        # 1. Heartbeat Gönderimi
        $heartbeatData = @{
            clientId = $ClientId
            hostname = $env:COMPUTERNAME
            ip       = Get-LocalIPv4
            os       = (Get-CimInstance Win32_OperatingSystem).Caption
            uptime   = Get-UptimeFormatted
        } | ConvertTo-Json

        $null = Invoke-RestMethod -Uri "$ServerUrl/api/heartbeat" -Method POST -Body $heartbeatData -ContentType "application/json" -TimeoutSec 10 -ErrorAction Stop

        # 2. Görev Sorgulama (Poll)
        $pollUri = "$ServerUrl/api/tasks/poll?clientId=$([System.Web.HttpUtility]::UrlEncode($ClientId))"
        $pollResp = Invoke-RestMethod -Uri $pollUri -Method GET -TimeoutSec 10 -ErrorAction Stop

        if ($pollResp.hasTask -and $pollResp.task) {
            $task = $pollResp.task
            Write-Host "[GÖREV ALINDI] ID: $($task.id) | Eylem: $($task.action)" -ForegroundColor Green
            
            $paramHt = @{}
            if ($task.params) {
                $task.params.psobject.properties | ForEach-Object { $paramHt[$_.Name] = $_.Value }
            }

            # Onaylı eylemi çalıştır
            $taskResult = Invoke-MaintenanceAction -Action $task.action -Params $paramHt
            Write-Host "[GÖREV SONUCU] `n$taskResult" -ForegroundColor Gray

            # Sonucu Sunucuya Bildir
            $reportData = @{
                taskId    = $task.id
                clientId  = $ClientId
                status    = "completed"
                output    = $taskResult
            } | ConvertTo-Json

            $null = Invoke-RestMethod -Uri "$ServerUrl/api/tasks/result" -Method POST -Body $reportData -ContentType "application/json" -TimeoutSec 10 -ErrorAction SilentlyContinue
        }

    } catch {
        Write-Warning "[Bağlantı Hatası] Sunucuya ulaşılamadı ($ServerUrl): $($_.Exception.Message)"
    }

    Start-Sleep -Seconds $PollIntervalSeconds
}

'@

Set-Content -Path "$InstallDir\ClientAgent.ps1" -Value $agentCode -Encoding UTF8

$runCmd = @"
powershell.exe -ExecutionPolicy Bypass -NoProfile -WindowStyle Hidden -File "$InstallDir\ClientAgent.ps1" -ServerUrl "$ServerUrl" -ClientId "$ClientId"
"@
Set-Content -Path "$InstallDir\run.cmd" -Value $runCmd -Encoding ASCII

$TaskName = "WinOpsClientAgent"
$Action = New-ScheduledTaskAction -Execute "$InstallDir\run.cmd"
$Trigger = New-ScheduledTaskTrigger -AtStartup
$Principal = New-ScheduledTaskPrincipal -UserId "NT AUTHORITY\SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Principal $Principal -Settings $Settings | Out-Null
Start-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue

Write-Host ">>> İstemci kurulumu tamamlandı ve arka planda çalışmaya başladı!" -ForegroundColor Green
