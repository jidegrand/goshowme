const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const TOKEN_TTL_MS = 30 * 60 * 1000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

// In-memory token store (use Redis in production)
const sessions = new Map();
// token -> { createdAt, ttl, techWs, userWs, used, expired }

function generateToken() {
  return crypto.randomBytes(16).toString('hex');
}

function createSession(ttlMs = TOKEN_TTL_MS) {
  const token = generateToken();
  const session = {
    token,
    createdAt: Date.now(),
    ttl: ttlMs,
    techWs: null,
    userWs: null,
    techAlive: false,
    expired: false,
    label: null,
  };
  sessions.set(token, session);

  // Auto-expire
  setTimeout(() => {
    const s = sessions.get(token);
    if (s) {
      s.expired = true;
      if (s.techWs) safeSend(s.techWs, { type: 'session_expired', token });
      if (s.userWs) safeSend(s.userWs, { type: 'session_expired' });
      sessions.delete(token);
    }
  }, ttlMs);

  return session;
}

function safeSend(ws, data) {
  try {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(data));
  } catch (_) {}
}

// ── HTTP server ──────────────────────────────────────────────────────────────

const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
};

const httpServer = http.createServer((req, res) => {
  const url = new URL(req.url, BASE_URL);

  // REST: create session
  if (req.method === 'POST' && url.pathname === '/api/session') {
    let body = '';
    req.on('data', d => (body += d));
    req.on('end', () => {
      const { ttl, label } = JSON.parse(body || '{}');
      const session = createSession(ttl ? Number(ttl) * 60 * 1000 : TOKEN_TTL_MS);
      session.label = label || 'Unnamed session';
      const proto = req.headers['x-forwarded-proto'] || 'http';
      const host = req.headers['x-forwarded-host'] || req.headers.host;
      const joinBase = `${proto}://${host}`;
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({
        token: session.token,
        url: `${joinBase}/join/${session.token}`,
        expiresAt: Date.now() + session.ttl,
      }));
    });
    return;
  }

  // REST: ICE servers (STUN + TURN). Served to both tech and user clients
  // so they construct RTCPeerConnection with the same config.
  //
  // Configure TURN via env vars on Railway:
  //   TURN_URL         — comma-separated turn: URLs, e.g.
  //                      "turn:global.turn.twilio.com:3478?transport=udp,turn:global.turn.twilio.com:3478?transport=tcp"
  //   TURN_USERNAME    — TURN username / credential key
  //   TURN_CREDENTIAL  — TURN password / credential
  //
  // Without these, we fall back to Open Relay Project (free public TURN,
  // rate-limited — fine for testing, swap in Twilio/Xirsys for production).
  if (req.method === 'GET' && url.pathname === '/api/ice-servers') {
    const iceServers = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ];

    if (process.env.TURN_URL && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
      iceServers.push({
        urls: process.env.TURN_URL.split(',').map(u => u.trim()).filter(Boolean),
        username: process.env.TURN_USERNAME,
        credential: process.env.TURN_CREDENTIAL,
      });
    } else {
      // Fallback: Open Relay Project. Heavily rate-limited — replace in production.
      iceServers.push({
        urls: [
          'turn:openrelay.metered.ca:80',
          'turn:openrelay.metered.ca:443',
          'turn:openrelay.metered.ca:443?transport=tcp',
        ],
        username: 'openrelayproject',
        credential: 'openrelayproject',
      });
    }

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify({ iceServers }));
    return;
  }

  // REST: session status
  if (req.method === 'GET' && url.pathname.startsWith('/api/session/')) {
    const token = url.pathname.split('/')[3];
    const s = sessions.get(token);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (!s) return res.end(JSON.stringify({ valid: false }));
    res.end(JSON.stringify({
      valid: true,
      label: s.label,
      techOnline: s.techAlive,
      expiresAt: s.createdAt + s.ttl,
    }));
    return;
  }

  // REST: AI vision proxy — keeps API key server-side
  if (req.method === 'POST' && url.pathname === '/api/ai/analyze') {
    if (!ANTHROPIC_API_KEY) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'ANTHROPIC_API_KEY not set on server.' }));
    }

    let body = '';
    req.on('data', d => (body += d));
    req.on('end', () => {
      // Validate request has expected shape — image + prompt only
      let parsed;
      try { parsed = JSON.parse(body); } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }

      const { model, max_tokens, messages } = parsed;

      // Safety: only allow vision calls with exactly one user message
      if (!messages || messages.length !== 1 || messages[0].role !== 'user') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Invalid message shape' }));
      }

      const payload = JSON.stringify({ model, max_tokens, messages });

      const options = {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
      };

      const proxyReq = https.request(options, proxyRes => {
        let data = '';
        proxyRes.on('data', chunk => (data += chunk));
        proxyRes.on('end', () => {
          res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json' });
          res.end(data);
        });
      });

      proxyReq.on('error', err => {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Upstream error: ${err.message}` }));
      });

      proxyReq.write(payload);
      proxyReq.end();
    });
    return;
  }

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST', 'Access-Control-Allow-Headers': 'Content-Type' });
    return res.end();
  }

  // Static files
  let filePath = url.pathname;
  if (filePath === '/') filePath = '/index.html';
  else if (filePath.startsWith('/dashboard')) filePath = '/tech.html';
  else if (filePath.startsWith('/join/')) filePath = '/user.html';
  else if (filePath === '/vs-teamviewer') filePath = '/vs-teamviewer.html';

  const fullPath = path.join(__dirname, 'public', filePath);
  const ext = path.extname(fullPath);

  fs.readFile(fullPath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(data);
  });
});

// ── WebSocket signaling ──────────────────────────────────────────────────────

const wss = new WebSocketServer({ server: httpServer });

// Keep Railway's reverse proxy from dropping idle WebSocket connections.
// Native ping frames are handled automatically by browsers (they send pong back).
const pingInterval = setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws._alive) return ws.terminate();
    ws._alive = false;
    ws.ping();
  });
}, 30000);
wss.on('close', () => clearInterval(pingInterval));

wss.on('connection', (ws, req) => {
  ws._session = null;
  ws._role = null;
  ws._alive = true;
  ws.on('pong', () => { ws._alive = true; });

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // ── JOIN ─────────────────────────────────────────────────────────────────
    if (msg.type === 'join') {
      const { token, role } = msg; // role: 'tech' | 'user'
      const session = sessions.get(token);

      if (!session || session.expired) {
        return safeSend(ws, { type: 'error', code: 'INVALID_TOKEN', message: 'Session not found or expired.' });
      }

      ws._session = token;
      ws._role = role;

      if (role === 'tech') {
        if (session.techWs && session.techWs.readyState === 1) {
          return safeSend(ws, { type: 'error', code: 'TECH_ALREADY_JOINED' });
        }
        session.techWs = ws;
        session.techAlive = true;
        safeSend(ws, { type: 'joined', role: 'tech', label: session.label, expiresAt: session.createdAt + session.ttl });
        if (session.userWs) safeSend(ws, { type: 'user_connected' });
      }

      if (role === 'user') {
        session.userWs = ws;
        safeSend(ws, { type: 'joined', role: 'user', label: session.label, expiresAt: session.createdAt + session.ttl });
        if (session.techWs) {
          safeSend(session.techWs, { type: 'user_connected' });
          // Prompt tech to create WebRTC offer
          safeSend(ws, { type: 'ready_to_offer' });
        }
      }
      return;
    }

    // ── RELAY (offer / answer / candidate / end) ─────────────────────────────
    const session = sessions.get(ws._session);
    if (!session) return;

    const peer = ws._role === 'tech' ? session.userWs : session.techWs;

    if (['offer', 'answer', 'candidate', 'annotate', 'recording_started', 'recording_stopped'].includes(msg.type)) {
      safeSend(peer, msg);
      return;
    }

    if (msg.type === 'end') {
      safeSend(peer, { type: 'peer_ended' });
      if (session.techWs) session.techAlive = false;
      sessions.delete(ws._session);
      return;
    }

    if (msg.type === 'ping') {
      safeSend(ws, { type: 'pong' });
    }
  });

  ws.on('close', () => {
    const session = sessions.get(ws._session);
    if (!session) return;
    if (ws._role === 'tech') {
      session.techAlive = false;
      safeSend(session.userWs, { type: 'tech_disconnected' });
    } else {
      safeSend(session.techWs, { type: 'user_disconnected' });
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`\n  Remote Cam Support running`);
  console.log(`  Dashboard : ${BASE_URL}/`);
  console.log(`  Port      : ${PORT}`);
  if (process.env.TURN_URL && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
    console.log(`  TURN      : configured (${process.env.TURN_URL.split(',').length} url(s))`);
  } else {
    console.warn(`  TURN      : ⚠ not configured — using free Open Relay fallback (rate-limited)`);
    console.warn(`              Set TURN_URL / TURN_USERNAME / TURN_CREDENTIAL env vars for production.`);
  }
  console.log('');
});
