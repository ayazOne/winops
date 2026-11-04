/**
 * Enterprise Windows Management Server - Real-Time Clock Sync & NOC Console (v1.2.0)
 * Port: 3000
 * Zero external dependencies (native http, https, fs, path, crypto)
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SERVER_VERSION = '1.2.0';
const PORT = process.env.PORT || 3000;
const GITHUB_REPO = process.env.GITHUB_REPO || 'ayazOne/winops';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

// Storage
const clients = new Map();
const tasks = [];
const eventLogs = [];
const ALLOWED_ACTIONS = [
  'sync-ntp',
  'sync-server-time',
  'set-custom-time',
  'clean-temp',
  'restart-service',
  'sys-info',
  'update-agent'
];

let remoteVersionCache = { serverVersion: SERVER_VERSION, clientVersion: '1.2.0', lastChecked: 0 };
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
            process.exit(0);
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
          clientVersion: parsed.clientVersion || '1.2.0',
          lastChecked: new Date().toLocaleTimeString('tr-TR')
        };

        if (parsed.serverVersion && parsed.serverVersion !== SERVER_VERSION) {
          performServerSelfUpdate(parsed.serverVersion);
        }
      } catch (e) {}
    });
  }).on('error', () => {});
}

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

  // 1. Client Heartbeat + Real-Time Clock Tracking
  if (req.method === 'POST' && pathname === '/api/heartbeat') {
    try {
      const data = await parseJsonBody(req);
      const serverNowMs = Date.now();
      const clientId = data.clientId || req.socket.remoteAddress;
      const existing = clients.get(clientId);
      const isNew = !existing;
      const versionChanged = existing && existing.version !== data.version;

      const clientEpochMs = data.epochMs ? Number(data.epochMs) : serverNowMs;
      const driftSeconds = Number(((clientEpochMs - serverNowMs) / 1000).toFixed(1));

      const clientInfo = {
        id: clientId,
        hostname: data.hostname || 'Unknown',
        ip: data.ip || req.socket.remoteAddress,
        os: data.os || 'Windows',
        uptime: data.uptime || 'N/A',
        version: data.version || '1.0.0',
        systemTime: data.systemTime || new Date(clientEpochMs).toLocaleTimeString('tr-TR'),
        systemDate: data.systemDate || new Date(clientEpochMs).toISOString().slice(0, 10),
        epochMs: clientEpochMs,
        driftSeconds,
        timeZone: data.timeZone || 'Local',
        lastSeen: new Date().toISOString()
      };
      
      clients.set(clientId, clientInfo);

      if (isNew) {
        addLog('join', `Yeni istemci bağlandı: [${clientId}] (${clientInfo.ip}) - Saat: ${clientInfo.systemTime}`);
        sendTelegramNotification(`🟢 *Yeni İstemci Bağlandı:*\nID: \`${clientId}\`\nHost: ${clientInfo.hostname}\nIP: ${clientInfo.ip}\nSaat: ${clientInfo.systemTime}\nVersiyon: v${clientInfo.version}`);
      } else if (versionChanged) {
        addLog('system', `İstemci [${clientId}] yeni sürüme güncellendi: v${existing.version} -> v${clientInfo.version}`);
      }

      return jsonResponse(res, 200, {
        success: true,
        registered: true,
        serverEpochMs: Date.now(),
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

      // Sunucu saatiyle eşitleme görevinde tam o anki milisaniyeyi gönder (gecikmesiz senkronizasyon)
      const taskCopy = JSON.parse(JSON.stringify(pendingTask));
      if (taskCopy.action === 'sync-server-time') {
        taskCopy.params = { ...taskCopy.params, serverEpochMs: Date.now() };
      }

      addLog('task_start', `Görev iletildi: [${clientId}] -> ${pendingTask.action}`);
      return jsonResponse(res, 200, { hasTask: true, task: taskCopy });
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

        addLog('task_done', `Görev tamamlandı: [${clientId}] -> ${task.action}: ${(output || '').replace(/\n/g, ' ')}`);
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

      addLog('dispatch', `Komut gönderildi: [${action}] -> Hedef: [${newTask.targetClientId}]`);
      return jsonResponse(res, 200, { success: true, task: newTask });
    } catch (e) {
      return jsonResponse(res, 400, { error: e.message });
    }
  }

  // 5. Admin API: Dashboard Data
  if (req.method === 'GET' && pathname === '/api/dashboard-data') {
    const now = Date.now();
    let onlineCount = 0;
    let syncedCount = 0;

    const clientList = Array.from(clients.values()).map(c => {
      const diffSeconds = Math.floor((now - new Date(c.lastSeen).getTime()) / 1000);
      const isOnline = diffSeconds < 20;
      if (isOnline) onlineCount++;
      const absDrift = Math.abs(c.driftSeconds || 0);
      if (isOnline && absDrift <= 3) syncedCount++;

      // Canlı tahmini istemci saati (son heartbeat'ten bu yana geçen süreyi ekle)
      const estimatedClientMs = (c.epochMs || now) + (now - new Date(c.lastSeen).getTime());

      return {
        ...c,
        isOnline,
        diffSeconds,
        estimatedClientMs
      };
    });

    return jsonResponse(res, 200, {
      clients: clientList,
      stats: {
        total: clientList.length,
        online: onlineCount,
        offline: clientList.length - onlineCount,
        synced: syncedCount,
        totalTasks: tasks.length
      },
      serverEpochMs: now,
      tasks: tasks.slice(0, 25),
      logs: eventLogs.slice(0, 40),
      serverVersion: SERVER_VERSION,
      githubRepo: GITHUB_REPO,
      remoteVersion: remoteVersionCache,
      isUpdatingServer
    });
  }

  // 6. Web Dashboard UI
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
  <title>WinOps - Merkezi Saat & Sistem Kontrol Konsolu</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #070b12;
      --panel: #0f172a;
      --card: #1e293b;
      --border: #26354d;
      --primary: #38bdf8;
      --primary-glow: rgba(56, 189, 248, 0.25);
      --success: #10b981;
      --danger: #ef4444;
      --warning: #f59e0b;
      --text: #f8fafc;
      --text-muted: #94a3b8;
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
      width: 38px; height: 38px;
      background: linear-gradient(135deg, #0284c7, #38bdf8);
      border-radius: 10px;
      display: flex; align-items: center; justify-content: center;
      font-size: 20px;
      box-shadow: 0 0 15px var(--primary-glow);
    }
    .brand-title { font-size: 18px; font-weight: 700; letter-spacing: -0.5px; }
    .brand-sub { font-size: 11px; color: var(--text-muted); font-family: 'JetBrains Mono', monospace; }
    .header-right { display: flex; align-items: center; gap: 12px; }
    .ota-pill {
      font-size: 11px;
      font-family: 'JetBrains Mono', monospace;
      padding: 6px 12px;
      border-radius: 8px;
      background: rgba(16, 185, 129, 0.1);
      color: var(--success);
      border: 1px solid rgba(16, 185, 129, 0.25);
    }
    .main-layout {
      flex: 1;
      padding: 22px 28px;
      max-width: 1650px;
      margin: 0 auto;
      width: 100%;
    }

    /* Master Clock Hero Bar */
    .master-clock-bar {
      background: linear-gradient(135deg, #0f172a 0%, #172554 100%);
      border: 1px solid #1e3a8a;
      border-radius: 16px;
      padding: 20px 26px;
      margin-bottom: 22px;
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      align-items: center;
      gap: 20px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.4);
    }
    .master-time-box {
      display: flex;
      align-items: center;
      gap: 20px;
    }
    .master-clock-digits {
      font-family: 'JetBrains Mono', monospace;
      font-size: 38px;
      font-weight: 700;
      color: var(--primary);
      letter-spacing: 1px;
      text-shadow: 0 0 20px rgba(56, 189, 248, 0.4);
    }
    .master-clock-meta {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .master-clock-meta span.label {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: #93c5fd;
      font-weight: 700;
    }
    .master-clock-meta span.date {
      font-size: 14px;
      color: #e2e8f0;
      font-family: 'JetBrains Mono', monospace;
    }
    .master-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: center;
    }
    .btn-hero {
      padding: 10px 16px;
      border-radius: 10px;
      border: 1px solid rgba(56, 189, 248, 0.35);
      background: rgba(56, 189, 248, 0.15);
      color: #fff;
      font-weight: 600;
      font-size: 13px;
      cursor: pointer;
      transition: all 0.2s;
      display: flex;
      align-items: center;
      gap: 8px;
      width: auto;
      margin: 0;
    }
    .btn-hero:hover {
      background: var(--primary);
      color: #070b12;
      border-color: var(--primary);
    }
    .btn-hero.green {
      background: rgba(16, 185, 129, 0.18);
      border-color: rgba(16, 185, 129, 0.4);
    }
    .btn-hero.green:hover {
      background: var(--success);
      color: #070b12;
    }

    /* Stats Bar */
    .stats-bar {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 16px;
      margin-bottom: 22px;
    }
    .stat-card {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 14px 18px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .stat-info span { font-size: 11px; color: var(--text-muted); text-transform: uppercase; font-weight: 600; }
    .stat-info h3 { font-size: 24px; font-weight: 700; margin-top: 4px; font-family: 'JetBrains Mono', monospace; }
    .stat-badge { width: 42px; height: 42px; border-radius: 10px; display: flex; align-items: center; justify-content: center; font-size: 18px; }

    /* Content Grid */
    .content-grid { display: grid; grid-template-columns: 2.3fr 1fr; gap: 22px; }
    @media (max-width: 1150px) { .content-grid { grid-template-columns: 1fr; } }

    .panel-box {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 14px;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }
    .panel-header {
      padding: 15px 20px;
      border-bottom: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .panel-header h2 { font-size: 15px; font-weight: 600; display: flex; align-items: center; gap: 8px; }

    table { width: 100%; border-collapse: collapse; text-align: left; }
    th, td { padding: 14px 16px; border-bottom: 1px solid var(--border); font-size: 13px; vertical-align: middle; }
    th { color: var(--text-muted); font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
    tbody tr:hover { background: rgba(255, 255, 255, 0.02); }

    /* Client Digital Clock Display */
    .client-clock-wrap {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .client-digital-clock {
      font-family: 'JetBrains Mono', monospace;
      font-size: 20px;
      font-weight: 700;
      color: #fff;
      background: #070b12;
      padding: 6px 12px;
      border-radius: 8px;
      border: 1px solid var(--border);
      letter-spacing: 0.5px;
    }
    .drift-tag {
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      padding: 3px 8px;
      border-radius: 6px;
      font-weight: 600;
    }
    .drift-ok { background: rgba(16, 185, 129, 0.15); color: var(--success); border: 1px solid rgba(16, 185, 129, 0.3); }
    .drift-warn { background: rgba(245, 158, 11, 0.15); color: var(--warning); border: 1px solid rgba(245, 158, 11, 0.3); }
    .drift-bad { background: rgba(239, 68, 68, 0.18); color: var(--danger); border: 1px solid rgba(239, 68, 68, 0.35); }

    .pulse-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-right: 6px; }
    .pulse-online { background: var(--success); box-shadow: 0 0 8px var(--success); }
    .pulse-offline { background: var(--danger); box-shadow: 0 0 6px var(--danger); }

    .quick-chip {
      padding: 6px 10px;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: #1b263b;
      color: #e2e8f0;
      font-size: 11.5px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s;
      margin-left: 4px;
      width: auto;
      margin-bottom: 0;
    }
    .quick-chip:hover { background: var(--primary); color: #070b12; border-color: var(--primary); font-weight: 600; }
    .quick-chip.sync-btn { background: rgba(16, 185, 129, 0.15); border-color: rgba(16, 185, 129, 0.35); color: #34d399; }
    .quick-chip.sync-btn:hover { background: var(--success); color: #070b12; }

    select, input, button {
      width: 100%; padding: 10px 14px; border-radius: 8px;
      border: 1px solid var(--border); background: #070b12; color: #fff;
      margin-bottom: 12px; font-size: 13px; font-family: inherit;
    }
    button.btn-primary { background: var(--primary); color: #070b12; font-weight: 700; cursor: pointer; border: none; }
    button.btn-primary:hover { opacity: 0.9; }

    .log-stream {
      padding: 14px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 11.5px;
      max-height: 240px;
      overflow-y: auto;
      background: #070b12;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .log-row { display: flex; gap: 10px; line-height: 1.5; }
    .log-time { color: var(--text-muted); }
    .log-msg { color: #cbd5e1; }
    pre.code-out {
      background: #070b12; padding: 10px 12px; border-radius: 6px;
      border: 1px solid var(--border); color: #38bdf8;
      font-family: 'JetBrains Mono', monospace; font-size: 11px;
      max-height: 120px; overflow-y: auto; white-space: pre-wrap;
    }

    /* Modal for Custom Clock Adjustment */
    .modal-backdrop {
      position: fixed; inset: 0; background: rgba(0,0,0,0.75);
      display: none; align-items: center; justify-content: center; z-index: 100;
    }
    .modal-card {
      background: var(--panel); border: 1px solid var(--border);
      border-radius: 14px; width: 420px; max-width: 92%; padding: 22px;
      box-shadow: 0 20px 50px rgba(0,0,0,0.6);
    }
    .modal-card h3 { font-size: 16px; margin-bottom: 6px; }
    .modal-card p { font-size: 12px; color: var(--text-muted); margin-bottom: 16px; }
    .offset-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 14px; }
  </style>
</head>
<body>

  <header>
    <div class="brand">
      <div class="brand-logo">⏰</div>
      <div>
        <div class="brand-title">WinOps Merkezi Saat & Sistem Kontrol Konsolu</div>
        <div class="brand-sub">Sunucu: <strong id="serverVer" style="color:var(--primary);">v1.2.0</strong> | GitHub: <a href="https://github.com/ayazOne/winops" target="_blank" style="color:var(--primary); text-decoration:none;">ayazOne/winops</a></div>
      </div>
    </div>
    <div class="header-right">
      <div class="ota-pill" id="otaStatusPill">🔄 Otonom Güncelleme: AKTİF</div>
    </div>
  </header>

  <div class="main-layout">

    <!-- Master Clock & Instant Broadcast Control Bar -->
    <div class="master-clock-bar">
      <div class="master-time-box">
        <div class="master-clock-digits" id="masterClock">00:00:00</div>
        <div class="master-clock-meta">
          <span class="label">🖥️ Sunucu Referans Saati</span>
          <span class="date" id="masterDate">----/--/--</span>
        </div>
      </div>
      <div class="master-actions">
        <button class="btn-hero green" onclick="quickAction('all', 'sync-server-time')">
          ⚡ Tüm İstemcileri Sunucu Saatine Eşitle
        </button>
        <button class="btn-hero" onclick="quickAction('all', 'sync-ntp')">
          🌐 Tümünü NTP (İnternet Saati) ile Eşitle
        </button>
        <button class="btn-hero" onclick="openTimeModal('all')">
          ✏️ Toplu Manuel Saat Ayarla
        </button>
      </div>
    </div>

    <!-- Stats Bar -->
    <div class="stats-bar">
      <div class="stat-card">
        <div class="stat-info"><span>Toplam İstemci</span><h3 id="statTotal">0</h3></div>
        <div class="stat-badge" style="background:rgba(56, 189, 248, 0.1); color:var(--primary);">💻</div>
      </div>
      <div class="stat-card">
        <div class="stat-info"><span>Çevrimiçi (Online)</span><h3 id="statOnline" style="color:var(--success);">0</h3></div>
        <div class="stat-badge" style="background:rgba(16, 185, 129, 0.1); color:var(--success);">🟢</div>
      </div>
      <div class="stat-card">
        <div class="stat-info"><span>Saati Tam Senkron</span><h3 id="statSynced" style="color:var(--primary);">0</h3></div>
        <div class="stat-badge" style="background:rgba(56, 189, 248, 0.1); color:var(--primary);">⏱️</div>
      </div>
      <div class="stat-card">
        <div class="stat-info"><span>Çevrimdışı (Offline)</span><h3 id="statOffline" style="color:var(--danger);">0</h3></div>
        <div class="stat-badge" style="background:rgba(239, 68, 68, 0.1); color:var(--danger);">💤</div>
      </div>
    </div>

    <!-- Main Grid -->
    <div class="content-grid">
      <div class="panel-box">
        <div class="panel-header">
          <h2>⏱️ İstemci Canlı Saatleri ve Anlık Müdahale</h2>
          <span style="font-size:12px; color:var(--text-muted);" id="githubCheckInfo">Canlı Akış: 2sn</span>
        </div>
        <table>
          <thead>
            <tr>
              <th>Durum & Cihaz</th>
              <th>İstemci Canlı Saati</th>
              <th>Saat Farkı (Sapma)</th>
              <th>Ajan</th>
              <th style="text-align:right;">Anlık Saat & Bakım Kontrolü</th>
            </tr>
          </thead>
          <tbody id="clientsTable">
            <tr><td colspan="5" style="text-align:center; color:var(--text-muted); padding:30px;">İstemciler taranıyor...</td></tr>
          </tbody>
        </table>

        <div class="panel-header" style="border-top:1px solid var(--border); margin-top:auto;">
          <h2>📡 Canlı Operasyon Akışı (Live NOC Log)</h2>
        </div>
        <div class="log-stream" id="logStream">
          <div class="log-row"><span class="log-time">[--:--:--]</span><span class="log-msg">Sistem izleniyor...</span></div>
        </div>
      </div>

      <div style="display:flex; flex-direction:column; gap:22px;">
        <div class="panel-box">
          <div class="panel-header"><h2>🛠️ Gelişmiş Bakım & Komut Gönderici</h2></div>
          <div style="padding:18px;">
            <label style="font-size:11px; color:var(--text-muted); text-transform:uppercase; font-weight:600;">Hedef İstemci</label>
            <select id="targetClient">
              <option value="all">📢 Tüm İstemciler (Broadcast)</option>
            </select>

            <label style="font-size:11px; color:var(--text-muted); text-transform:uppercase; font-weight:600;">İşlem Seçin</label>
            <select id="actionSelect">
              <option value="sync-server-time">⚡ Sunucu Saatine Anında Eşitle</option>
              <option value="sync-ntp">🌐 NTP Saat Senkronizasyonu</option>
              <option value="clean-temp">🧹 Önbellek & Temp Temizliği</option>
              <option value="sys-info">📊 Donanım & Sistem Raporu</option>
              <option value="restart-service">🔄 Windows Servisi Yeniden Başlat</option>
              <option value="update-agent">🚀 Ajanı Şimdi Güncelle (OTA)</option>
            </select>

            <div id="serviceParamDiv" style="display:none;">
              <label style="font-size:11px; color:var(--text-muted); text-transform:uppercase; font-weight:600;">Servis Adı</label>
              <input type="text" id="serviceName" placeholder="Örn: Spooler, w32time" value="w32time">
            </div>

            <button class="btn-primary" onclick="dispatchManualCommand()">Komutu Şimdi Gönder</button>
          </div>
        </div>

        <div class="panel-box" style="flex:1;">
          <div class="panel-header"><h2>📋 İşlem & Saat Raporları</h2></div>
          <div id="tasksList" style="padding:16px; display:flex; flex-direction:column; gap:12px; max-height:460px; overflow-y:auto;">
            <span style="color:var(--text-muted); font-size:12px;">Henüz görev sonucu yok.</span>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- Custom Time Set Modal -->
  <div class="modal-backdrop" id="timeModal">
    <div class="modal-card">
      <h3 id="modalTitle">✏️ Saat Ayarla</h3>
      <p id="modalSub">Seçili istemci için yeni saati girin veya hızlı kaydırma uygulayın.</p>
      
      <label style="font-size:11px; color:var(--text-muted); text-transform:uppercase; font-weight:600;">Tam Saat Belirle (SS:DD:SN)</label>
      <input type="text" id="customTimeInput" placeholder="Örn: 14:30:00">
      <button class="btn-primary" onclick="applyCustomTimeString()">Bu Saate Ayarla</button>

      <div style="margin: 14px 0 8px; font-size:11px; color:var(--text-muted); text-transform:uppercase; font-weight:600;">Veya Hızlı İleri / Geri Kaydır</div>
      <div class="offset-grid">
        <button class="quick-chip" style="margin:0; padding:8px;" onclick="applyTimeOffset(-60)">-1 Saat</button>
        <button class="quick-chip" style="margin:0; padding:8px;" onclick="applyTimeOffset(-5)">-5 Dk</button>
        <button class="quick-chip" style="margin:0; padding:8px;" onclick="applyTimeOffset(5)">+5 Dk</button>
        <button class="quick-chip" style="margin:0; padding:8px;" onclick="applyTimeOffset(60)">+1 Saat</button>
      </div>

      <button onclick="closeTimeModal()" style="background:#1e293b; color:#cbd5e1; border:none; margin-top:8px; cursor:pointer; margin-bottom:0;">Kapat</button>
    </div>
  </div>

  <script>
    let initialServerVersion = null;
    let serverOffsetMs = 0;
    let latestClients = [];
    let lastFetchLocalMs = Date.now();
    let modalTargetClient = 'all';

    // Saniyede 2 kez tüm saatleri akıcı şekilde güncelle
    function tickClocks() {
      const nowServer = new Date(Date.now() + serverOffsetMs);
      document.getElementById('masterClock').textContent = nowServer.toLocaleTimeString('tr-TR');
      document.getElementById('masterDate').textContent = nowServer.toLocaleDateString('tr-TR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

      const elapsedSinceFetch = Date.now() - lastFetchLocalMs;
      latestClients.forEach(c => {
        const el = document.getElementById('clock-' + c.id);
        if (el) {
          const clientLiveDate = new Date(c.estimatedClientMs + elapsedSinceFetch);
          el.textContent = clientLiveDate.toLocaleTimeString('tr-TR');
        }
      });
    }
    setInterval(tickClocks, 500);

    document.getElementById('actionSelect').addEventListener('change', function() {
      document.getElementById('serviceParamDiv').style.display = this.value === 'restart-service' ? 'block' : 'none';
    });

    async function loadDashboard() {
      try {
        const res = await fetch('/api/dashboard-data');
        const data = await res.json();

        if (!initialServerVersion) {
          initialServerVersion = data.serverVersion;
        } else if (initialServerVersion !== data.serverVersion) {
          location.reload();
          return;
        }

        lastFetchLocalMs = Date.now();
        if (data.serverEpochMs) {
          serverOffsetMs = data.serverEpochMs - Date.now();
        }
        latestClients = data.clients || [];

        document.getElementById('serverVer').textContent = 'v' + data.serverVersion;
        document.getElementById('statTotal').textContent = data.stats.total;
        document.getElementById('statOnline').textContent = data.stats.online;
        document.getElementById('statSynced').textContent = data.stats.synced;
        document.getElementById('statOffline').textContent = data.stats.offline;

        if (data.remoteVersion && data.remoteVersion.lastChecked) {
          document.getElementById('githubCheckInfo').textContent = 'Son OTA Kontrolü: ' + data.remoteVersion.lastChecked + ' | Canlı Akış: 2sn';
        }

        const tbody = document.getElementById('clientsTable');
        const targetSelect = document.getElementById('targetClient');
        const currentTarget = targetSelect.value;
        targetSelect.innerHTML = '<option value="all">📢 Tüm İstemciler (Broadcast)</option>';

        if (latestClients.length === 0) {
          tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; color:var(--text-muted); padding:30px;">Bağlı istemci bekleniyor...</td></tr>';
        } else {
          tbody.innerHTML = latestClients.map(c => {
            targetSelect.innerHTML += \`<option value="\${c.id}">\${c.hostname} (\${c.id})</option>\`;
            
            const drift = c.driftSeconds || 0;
            const absDrift = Math.abs(drift);
            let driftClass = 'drift-ok';
            let driftLabel = 'TAM SENKRON (' + (drift >= 0 ? '+' : '') + drift + 'sn)';
            if (absDrift > 10) {
              driftClass = 'drift-bad';
              driftLabel = 'SAAT FARKLI (' + (drift >= 0 ? '+' : '') + drift + 'sn)';
            } else if (absDrift > 2) {
              driftClass = 'drift-warn';
              driftLabel = 'HAFİF KAYMA (' + (drift >= 0 ? '+' : '') + drift + 'sn)';
            }

            const initClockStr = new Date(c.estimatedClientMs).toLocaleTimeString('tr-TR');

            return \`
              <tr>
                <td>
                  <div style="display:flex; align-items:center;">
                    <span class="pulse-dot \${c.isOnline ? 'pulse-online' : 'pulse-offline'}"></span>
                    <div>
                      <strong style="color:#fff; font-size:14px;">\${c.id}</strong>
                      <div style="font-size:11px; color:var(--text-muted); font-family:'JetBrains Mono';">\${c.hostname} • \${c.ip}</div>
                    </div>
                  </div>
                </td>
                <td>
                  <div class="client-clock-wrap">
                    <div class="client-digital-clock" id="clock-\${c.id}">\${initClockStr}</div>
                    <div style="font-size:11px; color:var(--text-muted); font-family:'JetBrains Mono';">\${c.systemDate || ''}</div>
                  </div>
                </td>
                <td>
                  <span class="drift-tag \${driftClass}">\${driftLabel}</span>
                </td>
                <td>
                  <span style="font-family:'JetBrains Mono'; font-size:11px; color:var(--primary);">v\${c.version || '1.0.0'}</span>
                  <div style="font-size:10px; color:var(--text-muted);">\${c.diffSeconds}sn önce</div>
                </td>
                <td style="text-align:right; white-space:nowrap;">
                  <button class="quick-chip sync-btn" onclick="quickAction('\${c.id}', 'sync-server-time')" title="Sunucu Saatine Anında Eşitle">⚡ Eşitle</button>
                  <button class="quick-chip" onclick="quickAction('\${c.id}', 'sync-ntp')" title="Windows NTP Senkronizasyonu">🌐 NTP</button>
                  <button class="quick-chip" onclick="openTimeModal('\${c.id}')" title="Saati Manuel Değiştir">✏️ Saat Ayarla</button>
                  <button class="quick-chip" onclick="quickAction('\${c.id}', 'clean-temp')" title="Temp Temizle">🧹</button>
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
            const outText = Object.entries(t.results || {}).map(([cId, res]) => \`[\${cId}]:\\n\${res}\`).join('\\n\\n') || 'İstemciye iletiliyor...';
            return \`
              <div style="background:#070b12; border:1px solid var(--border); border-radius:8px; padding:12px;">
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

    async function quickAction(clientId, action, params = {}) {
      await fetch('/api/tasks/dispatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetClientId: clientId, action, params })
      });
      loadDashboard();
    }

    function openTimeModal(clientId) {
      modalTargetClient = clientId;
      document.getElementById('modalTitle').textContent = '✏️ Saat Ayarla (' + (clientId === 'all' ? 'Tüm İstemciler' : clientId) + ')';
      document.getElementById('customTimeInput').value = new Date(Date.now() + serverOffsetMs).toLocaleTimeString('tr-TR');
      document.getElementById('timeModal').style.display = 'flex';
    }

    function closeTimeModal() {
      document.getElementById('timeModal').style.display = 'none';
    }

    async function applyCustomTimeString() {
      const timeString = document.getElementById('customTimeInput').value.trim();
      if (!timeString) return;
      await quickAction(modalTargetClient, 'set-custom-time', { timeString });
      closeTimeModal();
    }

    async function applyTimeOffset(offsetMinutes) {
      await quickAction(modalTargetClient, 'set-custom-time', { offsetMinutes });
      closeTimeModal();
    }

    async function dispatchManualCommand() {
      const targetClientId = document.getElementById('targetClient').value;
      const action = document.getElementById('actionSelect').value;
      const serviceName = document.getElementById('serviceName').value;
      const params = action === 'restart-service' ? { serviceName } : {};
      await quickAction(targetClientId, action, params);
    }

    loadDashboard();
    setInterval(loadDashboard, 2000);
  </script>
</body>
</html>`;
}

server.listen(PORT, '0.0.0.0', () => {
  addLog('system', `WinOps Saat & Sistem Yönetim Sunucusu başlatıldı (v${SERVER_VERSION}) - Port: ${PORT}`);
  console.log(`[WinOps Server v${SERVER_VERSION}] http://0.0.0.0:${PORT} adresinde çalışıyor`);
  sendTelegramNotification(`🚀 *WinOps Yönetim Sunucusu Başlatıldı (v${SERVER_VERSION})*\nPort: ${PORT}`);
});
