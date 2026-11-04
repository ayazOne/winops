/**
 * Enterprise Windows Management Server with GitHub OTA Support
 * Port: 3000
 * Zero external dependencies (native http, https, fs, path, crypto)
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const SERVER_VERSION = '1.0.0';
const PORT = process.env.PORT || 3000;
const GITHUB_REPO = process.env.GITHUB_REPO || 'ayazOne/winops';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

// Storage
const clients = new Map();
const tasks = [];
const ALLOWED_ACTIONS = ['sync-ntp', 'clean-temp', 'restart-service', 'sys-info', 'update-agent'];

// Remote Version Cache
let remoteVersionCache = { serverVersion: SERVER_VERSION, clientVersion: '1.0.0', lastChecked: 0 };

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

// Check on boot and every 15 minutes
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
      const clientInfo = {
        id: clientId,
        hostname: data.hostname || 'Unknown',
        ip: data.ip || req.socket.remoteAddress,
        os: data.os || 'Windows',
        uptime: data.uptime || 'N/A',
        version: data.version || '1.0.0',
        lastSeen: new Date().toISOString()
      };
      
      const isNew = !clients.has(clientId);
      clients.set(clientId, clientInfo);

      if (isNew) {
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

      sendTelegramNotification(`🚀 *Yeni Görev Kuyrukta:*\nKomut: *${action}*\nHedef: \`${newTask.targetClientId}\``);
      return jsonResponse(res, 200, { success: true, task: newTask });
    } catch (e) {
      return jsonResponse(res, 400, { error: e.message });
    }
  }

  // 5. Server OTA Self-Update Trigger
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
            sendTelegramNotification(`🔄 *Sunucu GitHub üzerinden güncellendi ve yeniden başlatılıyor...*`);
            jsonResponse(res, 200, { success: true, message: 'Sunucu güncellendi, yeniden başlatılıyor.' });

            // Restart process via exit (Task Scheduler or wrapper service will restart it)
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
    const clientList = Array.from(clients.values()).map(c => {
      const diffSeconds = Math.floor((now - new Date(c.lastSeen).getTime()) / 1000);
      return {
        ...c,
        isOnline: diffSeconds < 90,
        diffSeconds
      };
    });

    return jsonResponse(res, 200, {
      clients: clientList,
      tasks: tasks.slice(0, 30),
      allowedActions: ALLOWED_ACTIONS,
      serverVersion: SERVER_VERSION,
      githubRepo: GITHUB_REPO,
      remoteVersion: remoteVersionCache
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
  <title>WinOps Merkezi Yönetim Paneli</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #0f172a; --card: #1e293b; --border: #334155; --text: #f8fafc;
      --text-muted: #94a3b8; --primary: #38bdf8; --success: #22c55e; --danger: #ef4444; --warning: #f59e0b;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Inter', sans-serif; background: var(--bg); color: var(--text); padding: 24px; }
    .container { max-width: 1200px; margin: 0 auto; }
    header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; padding-bottom: 16px; border-bottom: 1px solid var(--border); }
    h1 { font-size: 24px; display: flex; align-items: center; gap: 10px; }
    .badge { font-size: 11px; padding: 3px 8px; border-radius: 9999px; font-weight: 600; }
    .badge-online { background: rgba(34, 197, 94, 0.2); color: var(--success); }
    .badge-offline { background: rgba(239, 68, 68, 0.2); color: var(--danger); }
    .badge-ver { background: rgba(56, 189, 248, 0.15); color: var(--primary); }
    .update-banner { background: rgba(245, 158, 11, 0.15); border: 1px solid var(--warning); border-radius: 8px; padding: 12px 16px; margin-bottom: 20px; display: none; justify-content: space-between; align-items: center; }
    .grid { display: grid; grid-template-columns: 2fr 1fr; gap: 24px; margin-bottom: 24px; }
    @media (max-width: 900px) { .grid { grid-template-columns: 1fr; } }
    .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 20px; }
    .card h2 { font-size: 18px; margin-bottom: 16px; display: flex; justify-content: space-between; align-items: center; }
    table { width: 100%; border-collapse: collapse; text-align: left; }
    th, td { padding: 12px 14px; border-bottom: 1px solid var(--border); font-size: 14px; }
    th { color: var(--text-muted); font-weight: 500; }
    select, input, button { width: 100%; padding: 10px 14px; border-radius: 8px; border: 1px solid var(--border); background: #0f172a; color: #fff; margin-bottom: 12px; font-size: 14px; }
    button { background: var(--primary); color: #0f172a; font-weight: 600; cursor: pointer; border: none; transition: 0.2s; }
    button:hover { opacity: 0.9; }
    .btn-secondary { background: #334155; color: #fff; font-size: 13px; padding: 6px 12px; width: auto; margin-bottom: 0; }
    pre { background: #0b1120; padding: 12px; border-radius: 8px; font-size: 12px; overflow-x: auto; max-height: 160px; color: #38bdf8; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div>
        <h1>🪟 WinOps Yönetim Paneli</h1>
        <span style="color: var(--text-muted); font-size: 13px;">Sunucu: <strong id="serverVerDisplay">v1.0.0</strong> | GitHub: <a href="https://github.com/ayazOne/winops" target="_blank" style="color:var(--primary); text-decoration:none;">ayazOne/winops</a></span>
      </div>
      <div>
        <button class="btn-secondary" onclick="updateAllClients()">🚀 Tüm İstemcileri Güncelle (OTA)</button>
      </div>
    </header>

    <div id="updateBanner" class="update-banner">
      <span id="updateBannerText">🔔 GitHub'da yeni bir sunucu sürümü mevcut!</span>
      <button onclick="updateServer()" style="width:auto; padding:6px 16px; margin-bottom:0; background:var(--warning); color:#000;">Sunucuyu Güncelle</button>
    </div>

    <div class="grid">
      <div class="card">
        <h2>Aktif İstemciler (Clients)</h2>
        <table>
          <thead>
            <tr>
              <th>Durum</th>
              <th>İstemci ID</th>
              <th>Host Adı</th>
              <th>IP Adresi</th>
              <th>Sürüm</th>
              <th>Son Görülme</th>
            </tr>
          </thead>
          <tbody id="clientsTable">
            <tr><td colspan="6" style="text-align:center; color: var(--text-muted);">Yükleniyor...</td></tr>
          </tbody>
        </table>
      </div>

      <div class="card">
        <h2>Bakım Komutu Gönder</h2>
        <label style="font-size:12px; color:var(--text-muted);">Hedef İstemci</label>
        <select id="targetClient">
          <option value="all">📢 Tüm İstemciler (Broadcast)</option>
        </select>

        <label style="font-size:12px; color:var(--text-muted);">Bakım Eylemi</label>
        <select id="actionSelect">
          <option value="sync-ntp">⏰ Saat Senkronizasyonu (NTP Sync)</option>
          <option value="clean-temp">🧹 Önbellek & Temp Temizliği</option>
          <option value="sys-info">📊 Donanım / Sistem Durumu Raporu</option>
          <option value="restart-service">🔄 Servis Yeniden Başlat (Spooler vb.)</option>
          <option value="update-agent">🚀 Ajanı Güncelle (OTA Update)</option>
        </select>

        <div id="serviceParamDiv" style="display:none;">
          <label style="font-size:12px; color:var(--text-muted);">Servis Adı</label>
          <input type="text" id="serviceName" placeholder="Örn: Spooler, wuauserv" value="Spooler">
        </div>

        <button onclick="dispatchCommand()">Komutu Kuyruğa Gönder</button>
      </div>
    </div>

    <div class="card">
      <h2>Son Görevler ve Operasyon Raporları</h2>
      <div id="tasksList" style="display:flex; flex-direction:column; gap:12px;"></div>
    </div>
  </div>

  <script>
    document.getElementById('actionSelect').addEventListener('change', function() {
      document.getElementById('serviceParamDiv').style.display = this.value === 'restart-service' ? 'block' : 'none';
    });

    async function loadData() {
      try {
        const res = await fetch('/api/dashboard-data');
        const data = await res.json();

        document.getElementById('serverVerDisplay').textContent = 'v' + data.serverVersion;

        // Remote update check
        if (data.remoteVersion && data.remoteVersion.serverVersion && data.remoteVersion.serverVersion !== data.serverVersion) {
          const banner = document.getElementById('updateBanner');
          document.getElementById('updateBannerText').textContent = '🔔 GitHub üzerinde yeni sunucu sürümü mevcut: v' + data.remoteVersion.serverVersion;
          banner.style.display = 'flex';
        }

        // Clients Table
        const tbody = document.getElementById('clientsTable');
        const targetSelect = document.getElementById('targetClient');
        const currentSelected = targetSelect.value;
        
        targetSelect.innerHTML = '<option value="all">📢 Tüm İstemciler (Broadcast)</option>';

        if (data.clients.length === 0) {
          tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; color: var(--text-muted);">Kayıtlı istemci yok.</td></tr>';
        } else {
          tbody.innerHTML = data.clients.map(c => {
            targetSelect.innerHTML += \`<option value="\${c.id}">\${c.hostname} (\${c.id})</option>\`;
            return \`
              <tr>
                <td><span class="badge \${c.isOnline ? 'badge-online' : 'badge-offline'}">\${c.isOnline ? 'ONLINE' : 'OFFLINE'}</span></td>
                <td><strong>\${c.id}</strong></td>
                <td>\${c.hostname}</td>
                <td>\${c.ip}</td>
                <td><span class="badge badge-ver">v\${c.version || '1.0.0'}</span></td>
                <td>\${c.diffSeconds}s önce</td>
              </tr>
            \`;
          }).join('');
        }
        targetSelect.value = currentSelected;

        // Tasks List
        const tasksDiv = document.getElementById('tasksList');
        if (data.tasks.length === 0) {
          tasksDiv.innerHTML = '<span style="color:var(--text-muted);">Henüz bir görev yürütülmedi.</span>';
        } else {
          tasksDiv.innerHTML = data.tasks.map(t => {
            const resultsJson = JSON.stringify(t.results || {}, null, 2);
            return \`
              <div style="background:#0f172a; padding:12px; border-radius:8px; border:1px solid var(--border);">
                <div style="display:flex; justify-content:space-between; margin-bottom:6px;">
                  <strong>Komut: \${t.action}</strong>
                  <span style="font-size:12px; color:var(--text-muted);">Hedef: \${t.targetClientId} | Durum: \${t.status}</span>
                </div>
                <pre>\${resultsJson !== '{}' ? resultsJson : 'Bekleniyor...'}</pre>
              </div>
            \`;
          }).join('');
        }
      } catch (e) {
        console.error('Yükleme hatası:', e);
      }
    }

    async function dispatchCommand() {
      const targetClientId = document.getElementById('targetClient').value;
      const action = document.getElementById('actionSelect').value;
      const serviceName = document.getElementById('serviceName').value;
      const params = action === 'restart-service' ? { serviceName } : {};

      const res = await fetch('/api/tasks/dispatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetClientId, action, params })
      });

      const resData = await res.json();
      if (resData.success) {
        alert('Komut başarıyla kuyruğa eklendi!');
        loadData();
      } else {
        alert('Hata: ' + resData.error);
      }
    }

    async function updateAllClients() {
      if (!confirm('Tüm aktif istemcilere GitHub üzerinden güncelleme komutu gönderilsin mi?')) return;
      const res = await fetch('/api/tasks/dispatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetClientId: 'all', action: 'update-agent' })
      });
      alert('Güncelleme görevi kuyruğa alındı. İstemciler sırayla güncellenip yeniden başlayacak.');
      loadData();
    }

    async function updateServer() {
      if (!confirm('Sunucu GitHub üzerinden en son sürüme güncellenip yeniden başlatılsın mı?')) return;
      const res = await fetch('/api/server/self-update', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        alert('Sunucu güncelleniyor. Sayfa 5 saniye sonra yenilenecek.');
        setTimeout(() => location.reload(), 5000);
      } else {
        alert('Hata: ' + data.error);
      }
    }

    loadData();
    setInterval(loadData, 5000);
  </script>
</body>
</html>`;
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[WinOps Server v${SERVER_VERSION}] http://0.0.0.0:${PORT} adresinde çalışıyor`);
  sendTelegramNotification(`🚀 *WinOps Yönetim Sunucusu Başlatıldı (v${SERVER_VERSION})*\nPort: ${PORT}`);
});
