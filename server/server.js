/**
 * Enterprise Windows Management Server with Autonomous GitHub OTA & NOC Dashboard
 * Port: 3000
 * Zero external dependencies (native http, https, fs, path, crypto)
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SERVER_VERSION = '1.1.0';
const PORT = process.env.PORT || 3000;
const GITHUB_REPO = process.env.GITHUB_REPO || 'ayazOne/winops';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

// Storage
const clients = new Map();
const tasks = [];
const eventLogs = [];
const ALLOWED_ACTIONS = ['sync-ntp', 'clean-temp', 'restart-service', 'sys-info', 'update-agent'];

let remoteVersionCache = { serverVersion: SERVER_VERSION, clientVersion: '1.1.0', lastChecked: 0 };
let isUpdatingServer = false;

function addLog(type, message) {
  const logEntry = {
    id: Date.now() + Math.random().toString(36).substring(2, 6),
    time: new Date().toLocaleTimeString('tr-TR'),
    type,
    message
  };
  eventLogs.unshift(logEntry);
  if (eventLogs.length > 150) eventLogs.pop();
}

function sendTelegramNotification(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  const payload = JSON.stringify({
    chat_id: TELEGRAM_CHAT_ID,
    text: `🖥️ *WinOps Management Alert*\n\n${message}`,
    parse_mode: 'Markdown'
  });

  const req = https.request({
    hostname: 'api.telegram.org',
    path: `/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    }
  });
  req.on('error', (err) => console.error('[Telegram Error]:', err.message));
  req.write(payload);
  req.end();
}

function performServerSelfUpdate(newVersion) {
  if (isUpdatingServer) return;
  isUpdatingServer = true;
  addLog('system', `[OTA] Yeni sunucu sürümü algılandı (v${newVersion}). Otomatik indiriliyor...`);

  const rawUrl = `https://raw.githubusercontent.com/${GITHUB_REPO}/main/server/server.js?t=${Date.now()}`;
  https.get(rawUrl, (resp) => {
    let code = '';
    resp.on('data', c => { code += c; });
    resp.on('end', () => {
      if (resp.statusCode === 200 && code.includes('Enterprise Windows Management Server')) {
        try {
          const serverPath = path.join(__dirname, 'server.js');
          fs.writeFileSync(serverPath, code, 'utf8');
          addLog('system', `[OTA] Sunucu v${newVersion} sürümüne güncellendi. Yeniden başlatılıyor...`);
          sendTelegramNotification(`🔄 *Sunucu Otomatik Güncellendi (v${SERVER_VERSION} -> v${newVersion})*\nYeniden başlatılıyor...`);
          setTimeout(() => {
            process.exit(0); // start.bat döngüsü 2 saniye içinde otomatik yeniden başlatır
          }, 1500);
        } catch (err) {
          isUpdatingServer = false;
          addLog('error', `[OTA Hatası] Dosya yazılamadı: ${err.message}`);
        }
      } else {
        isUpdatingServer = false;
        addLog('error', `[OTA Hatası] GitHub'dan geçerli sunucu kodu alınamadı (HTTP ${resp.statusCode}).`);
      }
    });
  }).on('error', err => {
    isUpdatingServer = false;
    addLog('error', `[OTA Bağlantı Hatası] ${err.message}`);
  });
}

function checkGitHubVersionAndAutoUpdate() {
  const url = `https://raw.githubusercontent.com/${GITHUB_REPO}/main/version.json?t=${Date.now()}`;
  https.get(url, (res) => {
    let data = '';
    res.on('data', chunk => { data += chunk; });
    res.on('end', () => {
      try {
        if (res.statusCode !== 200) return;
        const parsed = JSON.parse(data);
        remoteVersionCache = {
          serverVersion: parsed.serverVersion || SERVER_VERSION,
          clientVersion: parsed.clientVersion || '1.1.0',
          lastChecked: new Date().toLocaleTimeString('tr-TR')
        };

        // Sunucu sürümü farklıysa otomatik güncelle
        if (parsed.serverVersion && parsed.serverVersion !== SERVER_VERSION) {
          performServerSelfUpdate(parsed.serverVersion);
        }
      } catch (e) {
        // JSON parse hatası yoksay
      }
    });
  }).on('error', () => {});
}

// Başlangıçta ve her 45 saniyede bir GitHub'ı kontrol et (Otomatik Güncelleme)
setTimeout(checkGitHubVersionAndAutoUpdate, 5000);
setInterval(checkGitHubVersionAndAutoUpdate, 45 * 1000);

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function jsonResponse(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // 1. Client Heartbeat
  if (req.method === 'POST' && pathname === '/api/heartbeat') {
    try {
      const data = await parseJsonBody(req);
      const clientId = data.clientId || req.socket.remoteAddress;
      const existing = clients.get(clientId);
      const isNew = !existing;
      const versionChanged = existing && existing.version !== data.version;

      const clientInfo = {
        id: clientId,
        hostname: data.hostname || 'Unknown',
        ip: data.ip || req.socket.remoteAddress,
        os: data.os || 'Windows',
        uptime: data.uptime || 'N/A',
        version: data.version || '1.0.0',
        lastSeen: new Date().toISOString()
      };
      
      clients.set(clientId, clientInfo);

      if (isNew) {
        addLog('join', `Yeni istemci bağlandı: [${clientId}] (${clientInfo.ip}) - v${clientInfo.version}`);
        sendTelegramNotification(`🟢 *Yeni İstemci Bağlandı:*\nID: \`${clientId}\`\nHost: ${clientInfo.hostname}\nIP: ${clientInfo.ip}\nVersiyon: v${clientInfo.version}`);
      } else if (versionChanged) {
        addLog('system', `İstemci [${clientId}] yeni sürüme güncellendi: v${existing.version} -> v${clientInfo.version}`);
        sendTelegramNotification(`✨ *İstemci Otomatik Güncellendi:*\nID: \`${clientId}\`\nYeni Sürüm: *v${clientInfo.version}*`);
      }

      return jsonResponse(res, 200, {
        success: true,
        registered: true,
        expectedClientVersion: remoteVersionCache.clientVersion
      });
    } catch (e) {
      return jsonResponse(res, 400, { error: e.message });
    }
  }

  // 2. Client Task Poll
  if (req.method === 'GET' && pathname === '/api/tasks/poll') {
    const clientId = url.searchParams.get('clientId');
    if (!clientId) return jsonResponse(res, 400, { error: 'clientId required' });

    const pendingTask = tasks.find(t => 
      (t.targetClientId === clientId || t.targetClientId === 'all') &&
      (!t.claimedBy || !t.claimedBy.includes(clientId)) &&
      t.status === 'pending'
    );

    if (pendingTask) {
      if (!pendingTask.claimedBy) pendingTask.claimedBy = [];
      pendingTask.claimedBy.push(clientId);
      if (pendingTask.targetClientId !== 'all') {
        pendingTask.status = 'in_progress';
      }
      addLog('task_start', `Görev iletildi: [${clientId}] -> ${pendingTask.action}`);
      return jsonResponse(res, 200, { hasTask: true, task: pendingTask });
    }

    return jsonResponse(res, 200, { hasTask: false });
  }

  // 3. Client Task Result
  if (req.method === 'POST' && pathname === '/api/tasks/result') {
    try {
      const { taskId, clientId, status, output } = await parseJsonBody(req);
      const task = tasks.find(t => t.id === taskId);
      if (task) {
        task.status = status;
        task.completedAt = new Date().toISOString();
        if (!task.results) task.results = {};
        task.results[clientId] = output;

        addLog('task_done', `Görev tamamlandı: [${clientId}] -> ${task.action} (${status})`);
        sendTelegramNotification(`⚡ *Görev Tamamlandı (${task.action}):*\nİstemci: \`${clientId}\`\nDurum: *${status}*\nÇıktı:\n\`\`\`\n${(output || '').slice(0, 500)}\n\`\`\``);
      }
      return jsonResponse(res, 200, { success: true });
    } catch (e) {
      return jsonResponse(res, 400, { error: e.message });
    }
  }

  // 4. Admin API: Dispatch Task
  if (req.method === 'POST' && pathname === '/api/tasks/dispatch') {
    try {
      const { targetClientId, action, params } = await parseJsonBody(req);
      if (!ALLOWED_ACTIONS.includes(action)) {
        return jsonResponse(res, 400, { error: `Geçersiz komut. İzin verilenler: ${ALLOWED_ACTIONS.join(', ')}` });
      }

      const newTask = {
        id: crypto.randomBytes(6).toString('hex'),
        targetClientId: targetClientId || 'all',
        action,
        params: params || {},
        status: 'pending',
        results: {},
        createdAt: new Date().toISOString()
      };

      tasks.unshift(newTask);
      if (tasks.length > 100) tasks.pop();

      addLog('dispatch', `Yeni görev kuyrukta: ${action} -> Hedef: [${newTask.targetClientId}]`);
      sendTelegramNotification(`🚀 *Yeni Görev Kuyrukta:*\nKomut: *${action}*\nHedef: \`${newTask.targetClientId}\``);
      return jsonResponse(res, 200, { success: true, task: newTask });
    } catch (e) {
      return jsonResponse(res, 400, { error: e.message });
    }
  }

  // 5. Force Immediate GitHub Check
  if (req.method === 'POST' && pathname === '/api/server/check-update') {
    checkGitHubVersionAndAutoUpdate();
    return jsonResponse(res, 200, { success: true });
  }

  // 6. Admin API: Dashboard Data
  if (req.method === 'GET' && pathname === '/api/dashboard-data') {
    const now = Date.now();
    let onlineCount = 0;
    const clientList = Array.from(clients.values()).map(c => {
      const diffSeconds = Math.floor((now - new Date(c.lastSeen).getTime()) / 1000);
      const isOnline = diffSeconds < 60;
      if (isOnline) onlineCount++;
      return {
        ...c,
        isOnline,
        diffSeconds
      };
    });

    return jsonResponse(res, 200, {
      clients: clientList,
      stats: {
        total: clientList.length,
        online: onlineCount,
        offline: clientList.length - onlineCount,
        totalTasks: tasks.length
      },
      tasks: tasks.slice(0, 30),
      logs: eventLogs.slice(0, 40),
      allowedActions: ALLOWED_ACTIONS,
      serverVersion: SERVER_VERSION,
      githubRepo: GITHUB_REPO,
      remoteVersion: remoteVersionCache,
      isUpdatingServer
    });
  }

  // 7. Web Dashboard UI
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(getDashboardHtml());
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

function getDashboardHtml() {
  return `<!DOCTYPE html>
<html lang="tr">
<head>
  <meta charset="UTF-8">
  <title>WinOps - Merkezi Takip & Yönetim Konsolu</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #090d16;
      --panel: #111827;
      --card: #182235;
      --border: #24324d;
      --primary: #38bdf8;
      --primary-glow: rgba(56, 189, 248, 0.25);
      --success: #10b981;
      --danger: #ef4444;
      --warning: #f59e0b;
      --text: #f1f5f9;
      --text-muted: #8292ab;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Plus Jakarta Sans', sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }
    header {
      background: var(--panel);
      border-bottom: 1px solid var(--border);
      padding: 14px 28px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      position: sticky;
      top: 0;
      z-index: 50;
    }
    .brand { display: flex; align-items: center; gap: 12px; }
    .brand-logo {
      width: 36px; height: 36px;
      background: linear-gradient(135deg, #0284c7, #38bdf8);
      border-radius: 10px;
      display: flex; align-items: center; justify-content: center;
      font-size: 20px;
      box-shadow: 0 0 15px var(--primary-glow);
    }
    .brand-title { font-size: 18px; font-weight: 700; letter-spacing: -0.5px; }
    .brand-sub { font-size: 11px; color: var(--text-muted); font-family: 'JetBrains Mono', monospace; }
    .header-right { display: flex; align-items: center; gap: 14px; }
    .ota-pill {
      font-size: 11px;
      font-family: 'JetBrains Mono', monospace;
      padding: 6px 12px;
      border-radius: 8px;
      background: rgba(16, 185, 129, 0.1);
      color: var(--success);
      border: 1px solid rgba(16, 185, 129, 0.25);
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .live-clock {
      font-family: 'JetBrains Mono', monospace;
      font-size: 14px;
      color: var(--primary);
      background: rgba(56, 189, 248, 0.08);
      padding: 6px 12px;
      border-radius: 8px;
      border: 1px solid rgba(56, 189, 248, 0.2);
    }
    .main-layout {
      flex: 1;
      padding: 24px 28px;
      max-width: 1600px;
      margin: 0 auto;
      width: 100%;
    }
    .stats-bar {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 18px;
      margin-bottom: 24px;
    }
    .stat-card {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 16px 20px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .stat-info span { font-size: 12px; color: var(--text-muted); text-transform: uppercase; font-weight: 600; }
    .stat-info h3 { font-size: 26px; font-weight: 700; margin-top: 4px; font-family: 'JetBrains Mono', monospace; }
    .stat-badge { width: 44px; height: 44px; border-radius: 12px; display: flex; align-items: center; justify-content: center; font-size: 20px; }
    .content-grid { display: grid; grid-template-columns: 2.2fr 1fr; gap: 24px; }
    @media (max-width: 1100px) { .content-grid { grid-template-columns: 1fr; } }
    .panel-box {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 14px;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }
    .panel-header {
      padding: 16px 20px;
      border-bottom: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .panel-header h2 { font-size: 15px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
    table { width: 100%; border-collapse: collapse; text-align: left; }
    th, td { padding: 14px 18px; border-bottom: 1px solid var(--border); font-size: 13px; }
    th { color: var(--text-muted); font-weight: 500; font-size: 12px; text-transform: uppercase; }
    tbody tr:hover { background: rgba(255, 255, 255, 0.02); }
    .pulse-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-right: 6px; }
    .pulse-online { background: var(--success); box-shadow: 0 0 8px var(--success); }
    .pulse-offline { background: var(--danger); box-shadow: 0 0 6px var(--danger); }
    .badge-chip {
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      padding: 3px 8px;
      border-radius: 6px;
      background: rgba(56, 189, 248, 0.1);
      color: var(--primary);
      border: 1px solid rgba(56, 189, 248, 0.25);
    }
    .quick-chip {
      padding: 5px 10px;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: #1b263b;
      color: #cbd5e1;
      font-size: 11px;
      cursor: pointer;
      transition: all 0.2s;
      margin-left: 4px;
    }
    .quick-chip:hover { background: var(--primary); color: #090d16; border-color: var(--primary); font-weight: 600; }
    select, input, button {
      width: 100%; padding: 10px 14px; border-radius: 8px;
      border: 1px solid var(--border); background: #090d16; color: #fff;
      margin-bottom: 12px; font-size: 13px; font-family: inherit;
    }
    button.btn-primary { background: var(--primary); color: #090d16; font-weight: 600; cursor: pointer; border: none; }
    button.btn-primary:hover { opacity: 0.9; }
    .log-stream {
      padding: 14px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 11.5px;
      max-height: 280px;
      overflow-y: auto;
      background: #090d16;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .log-row { display: flex; gap: 10px; line-height: 1.5; }
    .log-time { color: var(--text-muted); }
    .log-msg { color: #cbd5e1; }
    pre.code-out {
      background: #090d16; padding: 10px 12px; border-radius: 6px;
      border: 1px solid var(--border); color: #38bdf8;
      font-family: 'JetBrains Mono', monospace; font-size: 11px;
      max-height: 120px; overflow-y: auto; white-space: pre-wrap;
    }
  </style>
</head>
<body>

  <header>
    <div class="brand">
      <div class="brand-logo">🪟</div>
      <div>
        <div class="brand-title">WinOps Merkezi Takip Konsolu</div>
        <div class="brand-sub">Sunucu: <strong id="serverVer" style="color:var(--primary);">v1.1.0</strong> | GitHub: <a href="https://github.com/ayazOne/winops" target="_blank" style="color:var(--primary); text-decoration:none;">ayazOne/winops</a></div>
      </div>
    </div>
    <div class="header-right">
      <div class="ota-pill" id="otaStatusPill">🔄 Otomatik Güncelleme: AKTİF (45sn)</div>
      <div class="live-clock" id="liveClock">00:00:00</div>
    </div>
  </header>

  <div class="main-layout">
    <div class="stats-bar">
      <div class="stat-card">
        <div class="stat-info"><span>Toplam İstemci</span><h3 id="statTotal">0</h3></div>
        <div class="stat-badge" style="background:rgba(56, 189, 248, 0.1); color:var(--primary);">💻</div>
      </div>
      <div class="stat-card">
        <div class="stat-info"><span>Çevrimiçi (Online)</span><h3 id="statOnline" style="color:var(--success);">0</h3></div>
        <div class="stat-badge" style="background:rgba(16, 185, 129, 0.1); color:var(--success);">⚡</div>
      </div>
      <div class="stat-card">
        <div class="stat-info"><span>Çevrimdışı (Offline)</span><h3 id="statOffline" style="color:var(--danger);">0</h3></div>
        <div class="stat-badge" style="background:rgba(239, 68, 68, 0.1); color:var(--danger);">💤</div>
      </div>
      <div class="stat-card">
        <div class="stat-info"><span>Yürütülen Bakım</span><h3 id="statTasks">0</h3></div>
        <div class="stat-badge" style="background:rgba(245, 158, 11, 0.1); color:var(--warning);">🛠️</div>
      </div>
    </div>

    <div class="content-grid">
      <div class="panel-box">
        <div class="panel-header">
          <h2>💻 İstemci Takip Listesi</h2>
          <span style="font-size:12px; color:var(--text-muted);" id="githubCheckInfo">GitHub Kontrolü: Bekleniyor...</span>
        </div>
        <table>
          <thead>
            <tr>
              <th>Durum</th>
              <th>İstemci ID</th>
              <th>Host & IP</th>
              <th>Ajan Sürümü</th>
              <th>Son Görülme</th>
              <th style="text-align:right;">Hızlı Bakım</th>
            </tr>
          </thead>
          <tbody id="clientsTable">
            <tr><td colspan="6" style="text-align:center; color:var(--text-muted); padding:30px;">İstemciler taranıyor...</td></tr>
          </tbody>
        </table>

        <div class="panel-header" style="border-top:1px solid var(--border); margin-top:auto;">
          <h2>📡 Canlı Hareket Akışı (Live NOC Ticker)</h2>
        </div>
        <div class="log-stream" id="logStream">
          <div class="log-row"><span class="log-time">[--:--:--]</span><span class="log-msg">Sistem izleniyor...</span></div>
        </div>
      </div>

      <div style="display:flex; flex-direction:column; gap:24px;">
        <div class="panel-box">
          <div class="panel-header"><h2>🎯 Toplu / Tekli Komut Gönderici</h2></div>
          <div style="padding:18px;">
            <label style="font-size:11px; color:var(--text-muted); text-transform:uppercase; font-weight:600;">Hedef İstemci</label>
            <select id="targetClient">
              <option value="all">📢 Tüm İstemciler (Broadcast)</option>
            </select>

            <label style="font-size:11px; color:var(--text-muted); text-transform:uppercase; font-weight:600;">Bakım İşlemi</label>
            <select id="actionSelect">
              <option value="sync-ntp">⏰ Saat Senkronizasyonu (NTP Sync)</option>
              <option value="clean-temp">🧹 Önbellek & Temp Temizliği</option>
              <option value="sys-info">📊 Donanım & Sistem Raporu</option>
              <option value="restart-service">🔄 Servis Yeniden Başlat</option>
              <option value="update-agent">🚀 Ajanı Şimdi Güncelle (OTA)</option>
            </select>

            <div id="serviceParamDiv" style="display:none;">
              <label style="font-size:11px; color:var(--text-muted); text-transform:uppercase; font-weight:600;">Servis Adı</label>
              <input type="text" id="serviceName" placeholder="Örn: Spooler, wuauserv" value="Spooler">
            </div>

            <button class="btn-primary" onclick="dispatchManualCommand()">Kuyruğa Ekle & Gönder</button>
          </div>
        </div>

        <div class="panel-box" style="flex:1;">
          <div class="panel-header"><h2>📋 Son Bakım Raporları</h2></div>
          <div id="tasksList" style="padding:16px; display:flex; flex-direction:column; gap:12px; max-height:480px; overflow-y:auto;">
            <span style="color:var(--text-muted); font-size:12px;">Henüz görev sonucu yok.</span>
          </div>
        </div>
      </div>
    </div>
  </div>

  <script>
    let initialServerVersion = null;

    function updateClock() {
      document.getElementById('liveClock').textContent = new Date().toLocaleTimeString('tr-TR') + ' (NOC)';
    }
    setInterval(updateClock, 1000);
    updateClock();

    document.getElementById('actionSelect').addEventListener('change', function() {
      document.getElementById('serviceParamDiv').style.display = this.value === 'restart-service' ? 'block' : 'none';
    });

    async function loadDashboard() {
      try {
        const res = await fetch('/api/dashboard-data');
        const data = await res.json();

        // Sunucu kendi kendini güncellediğinde açık olan web sayfasını da otomatik yenile!
        if (!initialServerVersion) {
          initialServerVersion = data.serverVersion;
        } else if (initialServerVersion !== data.serverVersion) {
          location.reload();
          return;
        }

        document.getElementById('serverVer').textContent = 'v' + data.serverVersion;
        document.getElementById('statTotal').textContent = data.stats.total;
        document.getElementById('statOnline').textContent = data.stats.online;
        document.getElementById('statOffline').textContent = data.stats.offline;
        document.getElementById('statTasks').textContent = data.stats.totalTasks;

        if (data.remoteVersion && data.remoteVersion.lastChecked) {
          document.getElementById('githubCheckInfo').textContent = 'Son GitHub Kontrolü: ' + data.remoteVersion.lastChecked + ' (Hedef Sürüm: v' + data.remoteVersion.clientVersion + ')';
        }

        if (data.isUpdatingServer) {
          const pill = document.getElementById('otaStatusPill');
          pill.textContent = '⚡ Sunucu Güncelleniyor...';
          pill.style.color = '#f59e0b';
        }

        const tbody = document.getElementById('clientsTable');
        const targetSelect = document.getElementById('targetClient');
        const currentTarget = targetSelect.value;
        targetSelect.innerHTML = '<option value="all">📢 Tüm İstemciler (Broadcast)</option>';

        if (data.clients.length === 0) {
          tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; color:var(--text-muted); padding:30px;">Bağlı istemci bekleniyor...</td></tr>';
        } else {
          tbody.innerHTML = data.clients.map(c => {
            targetSelect.innerHTML += \`<option value="\${c.id}">\${c.hostname} (\${c.id})</option>\`;
            return \`
              <tr>
                <td>
                  <span class="pulse-dot \${c.isOnline ? 'pulse-online' : 'pulse-offline'}"></span>
                  <span style="font-weight:600; font-size:12px; color:\${c.isOnline ? 'var(--success)' : 'var(--danger)'}">
                    \${c.isOnline ? 'ONLINE' : 'OFFLINE'}
                  </span>
                </td>
                <td><strong style="color:#fff;">\${c.id}</strong></td>
                <td>
                  <div>\${c.hostname}</div>
                  <div style="font-size:11px; color:var(--text-muted); font-family:'JetBrains Mono';">\${c.ip}</div>
                </td>
                <td><span class="badge-chip">v\${c.version || '1.0.0'}</span></td>
                <td style="color:var(--text-muted); font-size:12px;">\${c.diffSeconds}s önce</td>
                <td style="text-align:right;">
                  <button class="quick-chip" onclick="quickAction('\${c.id}', 'sync-ntp')">⏰ NTP</button>
                  <button class="quick-chip" onclick="quickAction('\${c.id}', 'sys-info')">📊 Rapor</button>
                  <button class="quick-chip" onclick="quickAction('\${c.id}', 'clean-temp')">🧹 Temizle</button>
                </td>
              </tr>
            \`;
          }).join('');
        }
        targetSelect.value = currentTarget;

        const logStream = document.getElementById('logStream');
        if (data.logs && data.logs.length > 0) {
          logStream.innerHTML = data.logs.map(l => \`
            <div class="log-row">
              <span class="log-time">[\${l.time}]</span>
              <span class="log-msg">\${l.message}</span>
            </div>
          \`).join('');
        }

        const tasksDiv = document.getElementById('tasksList');
        if (data.tasks.length === 0) {
          tasksDiv.innerHTML = '<span style="color:var(--text-muted); font-size:12px;">Henüz görev yürütülmedi.</span>';
        } else {
          tasksDiv.innerHTML = data.tasks.map(t => {
            const outText = Object.entries(t.results || {}).map(([cId, res]) => \`[\${cId}]:\\n\${res}\`).join('\\n\\n') || 'Yürütülüyor...';
            return \`
              <div style="background:#090d16; border:1px solid var(--border); border-radius:8px; padding:12px;">
                <div style="display:flex; justify-content:space-between; margin-bottom:6px; font-size:12px;">
                  <strong style="color:var(--primary);">\${t.action}</strong>
                  <span style="color:var(--text-muted);">Hedef: \${t.targetClientId} | \${t.status}</span>
                </div>
                <pre class="code-out">\${outText}</pre>
              </div>
            \`;
          }).join('');
        }
      } catch (e) {}
    }

    async function quickAction(clientId, action) {
      await fetch('/api/tasks/dispatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetClientId: clientId, action, params: {} })
      });
      loadDashboard();
    }

    async function dispatchManualCommand() {
      const targetClientId = document.getElementById('targetClient').value;
      const action = document.getElementById('actionSelect').value;
      const serviceName = document.getElementById('serviceName').value;
      const params = action === 'restart-service' ? { serviceName } : {};

      await fetch('/api/tasks/dispatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetClientId, action, params })
      });
      loadDashboard();
    }

    loadDashboard();
    setInterval(loadDashboard, 3000);
  </script>
</body>
</html>`;
}

server.listen(PORT, '0.0.0.0', () => {
  addLog('system', `WinOps Yönetim Sunucusu başlatıldı (v${SERVER_VERSION}) - Port: ${PORT}`);
  console.log(`[WinOps Server v${SERVER_VERSION}] http://0.0.0.0:${PORT} adresinde çalışıyor`);
  sendTelegramNotification(`🚀 *WinOps Yönetim Sunucusu Başlatıldı (v${SERVER_VERSION})*\nPort: ${PORT}`);
});
