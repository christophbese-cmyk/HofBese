const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = 8080;
const DIR = __dirname;
const DATA_FILE = path.join(DIR, 'sync-data.json');
const PIN_CONFIG = path.join(DIR, 'pin-config.json');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.bat': 'application/octet-stream',
  '.kml': 'application/vnd.google-earth.kml+xml',
};

function hashPIN(pin) {
  return crypto.createHash('sha256').update('hofbese-salt-' + pin).digest('hex');
}

function loadPINConfig() {
  try {
    if (fs.existsSync(PIN_CONFIG)) {
      return JSON.parse(fs.readFileSync(PIN_CONFIG, 'utf8'));
    }
  } catch(e) {}
  return { pinHash: null, setup: false };
}

function savePINConfig(config) {
  fs.writeFileSync(PIN_CONFIG, JSON.stringify(config), 'utf8');
}

let pinConfig = loadPINConfig();

// Zentrale Daten
let appData = { customers: [], reservations: [], fields: [], workLogs: [], harvests: [], hallSlots: {} };
let dataVersion = 0;

// Pending sync requests: { device, data, timestamp }
let pendingSync = null;

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      appData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch(e) {}
}
function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(appData), 'utf8');
  dataVersion++;
}

loadData();

const server = http.createServer((req, res) => {
  let url = req.url.split('?')[0];

  // API: IP abrufen (ohne PIN)
  if (url === '/api/ip') {
    const os = require('os');
    const nets = os.networkInterfaces();
    let ip = '127.0.0.1';
    for (const name of Object.keys(nets)) {
      for (const net of nets[name]) {
        if (net.family === 'IPv4' && !net.internal) { ip = net.address; break; }
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ip, port: PORT }));
    return;
  }

  // API: Verbindungsinfo (ohne PIN)
  if (url === '/api/info') {
    const os = require('os');
    const nets = os.networkInterfaces();
    let serverIp = '127.0.0.1';
    let iface = 'unknown';
    for (const name of Object.keys(nets)) {
      for (const net of nets[name]) {
        if (net.family === 'IPv4' && !net.internal) { serverIp = net.address; iface = name; break; }
      }
    }
    const clientIp = req.connection.remoteAddress || req.socket.remoteAddress || '';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      serverIp,
      serverPort: PORT,
      serverInterface: iface,
      clientIp: clientIp.replace('::ffff:', ''),
      timestamp: Date.now()
    }));
    return;
  }

  // API: PIN Status prüfen (ohne PIN)
  if (url === '/api/pin-status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ setup: pinConfig.setup }));
    return;
  }

  // API: PIN einrichten (nur wenn noch nicht gesetzt)
  if (url === '/api/pin-setup' && req.method === 'POST') {
    if (pinConfig.setup) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'PIN bereits gesetzt' }));
      return;
    }
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (!data.pin || !/^\d{4}$/.test(data.pin)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'PIN muss 4 Ziffern sein' }));
          return;
        }
        pinConfig = { pinHash: hashPIN(data.pin), setup: true };
        savePINConfig(pinConfig);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch(e) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Geschützte API-Endpunkte
  if (url === '/api/data' && req.method === 'GET') {
    const pin = req.headers['x-pin'] || '';
    if (pinConfig.setup && (!pin || hashPIN(pin) !== pinConfig.pinHash)) {
      console.log('PIN abgelehnt für GET request');
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'PIN falsch' }));
      return;
    }
    const custCount = (appData.customers || []).length;
    console.log(`GET /api/data: ${custCount} Kunden zurückgegeben`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ version: dataVersion, data: appData }));
    return;
  }

  if (url === '/api/data' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const pin = req.headers['x-pin'] || '';
        if (pinConfig.setup && (!pin || hashPIN(pin) !== pinConfig.pinHash)) {
          console.log('PIN abgelehnt für POST request');
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'PIN falsch' }));
          return;
        }
        const newData = JSON.parse(body);
        const device = req.headers['x-device'] || 'unknown';
        const custCount = (newData.customers || []).length;
        console.log(`POST von ${device}: ${custCount} Kunden`);

        // Prüfen ob PC-Browser bereits verbunden ist
        if (pendingSync && pendingSync.device === device) {
          // PC hat Sync akzeptiert, Daten zurückgeben
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, version: dataVersion, data: appData }));
          pendingSync = null;
          return;
        }

        // Neue Daten vom Handy → direkt als Master übernehmen
        if (newData.customers !== undefined) {
          const isMobile = device && device.toLowerCase().includes('handy');
          if (isMobile) {
            // Handy = Master: Daten direkt übernehmen
            appData = {
              customers: newData.customers || [],
              reservations: newData.reservations || [],
              fields: newData.fields || [],
              workLogs: newData.workLogs || [],
              harvests: newData.harvests || [],
              hallSlots: newData.hallSlots || {}
            };
            saveData();
            console.log(`Handy-Daten von ${device} als Master übernommen (${custCount} Kunden)`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, version: dataVersion, data: appData }));
            return;
          }

          // PC-Daten → als pending speichern
          pendingSync = {
            device: device,
            data: newData,
            timestamp: Date.now()
          };
          console.log(`Sync-Anfrage von ${device} - warte auf PC-Bestätigung`);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, version: dataVersion, pending: pendingSync !== null }));
      } catch(e) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // API: PC fragt nach pending Sync-Anfragen
  if (url === '/api/pending-sync' && req.method === 'GET') {
    if (pendingSync) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ device: pendingSync.device, data: pendingSync.data }));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ device: null }));
    }
    return;
  }

  // API: PC akzeptiert Sync
  if (url === '/api/sync-accept' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const mode = data.mode || 'merge';

        if (pendingSync) {
          const clientData = pendingSync.data;

          if (mode === 'merge') {
            // Kunden mergen
            const customerMap = new Map();
            appData.customers.forEach(c => customerMap.set(c.id, c));
            clientData.customers.forEach(c => customerMap.set(c.id, c));
            appData.customers = [...customerMap.values()];

            // Reservierungen mergen
            const resMap = new Map();
            appData.reservations.forEach(r => resMap.set(r.id, r));
            clientData.reservations.forEach(r => resMap.set(r.id, r));
            appData.reservations = [...resMap.values()];

            // HallSlots mergen
            appData.hallSlots = { ...appData.hallSlots, ...clientData.hallSlots };

            // Felder: längere Liste gewinnt
            if (clientData.fields && clientData.fields.length > appData.fields.length) {
              appData.fields = clientData.fields;
            }
          } else if (mode === 'server') {
            // Server-Daten → Client (nichts tun, Client bekommt Server-Daten)
          } else if (mode === 'client') {
            // Client-Daten → Server (überschreiben)
            appData = {
              customers: clientData.customers || [],
              reservations: clientData.reservations || [],
              fields: clientData.fields || [],
              workLogs: clientData.workLogs || [],
              harvests: clientData.harvests || [],
              hallSlots: clientData.hallSlots || {}
            };
          }

          saveData();
          const result = { ok: true, data: appData };
          pendingSync = null;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, data: appData }));
        }
      } catch(e) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // API: PC lehnt Sync ab
  if (url === '/api/sync-decline' && req.method === 'POST') {
    pendingSync = null;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // Statische Dateien
  if (url === '/') url = '/index.html';
  const filePath = path.join(DIR, url);
  const ext = path.extname(filePath);
  const mime = MIME[ext] || 'application/octet-stream';
  const isHtml = ext === '.html' || url === '/';
  const headers = { 'Content-Type': mime };
  if (isHtml) {
    headers['Cache-Control'] = 'public, max-age=86400';
  } else {
    headers['Cache-Control'] = 'public, max-age=31536000';
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('404 Not Found'); return; }
    res.writeHead(200, headers);
    res.end(data);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`HofBese Server: http://localhost:${PORT}`);
  const os = require('os');
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        console.log(`Handy-URL: http://${net.address}:${PORT}`);
      }
    }
  }
  console.log('');
  if (pinConfig.setup) {
    console.log('PIN-Schutz: AKTIV');
  } else {
    console.log('PIN-Schutz: NICHT EINGERICHTET - wird beim ersten Aufruf eingerichtet');
  }
  console.log('Sync: Manuelles Sync mit Abfrage auf dem PC');
  console.log('QR-Code oeffnen: http://localhost:' + PORT + '/qr-install.html');
});
