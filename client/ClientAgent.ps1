<#
.SYNOPSIS
    WinOps Client Maintenance & Real-Time Clock Sync Agent (v1.3.0)
    10-Saniyelik Zero-Cache GitHub OTA Güncelleme & Anlık Saat Kontrolü
#>

[CmdletBinding()]
param (
    [Parameter(Mandatory = $false)]
    [string]$ServerUrl = "http://127.0.0.1:3000",

    [Parameter(Mandatory = $false)]
    [string]$ClientId = $env:COMPUTERNAME,

    [Parameter(Mandatory = $false)]
    [int]$PollIntervalSeconds = 3,

    [Parameter(Mandatory = $false)]
    [string]$GitHubRepo = "ayazOne/winops"
)

$AgentVersion = "1.3.0"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

Write-Host "=============================================" -ForegroundColor Cyan
Write-Host " WinOps İstemci Ajanı (v$AgentVersion) Başlatılıyor... " -ForegroundColor Cyan
Write-Host " İstemci ID  : $ClientId                     " -ForegroundColor Yellow
Write-Host " Sunucu URL  : $ServerUrl                    " -ForegroundColor Yellow
Write-Host " GitHub Repo : $GitHubRepo                   " -ForegroundColor Yellow
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

function Get-LatestGitHubCommitSha {
    try {
        $uri = "https://github.com/$GitHubRepo/info/refs?service=git-upload-pack&t=$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
        $resp = Invoke-WebRequest -Uri $uri -UseBasicParsing -TimeoutSec 8 -ErrorAction Stop
        $text = if ($resp.Content -is [byte[]]) { [System.Text.Encoding]::ASCII.GetString($resp.Content) } else { [string]$resp.Content }
        if ($text -match '([0-9a-f]{40})\s+refs/heads/main') {
            return $Matches[1]
        }
    } catch {}
    return "main"
}

# --- GitHub OTA Otonom Güncelleme (0sn Cache, 10sn Kontrol) ---
function Invoke-AgentSelfUpdate {
    param (
        [string]$CommitSha = ""
    )
    try {
        $ref = if ([string]::IsNullOrWhiteSpace($CommitSha)) { Get-LatestGitHubCommitSha } else { $CommitSha }
        $versionUrl = "https://raw.githubusercontent.com/$GitHubRepo/$ref/version.json?t=$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
        $remoteMeta = Invoke-RestMethod -Uri $versionUrl -TimeoutSec 8 -ErrorAction Stop

        if ($remoteMeta.clientVersion -and ($remoteMeta.clientVersion -ne $AgentVersion)) {
            Write-Host "[OTA] Yeni sürüm algılandı: v$($remoteMeta.clientVersion) (Mevcut: v$AgentVersion). Otomatik indiriliyor..." -ForegroundColor Green
            
            $remoteScriptUrl = "https://raw.githubusercontent.com/$GitHubRepo/$ref/client/ClientAgent.ps1?t=$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
            $tempFile = "$env:TEMP\ClientAgent_new.ps1"
            Invoke-RestMethod -Uri $remoteScriptUrl -OutFile $tempFile -TimeoutSec 12 -ErrorAction Stop

            $errors = $null
            [System.Management.Automation.PSParser]::Tokenize((Get-Content $tempFile -Raw), [ref]$errors) | Out-Null
            if ($errors.Count -gt 0) {
                Remove-Item $tempFile -Force -ErrorAction SilentlyContinue
                return "Güncelleme iptal edildi: Sözdizimi hatası."
            }

            $currentScriptPath = "C:\WinOps\Client\ClientAgent.ps1"
            Copy-Item -Path $tempFile -Destination $currentScriptPath -Force
            Remove-Item $tempFile -Force -ErrorAction SilentlyContinue

            Write-Host "[OTA] Güncelleme tamamlandı (v$($remoteMeta.clientVersion)). Yeniden başlatılıyor..." -ForegroundColor Green
            
            Start-Process powershell.exe -ArgumentList "-ExecutionPolicy Bypass -NoProfile -WindowStyle Hidden -File `"$currentScriptPath`" -ServerUrl `"$ServerUrl`" -ClientId `"$ClientId`" -GitHubRepo `"$GitHubRepo`""
            Start-Sleep -Seconds 1
            Stop-Process -Id $PID -Force
            return "İstemci v$($remoteMeta.clientVersion) sürümüne güncellendi."
        } else {
            return "İstemci güncel (v$AgentVersion)."
        }
    } catch {
        return "OTA kontrol hatası: $($_.Exception.Message)"
    }
}

# --- Onaylı Saat ve Bakım Eylemleri ---
function Invoke-MaintenanceAction {
    param (
        [string]$Action,
        [hashtable]$Params
    )

    $output = ""
    switch ($Action) {
        "update-agent" {
            $output = Invoke-AgentSelfUpdate
        }

        "sync-ntp" {
            try {
                $svc = Get-Service -Name w32time -ErrorAction SilentlyContinue
                if ($svc.Status -ne 'Running') {
                    Start-Service -Name w32time -ErrorAction SilentlyContinue
                }
                & w32tm /config /manualpeerlist:"time.windows.com,0x9 pool.ntp.org,0x9" /syncfromflags:manual /reliable:YES /update 2>&1 | Out-Null
                $res = & w32tm /resync /force 2>&1 | Out-String
                $output = "NTP Senkronizasyonu Tamamlandı.`nYeni İstemci Saati: $((Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))`nDetay: $($res.Trim())"
            } catch {
                $output = "NTP Senkronizasyon Hatası: $($_.Exception.Message)"
            }
        }

        "sync-server-time" {
            try {
                $serverEpochMs = [int64]$Params["serverEpochMs"]
                if ($serverEpochMs -gt 0) {
                    $targetUtc = [DateTimeOffset]::FromUnixTimeMilliseconds($serverEpochMs).UtcDateTime
                    $targetLocal = $targetUtc.ToLocalTime()
                    Set-Date -Date $targetLocal -ErrorAction Stop | Out-Null
                    $output = "İstemci saati sunucu saatine eşitlendi!`nYeni Saat: $((Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))"
                } else {
                    $output = "Hata: Geçersiz sunucu zaman damgası."
                }
            } catch {
                $output = "Saat eşitleme hatası: $($_.Exception.Message)"
            }
        }

        "set-custom-time" {
            try {
                $timeStr = $Params["timeString"]
                $offsetMinutes = $Params["offsetMinutes"]

                if (-not [string]::IsNullOrWhiteSpace($timeStr)) {
                    $parsedDate = [DateTime]::Parse($timeStr)
                    Set-Date -Date $parsedDate -ErrorAction Stop | Out-Null
                    $output = "Saat manuel olarak ayarlandı: $((Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))"
                } elseif ($null -ne $offsetMinutes) {
                    $mins = [double]$offsetMinutes
                    $newDate = (Get-Date).AddMinutes($mins)
                    Set-Date -Date $newDate -ErrorAction Stop | Out-Null
                    $output = "Saat ($mins dk) kaydırıldı. Yeni Saat: $((Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))"
                } else {
                    $output = "Hata: Saat parametresi eksik."
                }
            } catch {
                $output = "Manuel saat ayarlama hatası: $($_.Exception.Message)"
            }
        }

        "clean-temp" {
            $cleanedCount = 0
            $tempPaths = @($env:TEMP, "C:\Windows\Temp")
            foreach ($path in $tempPaths) {
                if (Test-Path $path) {
                    Get-ChildItem -Path $path -Recurse -Force -ErrorAction SilentlyContinue | ForEach-Object {
                        try {
                            Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction Stop
                            $cleanedCount++
                        } catch {}
                    }
                }
            }
            $output = "Önbellek temizliği tamamlandı. Silinen öğe: $cleanedCount"
        }

        "restart-service" {
            $serviceName = $Params["serviceName"]
            if ([string]::IsNullOrWhiteSpace($serviceName) -or $serviceName -match '[^a-zA-Z0-9_\-]') {
                $output = "Hata: Geçersiz servis adı formatı!"
            } else {
                try {
                    Restart-Service -Name $serviceName -Force -ErrorAction Stop
                    $output = "Servis '$serviceName' yeniden başlatıldı. Durum: $((Get-Service -Name $serviceName).Status)"
                } catch {
                    $output = "Servis başlatma hatası: $($_.Exception.Message)"
                }
            }
        }

        "sys-info" {
            try {
                $os = (Get-CimInstance Win32_OperatingSystem).Caption
                $cpu = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
                $osInfo = Get-CimInstance Win32_OperatingSystem
                $freeRamMB = [math]::Round($osInfo.FreePhysicalMemory / 1024, 2)
                $totalRamMB = [math]::Round($osInfo.TotalVisibleMemorySize / 1024, 2)
                $disk = Get-PSDrive C | Select-Object @{Name="FreeGB";Expression={[math]::Round($_.Free/1GB,2)}}, @{Name="UsedGB";Expression={[math]::Round($_.Used/1GB,2)}}

                $output = @"
Ajan Sürümü     : v$AgentVersion
Sistem Saati    : $((Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))
İşletim Sistemi : $os
CPU Kullanımı   : %$cpu
RAM Durumu      : Boş: $freeRamMB MB / Toplam: $totalRamMB MB
C: Disk Durumu  : Boş: $($disk.FreeGB) GB / Kullanılan: $($disk.UsedGB) GB
Çalışma Süresi  : $(Get-UptimeFormatted)
"@
            } catch {
                $output = "Sistem bilgisi hatası: $($_.Exception.Message)"
            }
        }

        default {
            $output = "Hata: '$Action' tanımlı bir bakım eylemi değil!"
        }
    }

    return $output
}

$lastUpdateCheck = [DateTime]::MinValue
$cachedOsCaption = (Get-CimInstance Win32_OperatingSystem).Caption
$cachedIp = Get-LocalIPv4
$cachedTz = (Get-TimeZone).Id

# --- Ana Döngü (3sn Saat Senkron & 10sn GitHub OTA) ---
while ($true) {
    try {
        # Her 10 saniyede bir doğrudan GitHub OTA sürüm kontrolü (Zero-Cache)
        if ((Get-Date).Subtract($lastUpdateCheck).TotalSeconds -ge 10) {
            $lastUpdateCheck = Get-Date
            $cachedIp = Get-LocalIPv4
            $null = Invoke-AgentSelfUpdate
        }

        $now = Get-Date
        $epochMs = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()

        # 1. Heartbeat + Anlık Saat Gönderimi
        $heartbeatData = @{
            clientId   = $ClientId
            hostname   = $env:COMPUTERNAME
            ip         = $cachedIp
            os         = $cachedOsCaption
            uptime     = Get-UptimeFormatted
            version    = $AgentVersion
            systemTime = $now.ToString("HH:mm:ss")
            systemDate = $now.ToString("yyyy-MM-dd")
            epochMs    = $epochMs
            timeZone   = $cachedTz
        } | ConvertTo-Json

        $hbResp = Invoke-RestMethod -Uri "$ServerUrl/api/heartbeat" -Method POST -Body $heartbeatData -ContentType "application/json" -TimeoutSec 5 -ErrorAction Stop

        # Sunucu yeni bir sürüm olduğunu bildirirse 1sn beklemeden anında güncelle!
        if ($hbResp.expectedClientVersion -and ($hbResp.expectedClientVersion -ne $AgentVersion)) {
            $null = Invoke-AgentSelfUpdate -CommitSha $hbResp.commitSha
        }

        # 2. Görev Sorgulama (Poll)
        $pollUri = "$ServerUrl/api/tasks/poll?clientId=$([System.Web.HttpUtility]::UrlEncode($ClientId))"
        $pollResp = Invoke-RestMethod -Uri $pollUri -Method GET -TimeoutSec 5 -ErrorAction Stop

        if ($pollResp.hasTask -and $pollResp.task) {
            $task = $pollResp.task
            
            $paramHt = @{}
            if ($task.params) {
                $task.params.psobject.properties | ForEach-Object { $paramHt[$_.Name] = $_.Value }
            }

            $taskResult = Invoke-MaintenanceAction -Action $task.action -Params $paramHt

            $nowAfter = Get-Date
            $postHb = @{
                clientId   = $ClientId
                hostname   = $env:COMPUTERNAME
                ip         = $cachedIp
                os         = $cachedOsCaption
                uptime     = Get-UptimeFormatted
                version    = $AgentVersion
                systemTime = $nowAfter.ToString("HH:mm:ss")
                systemDate = $nowAfter.ToString("yyyy-MM-dd")
                epochMs    = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
                timeZone   = $cachedTz
            } | ConvertTo-Json
            $null = Invoke-RestMethod -Uri "$ServerUrl/api/heartbeat" -Method POST -Body $postHb -ContentType "application/json" -TimeoutSec 5 -ErrorAction SilentlyContinue

            $reportData = @{
                taskId    = $task.id
                clientId  = $ClientId
                status    = "completed"
                output    = $taskResult
            } | ConvertTo-Json

            $null = Invoke-RestMethod -Uri "$ServerUrl/api/tasks/result" -Method POST -Body $reportData -ContentType "application/json" -TimeoutSec 5 -ErrorAction SilentlyContinue
        }

    } catch {
        Write-Warning "[Bağlantı Hatası] ($ServerUrl): $($_.Exception.Message)"
    }

    Start-Sleep -Seconds $PollIntervalSeconds
}
