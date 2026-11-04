/**
 * Enterprise Windows Management Server with GitHub OTA Support & NOC Dashboard
 * Port: 3000
 * Zero external dependencies (native http, https, fs, path, crypto)
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SERVER_VERSION = '1.0.1';
const PORT = process.env.PORT || 3000;
const GITHUB_REPO = process.env.GITHUB_REPO || 'ayazOne/winops';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

// Storage
const clients = new Map();
const tasks = [];
const eventLogs = []; // Live activity feed
const ALLOWED_ACTIONS = ['sync-ntp', 'clean-temp', 'restart-service', 'sys-info', 'update-agent'];

let remoteVersionCache = { serverVersion: SERVER_VERSION, clientVersion: '1.0.0', lastChecked: 0 };

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

function checkGitHubVersion() {
  return new Promise((resolve) => {
    const url = `https://raw.githubusercontent.com/${GITHUB_REPO}/main/version.json?t=${Date.now()}`;
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          remoteVersionCache = {
            serverVersion: parsed.serverVersion || SERVER_VERSION,
            clientVersion: parsed.clientVersion || '1.0.0',
            lastChecked: Date.now()
          };
          resolve(remoteVersionCache);
        } catch (e) {
          resolve(remoteVersionCache);
        }
      });
    }).on('error', () => resolve(remoteVersionCache));
  });
}

checkGitHubVersion();
setInterval(checkGitHubVersion, 15 * 60 * 1000);

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
      const isNew = !clients.has(clientId);
      
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
        addLog('join', `Yeni istemci katıldı: [${clientId}] (${clientInfo.ip})`);
        sendTelegramNotification(`🟢 *Yeni İstemci Bağlandı:*\nID: \`${clientId}\`\nHost: ${clientInfo.hostname}\nIP: ${clientInfo.ip}\nVersiyon: v${clientInfo.version}`);
      }

      return jsonResponse(res, 200, { success: true, registered: true });
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
      addLog('task_start', `Görev alındı: [${clientId}] -> ${pendingTask.action}`);
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

      addLog('dispatch', `Yeni görev kuyruğa atandı: ${action} -> Hedef: [${newTask.targetClientId}]`);
      sendTelegramNotification(`🚀 *Yeni Görev Kuyrukta:*\nKomut: *${action}*\nHedef: \`${newTask.targetClientId}\``);
      return jsonResponse(res, 200, { success: true, task: newTask });
    } catch (e) {
      return jsonResponse(res, 400, { error: e.message });
    }
  }

  // 5. Server Self-Update
  if (req.method === 'POST' && pathname === '/api/server/self-update') {
    try {
      const rawUrl = `https://raw.githubusercontent.com/${GITHUB_REPO}/main/server/server.js?t=${Date.now()}`;
      https.get(rawUrl, (resp) => {
        let code = '';
        resp.on('data', c => { code += c; });
        resp.on('end', () => {
          if (resp.statusCode === 200 && code.includes('Enterprise Windows Management Server')) {
            const serverPath = path.join(__dirname, 'server.js');
            fs.writeFileSync(serverPath, code, 'utf8');
            addLog('system', 'Sunucu GitHub üzerinden güncellendi. Yeniden başlatılıyor...');
            sendTelegramNotification(`🔄 *Sunucu GitHub üzerinden güncellendi ve yeniden başlatılıyor...*`);
            jsonResponse(res, 200, { success: true, message: 'Sunucu güncellendi, yeniden başlatılıyor.' });

            setTimeout(() => {
              process.exit(0);
            }, 1000);
          } else {
            jsonResponse(res, 500, { error: 'GitHub üzerinden yeni sürüm çekilemedi.' });
          }
        });
      }).on('error', err => {
        jsonResponse(res, 500, { error: err.message });
      });
      return;
    } catch (e) {
      return jsonResponse(res, 500, { error: e.message });
    }
  }

  // 6. Admin API: Dashboard Data
  if (req.method === 'GET' && pathname === '/api/dashboard-data') {
    const now = Date.now();
    let onlineCount = 0;
    const clientList = Array.from(clients.values()).map(c => {
      const diffSeconds = Math.floor((now - new Date(c.lastSeen).getTime()) / 1000);
      const isOnline = diffSeconds < 90;
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
      serverTime: new Date().toLocaleString('tr-TR')
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
      --success-glow: rgba(16, 185, 129, 0.25);
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
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .brand-logo {
      width: 36px;
      height: 36px;
      background: linear-gradient(135deg, #0284c7, #38bdf8);
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 20px;
      box-shadow: 0 0 15px var(--primary-glow);
    }
    .brand-title {
      font-size: 18px;
      font-weight: 700;
      letter-spacing: -0.5px;
    }
    .brand-sub {
      font-size: 11px;
      color: var(--text-muted);
      font-family: 'JetBrains Mono', monospace;
    }
    .header-right {
      display: flex;
      align-items: center;
      gap: 16px;
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
    
    /* Stats Bar */
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
    .stat-info span {
      font-size: 12px;
      color: var(--text-muted);
      text-transform: uppercase;
      font-weight: 600;
      letter-spacing: 0.5px;
    }
    .stat-info h3 {
      font-size: 26px;
      font-weight: 700;
      margin-top: 4px;
      font-family: 'JetBrains Mono', monospace;
    }
    .stat-badge {
      width: 44px;
      height: 44px;
      border-radius: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 20px;
    }

    /* Update Alert Banner */
    .update-banner {
      background: rgba(245, 158, 11, 0.12);
      border: 1px solid var(--warning);
      border-radius: 10px;
      padding: 12px 20px;
      margin-bottom: 24px;
      display: none;
      justify-content: space-between;
      align-items: center;
    }

    /* Content Grid */
    .content-grid {
      display: grid;
      grid-template-columns: 2.2fr 1fr;
      gap: 24px;
    }
    @media (max-width: 1100px) {
      .content-grid { grid-template-columns: 1fr; }
    }

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
      background: rgba(255, 255, 255, 0.01);
    }
    .panel-header h2 {
      font-size: 15px;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    /* Tables */
    table { width: 100%; border-collapse: collapse; text-align: left; }
    th, td { padding: 14px 18px; border-bottom: 1px solid var(--border); font-size: 13px; }
    th { color: var(--text-muted); font-weight: 500; font-size: 12px; text-transform: uppercase; }
    tbody tr:hover { background: rgba(255, 255, 255, 0.02); }

    .pulse-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      display: inline-block;
      margin-right: 6px;
    }
    .pulse-online { background: var(--success); box-shadow: 0 0 8px var(--success); }
    .pulse-offline { background: var(--danger); box-shadow: 0 0 6px var(--danger); }

    .badge-chip {
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      padding: 3px 8px;
      border-radius: 6px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--border);
    }

    /* Quick Action Chips */
    .quick-chip {
      padding: 4px 10px;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: #1b263b;
      color: #cbd5e1;
      font-size: 11px;
      cursor: pointer;
      font-family: inherit;
      transition: all 0.2s;
      white-space: nowrap;
    }
    .quick-chip:hover {
      background: var(--primary);
      color: #090d16;
      border-color: var(--primary);
    }

    /* Form Controls */
    select, input, button {
      width: 100%;
      padding: 10px 14px;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: #090d16;
      color: #fff;
      margin-bottom: 12px;
      font-size: 13px;
      font-family: inherit;
    }
    select:focus, input:focus { outline: none; border-color: var(--primary); }
    button.btn-primary {
      background: var(--primary);
      color: #090d16;
      font-weight: 600;
      cursor: pointer;
      border: none;
      transition: opacity 0.2s;
    }
    button.btn-primary:hover { opacity: 0.9; }

    /* Live Feed Logs */
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
    .log-row {
      display: flex;
      gap: 10px;
      line-height: 1.5;
    }
    .log-time { color: var(--text-muted); }
    .log-msg { color: #cbd5e1; word-break: break-all; }

    /* Execution Output Blocks */
    pre.code-out {
      background: #090d16;
      padding: 10px 12px;
      border-radius: 6px;
      border: 1px solid var(--border);
      color: #38bdf8;
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      max-height: 120px;
      overflow-y: auto;
      white-space: pre-wrap;
    }
  </style>
</head>
<body>

  <header>
    <div class="brand">
      <div class="brand-logo">🪟</div>
      <div>
        <div class="brand-title">WinOps Merkezi Takip Konsolu</div>
        <div class="brand-sub">Sürüm: <span id="serverVer">v1.0.1</span> | GitHub: <a href="https://github.com/ayazOne/winops" target="_blank" style="color:var(--primary); text-decoration:none;">ayazOne/winops</a></div>
      </div>
    </div>
    <div class="header-right">
      <div class="live-clock" id="liveClock">00:00:00</div>
      <button onclick="updateAllClients()" style="width:auto; padding:7px 14px; margin-bottom:0; background:#1e293b; color:#fff; border:1px solid var(--border); font-size:12px; cursor:pointer; border-radius:8px;">🚀 Tüm İstemcileri Güncelle (OTA)</button>
    </div>
  </header>

  <div class="main-layout">

    <!-- Update Alert Banner -->
    <div id="updateBanner" class="update-banner">
      <span id="updateBannerText">🔔 GitHub üzerinde yeni bir sunucu sürümü mevcut!</span>
      <button onclick="updateServer()" style="width:auto; padding:6px 16px; margin-bottom:0; background:var(--warning); color:#000; font-weight:700; border:none; border-radius:6px; cursor:pointer;">Sunucuyu Güncelle</button>
    </div>

    <!-- Stats Bar -->
    <div class="stats-bar">
      <div class="stat-card">
        <div class="stat-info">
          <span>Toplam İstemci</span>
          <h3 id="statTotal">0</h3>
        </div>
        <div class="stat-badge" style="background:rgba(56, 189, 248, 0.1); color:var(--primary);">💻</div>
      </div>
      <div class="stat-card">
        <div class="stat-info">
          <span>Çevrimiçi (Online)</span>
          <h3 id="statOnline" style="color:var(--success);">0</h3>
        </div>
        <div class="stat-badge" style="background:rgba(16, 185, 129, 0.1); color:var(--success);">⚡</div>
      </div>
      <div class="stat-card">
        <div class="stat-info">
          <span>Çevrimdışı (Offline)</span>
          <h3 id="statOffline" style="color:var(--danger);">0</h3>
        </div>
        <div class="stat-badge" style="background:rgba(239, 68, 68, 0.1); color:var(--danger);">💤</div>
      </div>
      <div class="stat-card">
        <div class="stat-info">
          <span>Yürütülen Bakım</span>
          <h3 id="statTasks">0</h3>
        </div>
        <div class="stat-badge" style="background:rgba(245, 158, 11, 0.1); color:var(--warning);">🛠️</div>
      </div>
    </div>

    <!-- Main Content -->
    <div class="content-grid">
      
      <!-- Left: Client Table -->
      <div class="panel-box">
        <div class="panel-header">
          <h2>💻 İstemci Takip Listesi</h2>
          <span style="font-size:12px; color:var(--text-muted);">Canlı Senkron: 3sn</span>
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

        <!-- Live Activity Stream inside left panel -->
        <div class="panel-header" style="border-top:1px solid var(--border); margin-top:auto;">
          <h2>📡 Canlı Hareket Akışı (Live NOC Ticker)</h2>
        </div>
        <div class="log-stream" id="logStream">
          <div class="log-row"><span class="log-time">[--:--:--]</span><span class="log-msg">Canlı log akışı başlatıldı.</span></div>
        </div>
      </div>

      <!-- Right: Dispatch & Operations -->
      <div style="display:flex; flex-direction:column; gap:24px;">
        
        <!-- Manual Dispatch Card -->
        <div class="panel-box">
          <div class="panel-header">
            <h2>🎯 Komut Gönderici</h2>
          </div>
          <div style="padding:18px;">
            <label style="font-size:11px; color:var(--text-muted); text-transform:uppercase; font-weight:600;">Hedef Seçimi</label>
            <select id="targetClient">
              <option value="all">📢 Tüm İstemciler (Broadcast)</option>
            </select>

            <label style="font-size:11px; color:var(--text-muted); text-transform:uppercase; font-weight:600;">Bakım İşlemi</label>
            <select id="actionSelect">
              <option value="sync-ntp">⏰ Saat Senkronizasyonu (NTP Sync)</option>
              <option value="clean-temp">🧹 Önbellek & Temp Temizliği</option>
              <option value="sys-info">📊 Donanım & Sistem Raporu</option>
              <option value="restart-service">🔄 Servis Yeniden Başlat</option>
              <option value="update-agent">🚀 Ajanı Güncelle (OTA)</option>
            </select>

            <div id="serviceParamDiv" style="display:none;">
              <label style="font-size:11px; color:var(--text-muted); text-transform:uppercase; font-weight:600;">Servis Adı</label>
              <input type="text" id="serviceName" placeholder="Örn: Spooler, wuauserv" value="Spooler">
            </div>

            <button class="btn-primary" onclick="dispatchManualCommand()">Kuyruğa Ekle & Gönder</button>
          </div>
        </div>

        <!-- Recent Task Results -->
        <div class="panel-box" style="flex:1;">
          <div class="panel-header">
            <h2>📋 Son Bakım Raporları</h2>
          </div>
          <div id="tasksList" style="padding:16px; display:flex; flex-direction:column; gap:12px; max-height:480px; overflow-y:auto;">
            <span style="color:var(--text-muted); font-size:12px;">Henüz görev sonucu yok.</span>
          </div>
        </div>

      </div>

    </div>

  </div>

  <script>
    // Live Clock
    function updateClock() {
      const now = new Date();
      document.getElementById('liveClock').textContent = now.toLocaleTimeString('tr-TR') + ' (NOC)';
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

        // Server version & stats
        document.getElementById('serverVer').textContent = 'v' + data.serverVersion;
        document.getElementById('statTotal').textContent = data.stats.total;
        document.getElementById('statOnline').textContent = data.stats.online;
        document.getElementById('statOffline').textContent = data.stats.offline;
        document.getElementById('statTasks').textContent = data.stats.totalTasks;

        // OTA Update Alert
        if (data.remoteVersion && data.remoteVersion.serverVersion && data.remoteVersion.serverVersion !== data.serverVersion) {
          const banner = document.getElementById('updateBanner');
          document.getElementById('updateBannerText').textContent = '🔔 GitHub üzerinde yeni sunucu sürümü mevcut: v' + data.remoteVersion.serverVersion;
          banner.style.display = 'flex';
        }

        // Clients Table
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

        // Live Log Stream
        const logStream = document.getElementById('logStream');
        if (data.logs && data.logs.length > 0) {
          logStream.innerHTML = data.logs.map(l => \`
            <div class="log-row">
              <span class="log-time">[\${l.time}]</span>
              <span class="log-msg">\${l.message}</span>
            </div>
          \`).join('');
        }

        // Recent Task Results
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

      } catch (e) {
        console.error('Yükleme hatası:', e);
      }
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

      const res = await fetch('/api/tasks/dispatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetClientId, action, params })
      });
      const data = await res.json();
      if (data.success) {
        loadDashboard();
      } else {
        alert('Hata: ' + data.error);
      }
    }

    async function updateAllClients() {
      if (!confirm('Tüm aktif istemcilere GitHub üzerinden güncelleme emri gönderilsin mi?')) return;
      await fetch('/api/tasks/dispatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetClientId: 'all', action: 'update-agent' })
      });
      loadDashboard();
    }

    async function updateServer() {
      if (!confirm('Sunucu GitHub üzerinden güncellenip yeniden başlatılsın mı?')) return;
      const res = await fetch('/api/server/self-update', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        alert('Sunucu güncelleniyor. Sayfa 5 saniye sonra yenilenecek.');
        setTimeout(() => location.reload(), 5000);
      }
    }

    loadDashboard();
    setInterval(loadDashboard, 3000); // 3 saniyede bir canlı yenileme
  </script>
</body>
</html>`;
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[WinOps Server v${SERVER_VERSION}] http://0.0.0.0:${PORT} adresinde çalışıyor`);
  sendTelegramNotification(`🚀 *WinOps Yönetim Sunucusu Başlatıldı (v${SERVER_VERSION})*\nPort: ${PORT}`);
});
