/**
 * Enterprise Windows Management Server - shadcn/ui Edition (v1.6.0)
 * Strict Server-Side Sequential Counter (PC-01, PC-02, PC-03...) & Full List Reset
 * Port: 3001
 * Zero external dependencies (native http, https, fs, path, crypto)
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SERVER_VERSION = '1.6.0';
const PORT = process.env.PORT || 3001;
const GITHUB_REPO = process.env.GITHUB_REPO || 'ayazOne/winops';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

// v1.6.0 ile birlikte sıfırdan temiz veritabanı dosyası
const DB_FILE = path.join(__dirname, 'clients-registry-v16.json');

// Storage
const clients = new Map();
const tasks = [];
const eventLogs = [];
const pendingRenames = new Map(); // token -> newId

// Strict Server-Side Counter & Valid Token Registry
let registry = {
  counter: 0,
  tokens: {} // token -> clientId (e.g. "tok_abc123" -> "PC-01")
};

function loadRegistry() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      if (parsed && typeof parsed.counter === 'number') {
        registry = parsed;
      }
    } else {
      saveRegistry();
    }
  } catch (e) {}
}

function saveRegistry() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(registry, null, 2), 'utf8');
  } catch (e) {}
}

loadRegistry();

// Sunucu tarafından sırayla PC-01, PC-02, PC-03 üretir (Hostname aynı olsa bile her kurulum yeni sıra alır!)
function allocateNextClientId() {
  registry.counter += 1;
  const assignedId = 'PC-' + String(registry.counter).padStart(2, '0');
  const token = crypto.randomBytes(8).toString('hex');
  registry.tokens[token] = assignedId;
  saveRegistry();
  return { clientId: assignedId, token };
}

const ALLOWED_ACTIONS = [
  'sync-ntp',
  'sync-server-time',
  'set-custom-time',
  'clean-temp',
  'flush-dns',
  'net-info',
  'process-list',
  'gpupdate',
  'restart-service',
  'sys-info',
  'update-agent'
];

let remoteVersionCache = {
  serverVersion: SERVER_VERSION,
  clientVersion: '1.6.0',
  commitSha: 'main',
  lastChecked: '-'
};
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
  req.on('error', () => {});
  req.write(payload);
  req.end();
}

function getLatestGitCommitSha() {
  return new Promise((resolve) => {
    const req = https.get(
      `https://github.com/${GITHUB_REPO}/info/refs?service=git-upload-pack&t=${Date.now()}`,
      { headers: { 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' } },
      (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk.toString('utf8'); });
        res.on('end', () => {
          const match = data.match(/([0-9a-f]{40})\s+refs\/heads\/main/);
          resolve(match ? match[1] : 'main');
        });
      }
    );
    req.on('error', () => resolve('main'));
    req.setTimeout(8000, () => { req.destroy(); resolve('main'); });
  });
}

function performServerSelfUpdate(newVersion, commitSha) {
  if (isUpdatingServer) return;
  isUpdatingServer = true;
  const ref = commitSha || 'main';
  addLog('system', `[OTA] Yeni sunucu sürümü bulundu (v${newVersion} @ ${ref.slice(0, 7)}). İndiriliyor...`);

  const rawUrl = `https://raw.githubusercontent.com/${GITHUB_REPO}/${ref}/server/server.js?t=${Date.now()}`;
  https.get(rawUrl, (resp) => {
    let code = '';
    resp.on('data', c => { code += c; });
    resp.on('end', () => {
      if (resp.statusCode === 200 && code.includes('Enterprise Windows Management Server')) {
        try {
          const serverPath = path.join(__dirname, 'server.js');
          fs.writeFileSync(serverPath, code, 'utf8');
          addLog('system', `[OTA] Sunucu v${newVersion} sürümüne güncellendi! Yeniden başlatılıyor...`);
          sendTelegramNotification(`🔄 *Sunucu Otomatik Güncellendi (v${SERVER_VERSION} -> v${newVersion})*`);
          setTimeout(() => {
            process.exit(0);
          }, 800);
        } catch (err) {
          isUpdatingServer = false;
          addLog('error', `[OTA Hatası] Dosya yazılamadı: ${err.message}`);
        }
      } else {
        isUpdatingServer = false;
        addLog('error', `[OTA Hatası] Sunucu kodu indirilemedi (HTTP ${resp.statusCode}).`);
      }
    });
  }).on('error', err => {
    isUpdatingServer = false;
    addLog('error', `[OTA Bağlantı Hatası] ${err.message}`);
  });
}

async function checkGitHubVersionAndAutoUpdate() {
  if (isUpdatingServer) return;
  try {
    const sha = await getLatestGitCommitSha();
    const url = `https://raw.githubusercontent.com/${GITHUB_REPO}/${sha}/version.json?t=${Date.now()}`;

    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) return;
          const parsed = JSON.parse(data);
          remoteVersionCache = {
            serverVersion: parsed.serverVersion || SERVER_VERSION,
            clientVersion: parsed.clientVersion || '1.6.0',
            commitSha: sha,
            lastChecked: new Date().toLocaleTimeString('tr-TR')
          };

          if (parsed.serverVersion && parsed.serverVersion !== SERVER_VERSION) {
            performServerSelfUpdate(parsed.serverVersion, sha);
          }
        } catch (e) {}
      });
    }).on('error', () => {});
  } catch (e) {}
}

setTimeout(checkGitHubVersionAndAutoUpdate, 2000);
setInterval(checkGitHubVersionAndAutoUpdate, 10 * 1000);

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

  // 0. Sunucu Tarafından Sıralı Numara Atama (Her çağrıda sıradaki PC-01, PC-02, PC-03... verilir)
  if ((req.method === 'GET' || req.method === 'POST') && pathname === '/api/assign-id') {
    const hostname = url.searchParams.get('hostname') || 'Windows-PC';
    const allocated = allocateNextClientId();
    addLog('system', `Yeni sıra numarası verildi: ${allocated.clientId} (${hostname})`);
    return jsonResponse(res, 200, {
      success: true,
      clientId: allocated.clientId,
      token: allocated.token
    });
  }

  // 0.1 Admin API: Rename Client ID
  if (req.method === 'POST' && pathname === '/api/clients/rename') {
    try {
      const { oldId, newId } = await parseJsonBody(req);
      const cleanOld = (oldId || '').trim();
      const cleanNew = (newId || '').trim();
      if (!cleanOld || !cleanNew) {
        return jsonResponse(res, 400, { error: 'Geçersiz isim.' });
      }
      if (cleanOld === cleanNew) {
        return jsonResponse(res, 200, { success: true });
      }

      const existingClient = clients.get(cleanOld);
      if (existingClient) {
        clients.delete(cleanOld);
        existingClient.id = cleanNew;
        clients.set(cleanNew, existingClient);

        if (existingClient.token && registry.tokens[existingClient.token]) {
          registry.tokens[existingClient.token] = cleanNew;
          saveRegistry();
        }
      }

      // Token bazlı veya eski ID bazlı güncelleme işaretle
      for (const [tok, cId] of Object.entries(registry.tokens)) {
        if (cId === cleanOld) {
          registry.tokens[tok] = cleanNew;
        }
      }
      saveRegistry();
      pendingRenames.set(cleanOld, cleanNew);

      addLog('system', `İstemci adı değiştirildi: [${cleanOld}] -> [${cleanNew}]`);
      return jsonResponse(res, 200, { success: true, oldId: cleanOld, newId: cleanNew });
    } catch (e) {
      return jsonResponse(res, 400, { error: e.message });
    }
  }

  // 0.2 Admin API: Tekil İstemci Sil veya Tüm Listeyi Sıfırla
  if (req.method === 'POST' && pathname === '/api/clients/reset') {
    try {
      const { clientId } = await parseJsonBody(req);
      if (clientId && clientId !== 'all') {
        const c = clients.get(clientId);
        if (c && c.token) {
          delete registry.tokens[c.token];
        }
        for (const [tok, idVal] of Object.entries(registry.tokens)) {
          if (idVal === clientId) delete registry.tokens[tok];
        }
        clients.delete(clientId);
        saveRegistry();
        addLog('system', `İstemci listeden silindi: [${clientId}]`);
      } else {
        // Tüm listeyi ve sayacı sıfırla (PC-01'den yeniden başlar)
        clients.clear();
        tasks.length = 0;
        registry = { counter: 0, tokens: {} };
        saveRegistry();
        addLog('system', `Tüm istemci listesi ve sıra sayacı sıfırlandı (PC-01'den başlayacak).`);
      }
      return jsonResponse(res, 200, { success: true });
    } catch (e) {
      return jsonResponse(res, 400, { error: e.message });
    }
  }

  // 1. Client Heartbeat
  if (req.method === 'POST' && pathname === '/api/heartbeat') {
    try {
      const data = await parseJsonBody(req);
      const serverNowMs = Date.now();
      const token = (data.token || '').trim();
      let clientId = (data.clientId || '').trim();

      // Yalnızca geçerli bir kayıt token'ına sahip olan (sıfırlama sonrası eklenen) istemcileri kabul et!
      if (!token || !registry.tokens[token]) {
        return jsonResponse(res, 200, {
          success: false,
          unregistered: true,
          expectedClientVersion: remoteVersionCache.clientVersion,
          commitSha: remoteVersionCache.commitSha
        });
      }

      // Sunucudaki güncel adını (token karşılığını) kullan
      const serverAssignedId = registry.tokens[token];
      let assignedClientId = null;
      if (serverAssignedId && serverAssignedId !== clientId) {
        clientId = serverAssignedId;
        assignedClientId = serverAssignedId;
      }

      const existing = clients.get(clientId);
      const isNew = !existing;
      const versionChanged = existing && existing.version !== data.version;

      const clientEpochMs = data.epochMs ? Number(data.epochMs) : serverNowMs;
      const driftSeconds = Number(((clientEpochMs - serverNowMs) / 1000).toFixed(1));

      const clientInfo = {
        id: clientId,
        token,
        hostname: data.hostname || 'Unknown',
        ip: data.ip || req.socket.remoteAddress,
        os: data.os || 'Windows',
        uptime: data.uptime || 'N/A',
        version: data.version || '1.6.0',
        systemTime: data.systemTime || new Date(clientEpochMs).toLocaleTimeString('tr-TR'),
        systemDate: data.systemDate || new Date(clientEpochMs).toISOString().slice(0, 10),
        epochMs: clientEpochMs,
        driftSeconds,
        timeZone: data.timeZone || 'Local',
        lastSeen: new Date().toISOString()
      };
      
      clients.set(clientId, clientInfo);

      if (isNew) {
        addLog('join', `İstemci bağlandı: [${clientId}] (${clientInfo.hostname} - ${clientInfo.ip})`);
        sendTelegramNotification(`🟢 *İstemci Bağlandı:*\nID: \`${clientId}\`\nHost: ${clientInfo.hostname}\nIP: ${clientInfo.ip}\nSaat: ${clientInfo.systemTime}`);
      } else if (versionChanged) {
        addLog('system', `İstemci [${clientId}] güncellendi: v${existing.version} -> v${clientInfo.version}`);
      }

      return jsonResponse(res, 200, {
        success: true,
        registered: true,
        assignedClientId,
        serverEpochMs: Date.now(),
        expectedClientVersion: remoteVersionCache.clientVersion,
        commitSha: remoteVersionCache.commitSha
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

        addLog('task_done', `Görev tamamlandı: [${clientId}] -> ${task.action}`);
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
        createdAt: new Date().toISOString(),
        timeLabel: new Date().toLocaleTimeString('tr-TR')
      };

      tasks.unshift(newTask);
      if (tasks.length > 100) tasks.pop();

      addLog('dispatch', `Komut kuyruğa eklendi: [${action}] -> Hedef: [${newTask.targetClientId}]`);
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

    const clientList = Array.from(clients.values())
      .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
      .map(c => {
        const diffSeconds = Math.floor((now - new Date(c.lastSeen).getTime()) / 1000);
        const isOnline = diffSeconds < 20;
        if (isOnline) onlineCount++;
        const absDrift = Math.abs(c.driftSeconds || 0);
        if (isOnline && absDrift <= 3) syncedCount++;

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
      nextNumber: 'PC-' + String(registry.counter + 1).padStart(2, '0'),
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
<html lang="tr" class="dark">
<head>
  <meta charset="UTF-8">
  <title>WinOps — Saat & Sistem Yönetimi</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #09090b;
      --card: #0c0c0f;
      --card-hover: #121216;
      --muted: #18181b;
      --muted-fg: #a1a1aa;
      --border: #27272a;
      --input: #27272a;
      --fg: #fafafa;
      --primary: #fafafa;
      --primary-fg: #09090b;
      --secondary: #27272a;
      --secondary-fg: #fafafa;
      --emerald: #10b981;
      --amber: #f59e0b;
      --rose: #f43f5e;
      --radius: 0.75rem;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      background-color: var(--bg);
      color: var(--fg);
      min-height: 100vh;
      line-height: 1.5;
      -webkit-font-smoothing: antialiased;
    }

    .navbar {
      position: sticky;
      top: 0;
      z-index: 40;
      backdrop-filter: blur(12px);
      background: rgba(9, 9, 11, 0.85);
      border-bottom: 1px solid var(--border);
      padding: 12px 20px;
    }
    .navbar-inner {
      max-width: 1440px;
      margin: 0 auto;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
    }
    .brand { display: flex; align-items: center; gap: 10px; }
    .brand-icon {
      width: 34px; height: 34px; border-radius: 8px;
      background: var(--fg); color: var(--bg);
      display: flex; align-items: center; justify-content: center;
      font-weight: 700; flex-shrink: 0;
    }
    .brand-text h1 { font-size: 15px; font-weight: 600; letter-spacing: -0.02em; }
    .brand-text p { font-size: 11px; color: var(--muted-fg); font-family: 'JetBrains Mono', monospace; }
    .nav-status { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .badge-outline {
      display: inline-flex; align-items: center; gap: 6px;
      font-size: 11px; font-weight: 500; padding: 4px 10px;
      border-radius: 9999px; border: 1px solid var(--border);
      background: var(--muted); color: var(--fg);
      font-family: 'JetBrains Mono', monospace;
    }
    .dot-live { width: 6px; height: 6px; border-radius: 50%; background: var(--emerald); box-shadow: 0 0 8px var(--emerald); }

    .container {
      max-width: 1440px;
      margin: 0 auto;
      padding: 20px;
      display: flex;
      flex-direction: column;
      gap: 20px;
    }

    .sh-card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      overflow: hidden;
    }
    .sh-card-header {
      padding: 16px 20px;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
    }
    .sh-card-title { font-size: 14px; font-weight: 600; letter-spacing: -0.01em; display: flex; align-items: center; gap: 8px; }
    .sh-card-desc { font-size: 12px; color: var(--muted-fg); }
    .sh-card-body { padding: 20px; }

    .hero-banner {
      display: flex; align-items: center; justify-content: space-between;
      flex-wrap: wrap; gap: 16px; padding: 20px 24px;
      background: linear-gradient(180deg, #121215 0%, #09090b 100%);
    }
    .hero-clock-group { display: flex; align-items: baseline; gap: 16px; flex-wrap: wrap; }
    .hero-clock {
      font-family: 'JetBrains Mono', monospace;
      font-size: 36px; font-weight: 700; letter-spacing: -0.03em;
      color: var(--fg); line-height: 1;
    }
    .hero-date { font-size: 13px; color: var(--muted-fg); }
    .hero-btn-group { display: flex; flex-wrap: wrap; gap: 8px; }

    .btn {
      display: inline-flex; align-items: center; justify-content: center; gap: 6px;
      font-family: inherit; font-size: 13px; font-weight: 500;
      height: 36px; padding: 0 14px; border-radius: 8px;
      cursor: pointer; transition: all 0.15s ease;
      border: 1px solid transparent; white-space: nowrap; text-decoration: none;
    }
    .btn:active { transform: scale(0.98); }
    .btn-primary { background: var(--primary); color: var(--primary-fg); }
    .btn-primary:hover { opacity: 0.9; }
    .btn-secondary { background: var(--secondary); color: var(--secondary-fg); border-color: #3f3f46; }
    .btn-secondary:hover { background: #3f3f46; }
    .btn-outline { background: transparent; color: var(--fg); border-color: var(--border); }
    .btn-outline:hover { background: var(--muted); }
    .btn-danger { background: rgba(244, 63, 94, 0.12); color: #fb7185; border-color: rgba(244, 63, 94, 0.3); }
    .btn-danger:hover { background: var(--rose); color: #fff; }
    .btn-emerald { background: rgba(16, 185, 129, 0.12); color: #34d399; border-color: rgba(16, 185, 129, 0.3); }
    .btn-emerald:hover { background: var(--emerald); color: #09090b; }
    .btn-sm { height: 32px; padding: 0 10px; font-size: 12px; border-radius: 6px; }
    .btn-xs { height: 24px; padding: 0 8px; font-size: 11px; border-radius: 5px; }

    .kpi-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; }
    .kpi-card { padding: 16px 18px; display: flex; flex-direction: column; gap: 6px; }
    .kpi-top { display: flex; align-items: center; justify-content: space-between; font-size: 12px; color: var(--muted-fg); font-weight: 500; }
    .kpi-val { font-size: 26px; font-weight: 700; font-family: 'JetBrains Mono', monospace; letter-spacing: -0.02em; }

    .workspace-grid { display: grid; grid-template-columns: 1.85fr 1fr; gap: 20px; align-items: start; }

    .client-list { display: flex; flex-direction: column; gap: 12px; padding: 16px; }
    .client-item {
      border: 1px solid var(--border); background: #0f0f13;
      border-radius: 10px; padding: 16px;
      display: flex; flex-direction: column; gap: 14px;
      transition: border-color 0.15s;
    }
    .client-item:hover { border-color: #3f3f46; }
    .client-row-top { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
    .client-identity { display: flex; align-items: center; gap: 10px; }
    .status-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
    .status-online { background: var(--emerald); box-shadow: 0 0 10px rgba(16, 185, 129, 0.6); }
    .status-offline { background: var(--rose); }
    .client-name { font-size: 15px; font-weight: 600; color: var(--fg); display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .client-meta { font-size: 12px; color: var(--muted-fg); font-family: 'JetBrains Mono', monospace; }

    .client-clock-panel {
      display: flex; align-items: center; justify-content: space-between;
      gap: 12px; flex-wrap: wrap; background: var(--bg);
      border: 1px solid var(--border); border-radius: 8px; padding: 12px 16px;
    }
    .client-digital { font-family: 'JetBrains Mono', monospace; font-size: 24px; font-weight: 700; color: var(--fg); letter-spacing: -0.02em; }
    .drift-pill { font-family: 'JetBrains Mono', monospace; font-size: 11px; font-weight: 600; padding: 4px 10px; border-radius: 9999px; }
    .drift-ok { background: rgba(16, 185, 129, 0.12); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.25); }
    .drift-warn { background: rgba(245, 158, 11, 0.12); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.25); }
    .drift-bad { background: rgba(244, 63, 94, 0.15); color: #fb7185; border: 1px solid rgba(244, 63, 94, 0.3); }

    .client-actions { display: flex; flex-wrap: wrap; gap: 8px; }

    .form-group { display: flex; flex-direction: column; gap: 6px; margin-bottom: 14px; }
    .form-label { font-size: 12px; font-weight: 500; color: var(--fg); }
    .sh-select, .sh-input {
      width: 100%; height: 38px; padding: 0 12px; border-radius: 8px;
      border: 1px solid var(--border); background: var(--bg); color: var(--fg);
      font-family: inherit; font-size: 13px; outline: none; transition: border-color 0.15s;
    }
    .sh-select:focus, .sh-input:focus { border-color: #71717a; }

    .cmd-preset-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; margin-top: 8px; }

    .terminal-box {
      background: #050507; border: 1px solid var(--border); border-radius: 8px;
      padding: 12px; font-family: 'JetBrains Mono', monospace; font-size: 11.5px;
      color: #d4d4d8; max-height: 220px; overflow-y: auto; white-space: pre-wrap; line-height: 1.5;
    }

    .toast-wrap {
      position: fixed; bottom: 20px; right: 20px; z-index: 100;
      display: flex; flex-direction: column; gap: 8px; pointer-events: none;
    }
    .toast {
      background: var(--fg); color: var(--bg); padding: 10px 16px;
      border-radius: 8px; font-size: 13px; font-weight: 500;
      box-shadow: 0 10px 25px rgba(0,0,0,0.5); animation: slideIn 0.2s ease;
    }
    @keyframes slideIn { from { transform: translateY(12px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }

    .modal-overlay {
      position: fixed; inset: 0; background: rgba(0, 0, 0, 0.8);
      backdrop-filter: blur(4px); display: none; align-items: center;
      justify-content: center; z-index: 90; padding: 16px;
    }
    .modal-dialog {
      background: var(--card); border: 1px solid var(--border);
      border-radius: 12px; width: 100%; max-width: 420px; padding: 20px;
      box-shadow: 0 20px 40px rgba(0,0,0,0.6);
    }
    .offset-btns { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin: 10px 0 16px; }

    @media (max-width: 1024px) {
      .workspace-grid { grid-template-columns: 1fr; }
    }
    @media (max-width: 640px) {
      .container { padding: 12px; gap: 14px; }
      .kpi-grid { grid-template-columns: repeat(2, 1fr); gap: 10px; }
      .hero-banner { padding: 16px; }
      .hero-clock { font-size: 28px; }
      .hero-btn-group { width: 100%; }
      .hero-btn-group .btn { flex: 1; justify-content: center; font-size: 12px; padding: 0 10px; }
      .client-actions .btn-sm { flex: 1 1 calc(50% - 8px); justify-content: center; height: 36px; }
      .cmd-preset-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>

  <nav class="navbar">
    <div class="navbar-inner">
      <div class="brand">
        <div class="brand-icon">W</div>
        <div class="brand-text">
          <h1>WinOps Console</h1>
          <p>v<span id="serverVer">1.6.0</span> • <span id="githubCheckInfo">OTA Aktif</span></p>
        </div>
      </div>
      <div class="nav-status">
        <span class="badge-outline">
          <span>Sıradaki Kayıt: <strong id="nextNumBadge" style="color:var(--emerald);">PC-01</strong></span>
        </span>
        <span class="badge-outline">
          <span class="dot-live"></span>
          <span>10sn GitHub Sync</span>
        </span>
        <button class="btn btn-danger btn-sm" onclick="resetAllClients()">
          🗑️ Listeyi Sıfırla
        </button>
      </div>
    </div>
  </nav>

  <main class="container">

    <section class="sh-card hero-banner">
      <div>
        <div style="font-size:11px; color:var(--muted-fg); text-transform:uppercase; font-weight:600; letter-spacing:0.05em; margin-bottom:4px;">
          Sunucu Referans Saati
        </div>
        <div class="hero-clock-group">
          <div class="hero-clock" id="masterClock">00:00:00</div>
          <div class="hero-date" id="masterDate">Yükleniyor...</div>
        </div>
      </div>
      <div class="hero-btn-group">
        <button class="btn btn-primary" onclick="quickAction('all', 'sync-server-time', {}, 'Tüm istemciler sunucu saatine eşitleniyor')">
          ⚡ Tümünü Sunucu Saatine Eşitle
        </button>
        <button class="btn btn-secondary" onclick="quickAction('all', 'sync-ntp', {}, 'Tüm istemcilere NTP komutu gönderildi')">
          🌐 Tümünü NTP ile Eşitle
        </button>
        <button class="btn btn-outline" onclick="openTimeModal('all')">
          ✏️ Toplu Saat Ayarla
        </button>
      </div>
    </section>

    <section class="kpi-grid">
      <div class="sh-card kpi-card">
        <div class="kpi-top"><span>Toplam Cihaz</span><span>💻</span></div>
        <div class="kpi-val" id="statTotal">0</div>
      </div>
      <div class="sh-card kpi-card">
        <div class="kpi-top"><span>Çevrimiçi</span><span style="color:var(--emerald);">●</span></div>
        <div class="kpi-val" id="statOnline" style="color:var(--emerald);">0</div>
      </div>
      <div class="sh-card kpi-card">
        <div class="kpi-top"><span>Saati Senkron</span><span>⏱️</span></div>
        <div class="kpi-val" id="statSynced">0</div>
      </div>
      <div class="sh-card kpi-card">
        <div class="kpi-top"><span>Çevrimdışı</span><span style="color:var(--rose);">●</span></div>
        <div class="kpi-val" id="statOffline" style="color:var(--rose);">0</div>
      </div>
    </section>

    <div class="workspace-grid">

      <div style="display:flex; flex-direction:column; gap:20px;">
        <div class="sh-card">
          <div class="sh-card-header">
            <div>
              <div class="sh-card-title">İstemci Cihazlar ve Canlı Saatler</div>
              <div class="sh-card-desc">Her yeni kurulum sunucudan sırayla PC-01, PC-02, PC-03 numarası alır.</div>
            </div>
          </div>
          <div class="client-list" id="clientsList">
            <div style="text-align:center; color:var(--muted-fg); padding:32px; font-size:13px;">
              Liste temiz. İlk ekleyeceğiniz bilgisayar otomatik olarak <strong>PC-01</strong> adını alacak.
            </div>
          </div>
        </div>

        <div class="sh-card">
          <div class="sh-card-header">
            <div class="sh-card-title">Canlı Sistem Akışı (Event Log)</div>
          </div>
          <div class="sh-card-body" style="padding:14px;">
            <div class="terminal-box" id="logStream">Henüz kayıt yok.</div>
          </div>
        </div>
      </div>

      <div style="display:flex; flex-direction:column; gap:20px;">

        <div class="sh-card">
          <div class="sh-card-header">
            <div>
              <div class="sh-card-title">Hızlı Sistem & CMD Araçları</div>
              <div class="sh-card-desc">Seçili cihaza güvenli sistem ve ağ komutları gönderin.</div>
            </div>
          </div>
          <div class="sh-card-body">
            <div class="form-group">
              <label class="form-label">Hedef Bilgisayar</label>
              <select class="sh-select" id="targetClient">
                <option value="all">📢 Tüm İstemciler (Broadcast)</option>
              </select>
            </div>

            <label class="form-label">Hazır CMD & Bakım Komutları</label>
            <div class="cmd-preset-grid">
              <button class="btn btn-secondary btn-sm" onclick="runSelectedTarget('sys-info', {}, 'Donanım raporu istendi')">
                📊 Sistem & RAM Raporu
              </button>
              <button class="btn btn-secondary btn-sm" onclick="runSelectedTarget('flush-dns', {}, 'DNS önbelleği temizleniyor')">
                🌐 ipconfig /flushdns
              </button>
              <button class="btn btn-secondary btn-sm" onclick="runSelectedTarget('net-info', {}, 'Ağ yapılandırması çekiliyor')">
                📡 ipconfig /all
              </button>
              <button class="btn btn-secondary btn-sm" onclick="runSelectedTarget('process-list', {}, 'Çalışan süreç listesi istendi')">
                ⚙️ Çalışan Süreçler (Tasklist)
              </button>
              <button class="btn btn-secondary btn-sm" onclick="runSelectedTarget('clean-temp', {}, 'Temp temizliği başlatıldı')">
                🧹 Temp & Cache Temizle
              </button>
              <button class="btn btn-secondary btn-sm" onclick="runSelectedTarget('gpupdate', {}, 'Grup ilkeleri güncelleniyor')">
                🛡️ gpupdate /force
              </button>
            </div>

            <div style="border-top:1px solid var(--border); margin:16px 0; padding-top:14px;">
              <label class="form-label" style="margin-bottom:6px; display:block;">Windows Servisi Yeniden Başlat</label>
              <div style="display:flex; gap:8px;">
                <input type="text" class="sh-input" id="serviceName" placeholder="Örn: Spooler, w32time" value="w32time">
                <button class="btn btn-primary" onclick="restartSelectedService()">Başlat</button>
              </div>
            </div>
          </div>
        </div>

        <div class="sh-card">
          <div class="sh-card-header">
            <div>
              <div class="sh-card-title">Komut Çıktıları ve Raporlar</div>
              <div class="sh-card-desc">İstemcilerden dönen son işlem sonuçları.</div>
            </div>
          </div>
          <div class="sh-card-body" id="tasksList" style="display:flex; flex-direction:column; gap:12px; max-height:480px; overflow-y:auto;">
            <span style="color:var(--muted-fg); font-size:12px;">Henüz bir görev çalıştırılmadı.</span>
          </div>
        </div>

      </div>

    </div>
  </main>

  <!-- Modal: Set Custom Time -->
  <div class="modal-overlay" id="timeModal">
    <div class="modal-dialog">
      <h3 style="font-size:16px; font-weight:600; margin-bottom:4px;" id="modalTitle">Saat Ayarla</h3>
      <p style="font-size:12px; color:var(--muted-fg); margin-bottom:16px;">İstemci saatini doğrudan belirleyin veya dakika bazlı kaydırın.</p>

      <div class="form-group">
        <label class="form-label">Tam Saat Girin (SS:DD:SN)</label>
        <div style="display:flex; gap:8px;">
          <input type="text" class="sh-input" id="customTimeInput" placeholder="14:30:00">
          <button class="btn btn-primary" onclick="applyCustomTimeString()">Uygula</button>
        </div>
      </div>

      <label class="form-label">Hızlı İleri / Geri Kaydır</label>
      <div class="offset-btns">
        <button class="btn btn-secondary btn-sm" onclick="applyTimeOffset(-60)">-1 Saat</button>
        <button class="btn btn-secondary btn-sm" onclick="applyTimeOffset(-5)">-5 Dk</button>
        <button class="btn btn-secondary btn-sm" onclick="applyTimeOffset(5)">+5 Dk</button>
        <button class="btn btn-secondary btn-sm" onclick="applyTimeOffset(60)">+1 Saat</button>
      </div>

      <button class="btn btn-outline" style="width:100%;" onclick="closeTimeModal()">Vazgeç</button>
    </div>
  </div>

  <!-- Modal: Rename Client ID -->
  <div class="modal-overlay" id="renameModal">
    <div class="modal-dialog">
      <h3 style="font-size:16px; font-weight:600; margin-bottom:4px;">İstemci Adını Düzenle</h3>
      <p style="font-size:12px; color:var(--muted-fg); margin-bottom:16px;">Cihazın listedeki adını değiştirin (Örn: PC-02, MUHASEBE-01). İstemci otomatik güncellenir.</p>

      <div class="form-group">
        <label class="form-label">Yeni İstemci Adı (ID)</label>
        <input type="text" class="sh-input" id="renameInput" placeholder="Örn: PC-02">
      </div>

      <div style="display:flex; gap:8px;">
        <button class="btn btn-outline" style="flex:1;" onclick="closeRenameModal()">Vazgeç</button>
        <button class="btn btn-primary" style="flex:1;" onclick="submitRenameClient()">Kaydet</button>
      </div>
    </div>
  </div>

  <div class="toast-wrap" id="toastWrap"></div>

  <script>
    let initialServerVersion = null;
    let serverOffsetMs = 0;
    let latestClients = [];
    let lastFetchLocalMs = Date.now();
    let modalTargetClient = 'all';
    let renameOldId = '';

    function showToast(msg) {
      const wrap = document.getElementById('toastWrap');
      const el = document.createElement('div');
      el.className = 'toast';
      el.textContent = '✓ ' + msg;
      wrap.appendChild(el);
      setTimeout(() => el.remove(), 3000);
    }

    function tickClocks() {
      const nowServer = new Date(Date.now() + serverOffsetMs);
      document.getElementById('masterClock').textContent = nowServer.toLocaleTimeString('tr-TR');
      document.getElementById('masterDate').textContent = nowServer.toLocaleDateString('tr-TR', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
      });

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

        document.getElementById('serverVer').textContent = data.serverVersion;
        document.getElementById('statTotal').textContent = data.stats.total;
        document.getElementById('statOnline').textContent = data.stats.online;
        document.getElementById('statSynced').textContent = data.stats.synced;
        document.getElementById('statOffline').textContent = data.stats.offline;
        if (data.nextNumber) {
          document.getElementById('nextNumBadge').textContent = data.nextNumber;
        }

        if (data.remoteVersion && data.remoteVersion.lastChecked) {
          const shortSha = (data.remoteVersion.commitSha || '').slice(0, 7);
          document.getElementById('githubCheckInfo').textContent = 'Son Kontrol: ' + data.remoteVersion.lastChecked + ' (' + shortSha + ')';
        }

        const listEl = document.getElementById('clientsList');
        const targetSelect = document.getElementById('targetClient');
        const currentTarget = targetSelect.value;
        targetSelect.innerHTML = '<option value="all">📢 Tüm İstemciler (Broadcast)</option>';

        if (latestClients.length === 0) {
          listEl.innerHTML = '<div style="text-align:center; color:var(--muted-fg); padding:32px; font-size:13px;">Liste temiz. İlk ekleyeceğiniz bilgisayar otomatik olarak <strong>' + (data.nextNumber || 'PC-01') + '</strong> adını alacak.</div>';
        } else {
          listEl.innerHTML = latestClients.map(c => {
            targetSelect.innerHTML += \`<option value="\${c.id}">\${c.id} (\${c.hostname} - \${c.ip})</option>\`;

            const drift = c.driftSeconds || 0;
            const absDrift = Math.abs(drift);
            let driftClass = 'drift-ok';
            let driftLabel = 'Tam Senkron (' + (drift >= 0 ? '+' : '') + drift + 'sn)';
            if (absDrift > 10) {
              driftClass = 'drift-bad';
              driftLabel = 'Saat Farklı (' + (drift >= 0 ? '+' : '') + drift + 'sn)';
            } else if (absDrift > 2) {
              driftClass = 'drift-warn';
              driftLabel = 'Hafif Kayma (' + (drift >= 0 ? '+' : '') + drift + 'sn)';
            }

            const initClockStr = new Date(c.estimatedClientMs).toLocaleTimeString('tr-TR');

            return \`
              <div class="client-item">
                <div class="client-row-top">
                  <div class="client-identity">
                    <span class="status-dot \${c.isOnline ? 'status-online' : 'status-offline'}"></span>
                    <div>
                      <div class="client-name">
                        <span>\${c.id}</span>
                        <button class="btn btn-outline btn-xs" onclick="openRenameModal('\${c.id}')" title="İstemci Adını Değiştir">
                          ✏️ Adı Düzenle
                        </button>
                        <button class="btn btn-danger btn-xs" onclick="removeSingleClient('\${c.id}')" title="Listeden Sil">
                          ✕
                        </button>
                        <span class="badge-outline" style="font-size:10px; padding:1px 7px;">v\${c.version || '1.0.0'}</span>
                      </div>
                      <div class="client-meta">\${c.hostname} • \${c.ip} • \${c.diffSeconds}sn önce</div>
                    </div>
                  </div>
                  <span class="drift-pill \${driftClass}">\${driftLabel}</span>
                </div>

                <div class="client-clock-panel">
                  <div>
                    <div style="font-size:10px; color:var(--muted-fg); text-transform:uppercase; font-weight:600;">İstemci Canlı Saati</div>
                    <div class="client-digital" id="clock-\${c.id}">\${initClockStr}</div>
                  </div>
                  <div style="text-align:right; font-family:'JetBrains Mono', monospace; font-size:12px; color:var(--muted-fg);">
                    <div>\${c.systemDate || ''}</div>
                    <div style="font-size:11px;">Uptime: \${c.uptime || '-'}</div>
                  </div>
                </div>

                <div class="client-actions">
                  <button class="btn btn-emerald btn-sm" onclick="quickAction('\${c.id}', 'sync-server-time', {}, '\${c.id} sunucu saatine eşitleniyor')">
                    ⚡ Saati Eşitle
                  </button>
                  <button class="btn btn-secondary btn-sm" onclick="openTimeModal('\${c.id}')">
                    ✏️ Saat Ayarla
                  </button>
                  <button class="btn btn-outline btn-sm" onclick="quickAction('\${c.id}', 'sync-ntp', {}, '\${c.id} NTP senkronizasyonu başlatıldı')">
                    🌐 NTP Sync
                  </button>
                  <button class="btn btn-outline btn-sm" onclick="quickAction('\${c.id}', 'sys-info', {}, '\${c.id} sistem raporu istendi')">
                    📊 Sistem Raporu
                  </button>
                  <button class="btn btn-outline btn-sm" onclick="quickAction('\${c.id}', 'flush-dns', {}, '\${c.id} DNS önbelleği temizleniyor')">
                    🌐 DNS Temizle
                  </button>
                </div>
              </div>
            \`;
          }).join('');
        }
        targetSelect.value = currentTarget;

        const logStream = document.getElementById('logStream');
        if (data.logs && data.logs.length > 0) {
          logStream.textContent = data.logs.map(l => \`[\${l.time}] \${l.message}\`).join('\\n');
        }

        const tasksDiv = document.getElementById('tasksList');
        if (data.tasks.length === 0) {
          tasksDiv.innerHTML = '<span style="color:var(--muted-fg); font-size:12px;">Henüz bir görev çalıştırılmadı.</span>';
        } else {
          tasksDiv.innerHTML = data.tasks.map(t => {
            const outText = Object.entries(t.results || {}).map(([cId, res]) => \`[\${cId}]:\\n\${res}\`).join('\\n\\n') || 'İstemci yanıtı bekleniyor...';
            return \`
              <div style="border:1px solid var(--border); border-radius:8px; padding:12px; background:#09090b;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; font-size:12px;">
                  <span style="font-weight:600; font-family:'JetBrains Mono', monospace;">\${t.action}</span>
                  <span style="color:var(--muted-fg); font-size:11px;">Hedef: \${t.targetClientId} • \${t.status}</span>
                </div>
                <div class="terminal-box" style="max-height:140px;">\${outText}</div>
              </div>
            \`;
          }).join('');
        }
      } catch (e) {}
    }

    async function quickAction(clientId, action, params = {}, toastMsg = '') {
      if (toastMsg) showToast(toastMsg);
      await fetch('/api/tasks/dispatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetClientId: clientId, action, params })
      });
      loadDashboard();
    }

    async function resetAllClients() {
      if (!confirm('Tüm istemci listesi sıfırlansın ve sayaç PC-01 olarak baştan başlasın mı?')) return;
      await fetch('/api/clients/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: 'all' })
      });
      showToast('Liste sıfırlandı! Sıradaki cihaz PC-01 olacak.');
      loadDashboard();
    }

    async function removeSingleClient(clientId) {
      if (!confirm(clientId + ' listeden silinsin mi?')) return;
      await fetch('/api/clients/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId })
      });
      showToast(clientId + ' listeden silindi.');
      loadDashboard();
    }

    function runSelectedTarget(action, params = {}, label = '') {
      const target = document.getElementById('targetClient').value;
      quickAction(target, action, params, label + ' (' + target + ')');
    }

    function restartSelectedService() {
      const target = document.getElementById('targetClient').value;
      const serviceName = document.getElementById('serviceName').value.trim();
      if (!serviceName) return;
      quickAction(target, 'restart-service', { serviceName }, serviceName + ' servisi yeniden başlatılıyor');
    }

    function openTimeModal(clientId) {
      modalTargetClient = clientId;
      document.getElementById('modalTitle').textContent = 'Saat Ayarla — ' + (clientId === 'all' ? 'Tüm İstemciler' : clientId);
      document.getElementById('customTimeInput').value = new Date(Date.now() + serverOffsetMs).toLocaleTimeString('tr-TR');
      document.getElementById('timeModal').style.display = 'flex';
    }

    function closeTimeModal() {
      document.getElementById('timeModal').style.display = 'none';
    }

    function openRenameModal(oldId) {
      renameOldId = oldId;
      document.getElementById('renameInput').value = oldId;
      document.getElementById('renameModal').style.display = 'flex';
      setTimeout(() => document.getElementById('renameInput').focus(), 50);
    }

    function closeRenameModal() {
      document.getElementById('renameModal').style.display = 'none';
    }

    async function submitRenameClient() {
      const newId = document.getElementById('renameInput').value.trim();
      if (!newId) return;
      const res = await fetch('/api/clients/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oldId: renameOldId, newId })
      });
      const data = await res.json();
      if (data.success) {
        showToast(renameOldId + ' -> ' + newId + ' olarak değiştirildi');
        closeRenameModal();
        loadDashboard();
      } else {
        alert(data.error || 'Hata oluştu');
      }
    }

    async function applyCustomTimeString() {
      const timeString = document.getElementById('customTimeInput').value.trim();
      if (!timeString) return;
      await quickAction(modalTargetClient, 'set-custom-time', { timeString }, 'Yeni saat ayarlandı: ' + timeString);
      closeTimeModal();
    }

    async function applyTimeOffset(offsetMinutes) {
      const sign = offsetMinutes > 0 ? '+' : '';
      await quickAction(modalTargetClient, 'set-custom-time', { offsetMinutes }, 'Saat kaydırıldı (' + sign + offsetMinutes + ' dk)');
      closeTimeModal();
    }

    loadDashboard();
    setInterval(loadDashboard, 2000);
  </script>
</body>
</html>`;
}

server.listen(PORT, '0.0.0.0', () => {
  addLog('system', `WinOps v${SERVER_VERSION} başlatıldı (Liste sıfırlandı, sıradaki kayıt: PC-01) - Port: ${PORT}`);
  console.log(`[WinOps Server v${SERVER_VERSION}] http://0.0.0.0:${PORT} adresinde çalışıyor`);
  sendTelegramNotification(`🚀 *WinOps Yönetim Sunucusu Başlatıldı (v${SERVER_VERSION})*\nPort: ${PORT}`);
});
