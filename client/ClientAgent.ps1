<#
.SYNOPSIS
    WinOps Client Maintenance & Real-Time Clock Sync Agent (v1.8.0)
    %100 Arka Plan (Zero-Window VBS), Düşük CPU (Zero-WMI Loop) & Sıralı Kayıt Ajanı
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
    [int]$PollIntervalSeconds = 4,

    [Parameter(Mandatory = $false)]
    [string]$GitHubRepo = "ayazOne/winops",

    [Parameter(Mandatory = $false)]
    [switch]$SilentMode
)

$AgentVersion = "1.8.0"
$BaseDir = if ($PSScriptRoot) { $PSScriptRoot } elseif (Test-Path "C:\WinOps\Client") { "C:\WinOps\Client" } else { "$env:LOCALAPPDATA\WinOps\Client" }
$AuthFilePath = "$BaseDir\client-auth.json"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# 1. Eski run.cmd döngüsünü etkisiz hale getir (sürekli pencere açmasını anında durdur)
$legacyRunCmd = "$BaseDir\run.cmd"
if (Test-Path $legacyRunCmd) {
    try {
        Set-Content -Path $legacyRunCmd -Value "@echo off`r`nexit /b 0" -Encoding ASCII -Force -ErrorAction SilentlyContinue
    } catch {}
}

# 2. Tamamen görünmez (0 pencere) VBS başlatıcısını oluştur
$vbsPath = "$BaseDir\silent-runner.vbs"
$vbsContent = @"
Set fso = CreateObject("Scripting.FileSystemObject")
baseDir = fso.GetParentFolderName(WScript.ScriptFullName)
scriptPath = baseDir & "\ClientAgent.ps1"
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & scriptPath & """ -ServerUrl ""$ServerUrl"" -GitHubRepo ""$GitHubRepo"" -SilentMode", 0, False
"@
try {
    Set-Content -Path $vbsPath -Value $vbsContent -Encoding ASCII -Force -ErrorAction SilentlyContinue
} catch {}

# 3. Asılı kalmış tüm eski cmd.exe (run.cmd) ve diğer powershell.exe (ClientAgent.ps1) süreçlerini temizle
try {
    Get-CimInstance Win32_Process -Filter "Name = 'cmd.exe' OR Name = 'powershell.exe'" -ErrorAction SilentlyContinue | Where-Object {
        $_.ProcessId -ne $PID -and (
            $_.CommandLine -match 'ClientAgent\.ps1' -or
            $_.CommandLine -match 'WinOps\\Client\\run\.cmd'
        )
    } | ForEach-Object {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
} catch {}

# 4. Eğer görünür pencereli modda başlatıldıysa, görünmez VBS moduna geç ve bu pencereyi anında kapat
if (-not $SilentMode) {
    try {
        Set-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name "WinOpsClientAgent" -Value "wscript.exe //B //NoLogo `"$vbsPath`"" -Force -ErrorAction SilentlyContinue
    } catch {}
    Start-Process -FilePath "wscript.exe" -ArgumentList "//B //NoLogo `"$vbsPath`"" -WindowStyle Hidden
    Stop-Process -Id $PID -Force
    exit 0
}

# 5. İşlemci (CPU) önceliğini BelowNormal yap (sistemi ve oyunları/uygulamaları asla yormasın)
try {
    [System.Diagnostics.Process]::GetCurrentProcess().PriorityClass = [System.Diagnostics.ProcessPriorityClass]::BelowNormal
} catch {}

# 6. Tekil Çalışma Kilidi (Mutex) - Aynı anda birden fazla ajan çalışmasını kesin olarak engeller
$script:SingleInstanceMutex = New-Object System.Threading.Mutex($false, "Local\WinOpsClientAgentMutex_v18")
$hasHandle = $false
try {
    $hasHandle = $script:SingleInstanceMutex.WaitOne(0, $false)
} catch [System.Threading.AbandonedMutexException] {
    $hasHandle = $true
}
if (-not $hasHandle) {
    Stop-Process -Id $PID -Force
    exit 0
}

if (Test-Path $AuthFilePath) {
    try {
        $authObj = Get-Content $AuthFilePath -Raw | ConvertFrom-Json
        if ($authObj.clientId) { $ClientId = $authObj.clientId }
        if ($authObj.token) { $Token = $authObj.token }
    } catch {}
}

# Eğer token yoksa çık
if ([string]::IsNullOrWhiteSpace($Token)) {
    try {
        $script:SingleInstanceMutex.ReleaseMutex()
        $script:SingleInstanceMutex.Dispose()
    } catch {}
    Stop-Process -Id $PID -Force
    exit 0
}

function Get-LocalIPv4 {
    try {
        $addrs = [System.Net.Dns]::GetHostAddresses([System.Net.Dns]::GetHostName()) | Where-Object {
            $_.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork -and
            $_.IPAddressToString -ne '127.0.0.1' -and
            $_.IPAddressToString -notmatch '^169\.254\.'
        }
        if ($addrs) {
            return $addrs[0].IPAddressToString
        }
    } catch {}
    return "127.0.0.1"
}

$script:BootTime = try { (Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop).LastBootUpTime } catch { (Get-Date).AddHours(-1) }
$cachedOsCaption = try { (Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop).Caption } catch { "Windows" }
$cachedIp = Get-LocalIPv4
$cachedTz = try { (Get-TimeZone).Id } catch { "Local" }
$script:LastUpdateAttempt = [DateTime]::MinValue

function Get-UptimeFormatted {
    try {
        $uptime = (Get-Date) - $script:BootTime
        return "{0}g {1}s {2}dk" -f $uptime.Days, $uptime.Hours, $uptime.Minutes
    } catch {
        return "Bilinmiyor"
    }
}

function Get-LatestGitHubCommitSha {
    try {
        $uri = "https://github.com/$GitHubRepo/info/refs?service=git-upload-pack&t=$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
        $resp = Invoke-WebRequest -Uri $uri -Headers @{ "User-Agent" = "git/2.40.0" } -UseBasicParsing -TimeoutSec 8 -ErrorAction Stop
        $text = if ($resp.Content -is [byte[]]) { [System.Text.Encoding]::ASCII.GetString($resp.Content) } else { [string]$resp.Content }
        if ($text -match '([0-9a-f]{40})\s+refs/heads/main') {
            return $Matches[1]
        }
    } catch {}
    return "main"
}

function Invoke-AgentSelfUpdate {
    param (
        [string]$CommitSha = "",
        [switch]$ForceCheck
    )
    try {
        if (-not $ForceCheck -and ((Get-Date).Subtract($script:LastUpdateAttempt).TotalSeconds -lt 45)) {
            return "OTA bekleme süresinde."
        }
        $script:LastUpdateAttempt = Get-Date

        $ref = if ([string]::IsNullOrWhiteSpace($CommitSha)) { Get-LatestGitHubCommitSha } else { $CommitSha }
        $versionUrl = "https://raw.githubusercontent.com/$GitHubRepo/$ref/version.json?t=$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
        $remoteMeta = Invoke-RestMethod -Uri $versionUrl -TimeoutSec 8 -ErrorAction Stop

        if ($remoteMeta.clientVersion -and ($remoteMeta.clientVersion -ne $AgentVersion)) {
            $remoteScriptUrl = "https://raw.githubusercontent.com/$GitHubRepo/$ref/client/ClientAgent.ps1?t=$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
            $tempFile = "$env:TEMP\ClientAgent_new.ps1"
            Invoke-RestMethod -Uri $remoteScriptUrl -OutFile $tempFile -TimeoutSec 12 -ErrorAction Stop

            $rawNewScript = Get-Content $tempFile -Raw -ErrorAction Stop

            # Sonsuz güncelleme döngüsü koruması: İndirilen dosyadaki sürüm mevcut sürümle aynıysa yeniden başlatma!
            if ($rawNewScript -match '\$AgentVersion\s*=\s*"([^"]+)"') {
                if ($Matches[1] -eq $AgentVersion) {
                    Remove-Item $tempFile -Force -ErrorAction SilentlyContinue
                    return "İndirilen dosya sürümü ($($Matches[1])) zaten çalışıyor."
                }
            }

            $errors = $null
            [System.Management.Automation.PSParser]::Tokenize($rawNewScript, [ref]$errors) | Out-Null
            if ($errors.Count -gt 0) {
                Remove-Item $tempFile -Force -ErrorAction SilentlyContinue
                return "Güncelleme iptal edildi: Sözdizimi hatası."
            }

            $currentScriptPath = "$BaseDir\ClientAgent.ps1"
            Copy-Item -Path $tempFile -Destination $currentScriptPath -Force
            Remove-Item $tempFile -Force -ErrorAction SilentlyContinue

            try {
                if ($script:SingleInstanceMutex) {
                    $script:SingleInstanceMutex.ReleaseMutex()
                    $script:SingleInstanceMutex.Dispose()
                }
            } catch {}

            Start-Process -FilePath "wscript.exe" -ArgumentList "//B //NoLogo `"$vbsPath`"" -WindowStyle Hidden
            Stop-Process -Id $PID -Force
            exit 0
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
            $output = Invoke-AgentSelfUpdate -ForceCheck
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
                $cpu = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
                $osInfo = Get-CimInstance Win32_OperatingSystem
                $freeRamMB = [math]::Round($osInfo.FreePhysicalMemory / 1024, 2)
                $totalRamMB = [math]::Round($osInfo.TotalVisibleMemorySize / 1024, 2)
                $disk = Get-PSDrive C | Select-Object @{Name="FreeGB";Expression={[math]::Round($_.Free/1GB,2)}}, @{Name="UsedGB";Expression={[math]::Round($_.Used/1GB,2)}}

                $output = @"
İstemci Adı     : $ClientId
Ajan Sürümü     : v$AgentVersion
Sistem Saati    : $((Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))
İşletim Sistemi : $cachedOsCaption
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

$lastIpRefresh = Get-Date

while ($true) {
    try {
        $now = Get-Date

        # IP adresini yalnızca 5 dakikada bir hafif .NET DNS ile yenile (WMI kullanmaz)
        if ($now.Subtract($lastIpRefresh).TotalSeconds -ge 300) {
            $lastIpRefresh = $now
            $cachedIp = Get-LocalIPv4
        }

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
            try {
                $script:SingleInstanceMutex.ReleaseMutex()
                $script:SingleInstanceMutex.Dispose()
            } catch {}
            Stop-Process -Id $PID -Force
            exit 0
        }

        # Sunucudan isim değiştirildiyse yerel kimliği güncelle
        if ($hbResp.assignedClientId -and ($hbResp.assignedClientId -ne $ClientId)) {
            $ClientId = $hbResp.assignedClientId
            $newAuth = @{ clientId = $ClientId; token = $Token } | ConvertTo-Json
            Set-Content -Path $AuthFilePath -Value $newAuth -Encoding UTF8 -Force -ErrorAction SilentlyContinue
        }

        # Yalnızca sunucu yeni bir sürüm bildirdiğinde OTA güncellemesini tetikle (gereksiz GitHub sorgularını önler)
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

    } catch {
        # Sunucuya ulaşılamıyorsa 60 saniyede bir doğrudan GitHub üzerinden kurtarma güncellemesi kontrol et
        if ((Get-Date).Subtract($script:LastUpdateAttempt).TotalSeconds -ge 60) {
            $null = Invoke-AgentSelfUpdate
        }
    }

    Start-Sleep -Seconds $PollIntervalSeconds
}
