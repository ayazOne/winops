<#
.SYNOPSIS
    WinOps Client Maintenance & Real-Time Clock Sync Agent (v1.6.0)
    Sunucu Sıralı Kayıt (PC-01, PC-02, PC-03) & Token Doğrulamalı Ajan
#>

[CmdletBinding()]
param (
    [Parameter(Mandatory = $false)]
    [string]$ServerUrl = "http://51.195.176.183:3001",

    [Parameter(Mandatory = $false)]
    [string]$ClientId = "",

    [Parameter(Mandatory = $false)]
    [string]$Token = "",

    [Parameter(Mandatory = $false)]
    [int]$PollIntervalSeconds = 3,

    [Parameter(Mandatory = $false)]
    [string]$GitHubRepo = "ayazOne/winops"
)

$AgentVersion = "1.7.0"
$BaseDir = if ($PSScriptRoot) { $PSScriptRoot } elseif (Test-Path "C:\WinOps\Client") { "C:\WinOps\Client" } else { "$env:LOCALAPPDATA\WinOps\Client" }
$AuthFilePath = "$BaseDir\client-auth.json"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

if (Test-Path $AuthFilePath) {
    try {
        $authObj = Get-Content $AuthFilePath -Raw | ConvertFrom-Json
        if ($authObj.clientId) { $ClientId = $authObj.clientId }
        if ($authObj.token) { $Token = $authObj.token }
    } catch {}
}

# Eğer token yoksa (eski kurulumdan kalan ajan ise) çık, listeyi kirletme
if ([string]::IsNullOrWhiteSpace($Token)) {
    Stop-Process -Id $PID -Force
    exit 0
}

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

function Invoke-AgentSelfUpdate {
    param (
        [string]$CommitSha = ""
    )
    try {
        $ref = if ([string]::IsNullOrWhiteSpace($CommitSha)) { Get-LatestGitHubCommitSha } else { $CommitSha }
        $versionUrl = "https://raw.githubusercontent.com/$GitHubRepo/$ref/version.json?t=$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
        $remoteMeta = Invoke-RestMethod -Uri $versionUrl -TimeoutSec 8 -ErrorAction Stop

        if ($remoteMeta.clientVersion -and ($remoteMeta.clientVersion -ne $AgentVersion)) {
            $remoteScriptUrl = "https://raw.githubusercontent.com/$GitHubRepo/$ref/client/ClientAgent.ps1?t=$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
            $tempFile = "$env:TEMP\ClientAgent_new.ps1"
            Invoke-RestMethod -Uri $remoteScriptUrl -OutFile $tempFile -TimeoutSec 12 -ErrorAction Stop

            $errors = $null
            [System.Management.Automation.PSParser]::Tokenize((Get-Content $tempFile -Raw), [ref]$errors) | Out-Null
            if ($errors.Count -gt 0) {
                Remove-Item $tempFile -Force -ErrorAction SilentlyContinue
                return "Güncelleme iptal edildi: Sözdizimi hatası."
            }

            $currentScriptPath = "$BaseDir\ClientAgent.ps1"
            Copy-Item -Path $tempFile -Destination $currentScriptPath -Force
            Remove-Item $tempFile -Force -ErrorAction SilentlyContinue

            Start-Process powershell.exe -ArgumentList "-ExecutionPolicy Bypass -NoProfile -WindowStyle Hidden -File `"$currentScriptPath`" -ServerUrl `"$ServerUrl`" -ClientId `"$ClientId`" -Token `"$Token`" -GitHubRepo `"$GitHubRepo`""
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
            $output = "Önbellek temizliği tamamlandı. Silinen geçici öğe: $cleanedCount"
        }

        "flush-dns" {
            try {
                $res = & ipconfig /flushdns 2>&1 | Out-String
                $output = "DNS Önbelleği Temizlendi:`n$($res.Trim())"
            } catch {
                $output = "DNS temizleme hatası: $($_.Exception.Message)"
            }
        }

        "net-info" {
            try {
                $res = & ipconfig /all 2>&1 | Out-String
                $output = $res.Trim()
            } catch {
                $output = "Ağ bilgisi hatası: $($_.Exception.Message)"
            }
        }

        "process-list" {
            try {
                $procs = Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 15 Name, Id, @{Name="RAM_MB";Expression={[math]::Round($_.WorkingSet64 / 1MB, 1)}} | Format-Table -AutoSize | Out-String
                $output = "En Çok Bellek Kullanan 15 Süreç:`n$($procs.Trim())"
            } catch {
                $output = "Süreç listesi hatası: $($_.Exception.Message)"
            }
        }

        "gpupdate" {
            try {
                $res = & gpupdate /force /wait:0 2>&1 | Out-String
                $output = "Grup İlkeleri (GPO) Güncellendi:`n$($res.Trim())"
            } catch {
                $output = "GPO güncelleme hatası: $($_.Exception.Message)"
            }
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
İstemci Adı     : $ClientId
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

while ($true) {
    try {
        if ((Get-Date).Subtract($lastUpdateCheck).TotalSeconds -ge 10) {
            $lastUpdateCheck = Get-Date
            $cachedIp = Get-LocalIPv4
            $null = Invoke-AgentSelfUpdate
        }

        $now = Get-Date
        $epochMs = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()

        $heartbeatData = @{
            clientId   = $ClientId
            token      = $Token
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

        # Eğer sunucu listesi sıfırlandıysa veya bu cihaz listeden silindiyse çalışmayı durdur!
        if ($hbResp.unregistered) {
            Remove-Item $AuthFilePath -Force -ErrorAction SilentlyContinue
            Stop-Process -Id $PID -Force
            exit 0
        }

        # Sunucudan isim değiştirildiyse yerel kimliği güncelle
        if ($hbResp.assignedClientId -and ($hbResp.assignedClientId -ne $ClientId)) {
            $ClientId = $hbResp.assignedClientId
            $newAuth = @{ clientId = $ClientId; token = $Token } | ConvertTo-Json
            Set-Content -Path $AuthFilePath -Value $newAuth -Encoding UTF8 -Force -ErrorAction SilentlyContinue
        }

        if ($hbResp.expectedClientVersion -and ($hbResp.expectedClientVersion -ne $AgentVersion)) {
            $null = Invoke-AgentSelfUpdate -CommitSha $hbResp.commitSha
        }

        $pollUri = "$ServerUrl/api/tasks/poll?clientId=$([uri]::EscapeDataString($ClientId))"
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
                token      = $Token
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

    } catch {}

    Start-Sleep -Seconds $PollIntervalSeconds
}
