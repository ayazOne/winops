# WinOps - Enterprise Windows Client Management & Automation

Merkezi Windows istemci yönetimi, NTP saat senkronizasyonu, bakım otomasyonu ve GitHub tabanlı OTA (Over-The-Air) otomatik güncelleme platformu.

## 🚀 Hızlı Kurulum

### 1. Sunucu Kurulumu (Yönetici PowerShell):
```powershell
irm https://raw.githubusercontent.com/ayazOne/winops/main/install-server.ps1 | iex
```

### 2. İstemci Kurulumu (Yönetici PowerShell):
```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/ayazOne/winops/main/install-client.ps1))) -ServerUrl "http://51.195.176.183:3000" -ClientId "PC-01"
```

## 🔄 Otomatik Güncelleme (OTA)
GitHub üzerinde `version.json`, `server/server.js` veya `client/ClientAgent.ps1` güncellendiğinde:
* **İstemciler:** Kendilerini otomatik kontrol edip kesintisiz günceller veya web panelinden tek tıkla `"Tüm İstemcileri Güncelle"` emri verilebilir.
* **Sunucu:** Web panelinde `"Yeni sürüm mevcut"` bildirimi çıkar ve tek tıkla güncellenir.
