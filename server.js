const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const TOKEN_TTL_MS = 30 * 60 * 1000;
const MONTHLY_FREE_LIMIT = 5;
const AUTH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_GRANT_TTL_MS = 2 * 60 * 1000;
const PASSWORD_MIN_LENGTH = 8;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_VISION_MODEL = process.env.ANTHROPIC_VISION_MODEL || 'claude-sonnet-4-20250514';

// In-memory token store (use Redis in production)
const sessions = new Map();
// token -> { createdAt, ttl, techWs, userWs, used, expired }
const leads = new Map();
// email -> { name, passwordSalt, passwordHash, sessionsUsed, firstSeen, lastSeen, accountCreatedAt }
const anonymousSessionCounts = new Map();
// ip -> count
const authTokens = new Map();
// token -> { email, createdAt, expiresAt }
const sessionGrants = new Map();
// grant -> { email, createdAt, expiresAt, used }

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

function writeJson(res, statusCode, payload, headers = {}) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    ...headers,
  });
  res.end(JSON.stringify(payload));
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function normalizeName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ');
}

function isValidName(name) {
  return normalizeName(name).length >= 2;
}

function isValidPassword(password) {
  return typeof password === 'string' && password.length >= PASSWORD_MIN_LENGTH;
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function isSameMonth(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
}

function syncLeadUsage(lead) {
  const now = new Date();
  if (lead.lastSeen) {
    const lastSeen = new Date(lead.lastSeen);
    if (!isSameMonth(lastSeen, now)) {
      lead.sessionsUsed = 0;
    }
  }
  lead.lastSeen = now.toISOString();
  return lead;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, expectedHash) {
  if (!salt || !expectedHash || !password) return false;
  const actualHash = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(actualHash, 'hex'), Buffer.from(expectedHash, 'hex'));
}

function issueAuthToken(email) {
  const token = crypto.randomBytes(24).toString('hex');
  authTokens.set(token, {
    email,
    createdAt: Date.now(),
    expiresAt: Date.now() + AUTH_TOKEN_TTL_MS,
  });
  return token;
}

function readAuthToken(req, parsedBody = null) {
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  if (parsedBody && typeof parsedBody.authToken === 'string') {
    return parsedBody.authToken.trim();
  }
  if (typeof req.headers['x-auth-token'] === 'string') {
    return req.headers['x-auth-token'].trim();
  }
  return '';
}

function getLeadFromAuthToken(token) {
  if (!token) return null;
  const auth = authTokens.get(token);
  if (!auth) return null;
  if (auth.expiresAt <= Date.now()) {
    authTokens.delete(token);
    return null;
  }
  const lead = leads.get(auth.email);
  if (!lead) {
    authTokens.delete(token);
    return null;
  }
  syncLeadUsage(lead);
  return { email: auth.email, lead };
}

function issueSessionGrant(email) {
  const grant = crypto.randomBytes(18).toString('hex');
  sessionGrants.set(grant, {
    email,
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_GRANT_TTL_MS,
    used: false,
  });
  return grant;
}

function consumeSessionGrant(email, grant) {
  if (!grant) return false;
  const record = sessionGrants.get(grant);
  if (!record) return false;
  if (record.used || record.expiresAt <= Date.now() || record.email !== email) {
    sessionGrants.delete(grant);
    return false;
  }
  record.used = true;
  sessionGrants.delete(grant);
  return true;
}

function getOrCreateLead(email) {
  const normalized = normalizeEmail(email);
  let lead = leads.get(normalized);
  if (!lead) {
    const now = new Date().toISOString();
    lead = {
      sessionsUsed: 0,
      firstSeen: now,
      lastSeen: now,
      name: null,
      passwordSalt: null,
      passwordHash: null,
      accountCreatedAt: null,
    };
    leads.set(normalized, lead);
    return { email: normalized, lead };
  }
  syncLeadUsage(lead);
  return { email: normalized, lead };
}

function getLeadSnapshot(email, lead) {
  return {
    email,
    name: lead ? lead.name : null,
    hasAccount: Boolean(lead && lead.passwordHash),
    sessionsUsed: lead ? lead.sessionsUsed : 0,
    limit: MONTHLY_FREE_LIMIT,
    firstSeen: lead ? lead.firstSeen : null,
    lastSeen: lead ? lead.lastSeen : null,
    accountCreatedAt: lead ? lead.accountCreatedAt : null,
  };
}

// ── TURN credential minting ──────────────────────────────────────────────────

function httpsJson({ hostname, port, path, method, headers, body }) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname, port: port || 443, path, method, headers },
      r => {
        let data = '';
        r.on('data', c => (data += c));
        r.on('end', () => {
          if (r.statusCode < 200 || r.statusCode >= 300) {
            return reject(new Error(`HTTP ${r.statusCode}: ${data.slice(0, 200)}`));
          }
          try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
        });
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const STUN_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

// Tiny cache to avoid minting a fresh token on every page load.
let _iceCache = { servers: null, expiresAt: 0 };

async function getIceServers() {
  if (_iceCache.servers && Date.now() < _iceCache.expiresAt) {
    return _iceCache.servers;
  }

  const servers = [...STUN_SERVERS];
  const ttlMs = 60 * 60 * 1000; // cache for 1 hour; creds are longer-lived

  // 1. Cloudflare Realtime TURN
  if (process.env.CLOUDFLARE_TURN_KEY_ID && process.env.CLOUDFLARE_TURN_API_TOKEN) {
    const body = JSON.stringify({ ttl: 24 * 60 * 60 });
    const data = await httpsJson({
      hostname: 'rtc.live.cloudflare.com',
      path: `/v1/turn/keys/${process.env.CLOUDFLARE_TURN_KEY_ID}/credentials/generate`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.CLOUDFLARE_TURN_API_TOKEN}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      body,
    });
    // Cloudflare returns { iceServers: { urls: [...], username, credential } }
    if (data.iceServers) servers.push(data.iceServers);
  }
  // 2. Metered.ca
  else if (process.env.METERED_DOMAIN && process.env.METERED_API_KEY) {
    const data = await httpsJson({
      hostname: process.env.METERED_DOMAIN,
      path: `/api/v1/turn/credentials?apiKey=${encodeURIComponent(process.env.METERED_API_KEY)}`,
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    });
    // Metered returns an array of ICE server objects
    if (Array.isArray(data)) {
      for (const s of data) {
        // Skip their STUN entries — we already have Google's
        if (typeof s.urls === 'string' && s.urls.startsWith('stun:')) continue;
        servers.push(s);
      }
    }
  }
  // 3. Static creds (self-hosted coturn, Twilio static, etc.)
  else if (process.env.TURN_URL && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
    servers.push({
      urls: process.env.TURN_URL.split(',').map(u => u.trim()).filter(Boolean),
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL,
    });
  }

  _iceCache = { servers, expiresAt: Date.now() + ttlMs };
  return servers;
}

function turnProviderName() {
  if (process.env.CLOUDFLARE_TURN_KEY_ID && process.env.CLOUDFLARE_TURN_API_TOKEN) return 'Cloudflare Realtime';
  if (process.env.METERED_DOMAIN && process.env.METERED_API_KEY) return 'Metered.ca';
  if (process.env.TURN_URL && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) return 'static';
  return null;
}

// ── Vision AI contract ──────────────────────────────────────────────────────

const VISION_AI_MODES = {
  analyze: {
    label: 'Analyze frame',
    focus: 'Identify what is clearly visible, the current state of the device or screen, and any obvious support issue.',
  },
  readscreen: {
    label: 'Read screen text',
    focus: 'Extract visible error codes, UI text, warning dialogs, status messages, boot messages, and blank/off-screen states.',
  },
  hardware: {
    label: 'Inspect hardware',
    focus: 'Inspect physical hardware: LEDs, cables, ports, power state, drive bays, damage, dust, bent pins, and loose connections.',
  },
  suggest: {
    label: 'Suggest next step',
    focus: 'Recommend the most useful practical next action a support agent should take based on the image.',
  },
};

function clampConfidence(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}

function cleanVisionString(value, fallback = '') {
  return String(value || fallback).replace(/\s+/g, ' ').trim().slice(0, 500);
}

function cleanVisionList(value, fallback) {
  const source = Array.isArray(value) ? value : fallback;
  return source
    .map(item => cleanVisionString(item))
    .filter(Boolean)
    .slice(0, 6);
}

function normalizeVisionResult(value) {
  return {
    confidence: clampConfidence(value && value.confidence),
    observations: cleanVisionList(value && value.observations, ['No clear visual observations were returned.']),
    possibleIssue: cleanVisionString(value && value.possibleIssue, 'No clear issue identified from the image.'),
    recommendedNextSteps: cleanVisionList(
      value && value.recommendedNextSteps,
      ['Verify the visible details with the user.', 'Ask for a steadier or closer camera view.', 'Try the analysis again if needed.']
    ).slice(0, 3),
  };
}

function extractJsonObject(text) {
  const raw = String(text || '').trim();
  const withoutFence = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try {
    return JSON.parse(withoutFence);
  } catch (_) {
    const start = withoutFence.indexOf('{');
    const end = withoutFence.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) throw new Error('No JSON object returned');
    return JSON.parse(withoutFence.slice(start, end + 1));
  }
}

function buildVisionPrompt(mode, context = {}) {
  const modeInfo = VISION_AI_MODES[mode] || VISION_AI_MODES.analyze;
  const contextLines = [];
  const ticketText = cleanVisionString(context.ticketText, '');
  const deviceType = cleanVisionString(context.deviceType, '');
  const previousNotes = cleanVisionString(context.previousNotes, '');

  if (ticketText) contextLines.push(`Ticket: ${ticketText}`);
  if (deviceType) contextLines.push(`Device: ${deviceType}`);
  if (previousNotes) contextLines.push(`Previous notes: ${previousNotes}`);

  return `You are a technical support assistant analyzing an image.

Mode: ${modeInfo.label}
Focus: ${modeInfo.focus}

${contextLines.length ? `Context:\n${contextLines.join('\n')}\n` : ''}
Return JSON only in this exact format:
{
  "confidence": number from 0 to 1,
  "observations": ["what is clearly visible"],
  "possibleIssue": "short practical diagnosis",
  "recommendedNextSteps": ["max 3 actionable support steps"]
}

Rules:
- Be concise and practical for a support agent.
- Only mention observations that are visible or strongly supported by context.
- If uncertain, lower confidence and say what needs verification.
- recommendedNextSteps must contain at most 3 steps.`;
}

function getAnthropicText(data) {
  const block = data && Array.isArray(data.content)
    ? data.content.find(item => item && item.type === 'text')
    : null;
  return block && block.text ? String(block.text) : '';
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
      let parsed;
      try {
        parsed = JSON.parse(body || '{}');
      } catch {
        return writeJson(res, 400, { error: 'Invalid JSON' });
      }

      const { ttl, label } = parsed;
      const authToken = readAuthToken(req, parsed);
      const sessionGrant = String(parsed.sessionGrant || '').trim();
      const authLead = getLeadFromAuthToken(authToken);

      if (authToken) {
        if (!authLead) {
          return writeJson(res, 401, { error: 'Your sign-in expired. Please sign in again.', code: 'AUTH_REQUIRED' });
        }
        if (!consumeSessionGrant(authLead.email, sessionGrant)) {
          return writeJson(res, 403, { error: 'Session approval expired. Try again.', code: 'SESSION_GRANT_REQUIRED' });
        }
        if (authLead.lead.sessionsUsed >= MONTHLY_FREE_LIMIT) {
          return writeJson(res, 403, {
            error: 'Free session limit reached.',
            code: 'LIMIT_REACHED',
            ...getLeadSnapshot(authLead.email, authLead.lead),
          });
        }
        authLead.lead.sessionsUsed += 1;
        authLead.lead.lastSeen = new Date().toISOString();
      } else {
        const ip = getClientIp(req);
        const anonymousCount = anonymousSessionCounts.get(ip) || 0;
        if (anonymousCount >= 1) {
          return writeJson(res, 403, {
            error: 'Email required after your free session.',
            code: 'LEAD_REQUIRED',
            limit: MONTHLY_FREE_LIMIT,
          });
        }
        anonymousSessionCounts.set(ip, anonymousCount + 1);
      }

      const session = createSession(ttl ? Number(ttl) * 60 * 1000 : TOKEN_TTL_MS);
      session.label = label || 'Unnamed session';
      const proto = req.headers['x-forwarded-proto'] || 'http';
      const host = req.headers['x-forwarded-host'] || req.headers.host;
      const joinBase = `${proto}://${host}`;
      writeJson(res, 200, {
        token: session.token,
        url: `${joinBase}/join/${session.token}`,
        expiresAt: Date.now() + session.ttl,
        ...(authLead ? getLeadSnapshot(authLead.email, authLead.lead) : {}),
      });
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/lead') {
    let body = '';
    req.on('data', d => (body += d));
    req.on('end', () => {
      let parsed;
      try {
        parsed = JSON.parse(body || '{}');
      } catch {
        return writeJson(res, 400, { error: 'Invalid JSON' });
      }

      const email = normalizeEmail(parsed.email);
      if (!isValidEmail(email)) {
        return writeJson(res, 400, { error: 'A valid email is required.' });
      }

      const leadState = getOrCreateLead(email);
      writeJson(res, 200, getLeadSnapshot(leadState.email, leadState.lead));
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/signup') {
    let body = '';
    req.on('data', d => (body += d));
    req.on('end', () => {
      let parsed;
      try {
        parsed = JSON.parse(body || '{}');
      } catch {
        return writeJson(res, 400, { error: 'Invalid JSON' });
      }

      const email = normalizeEmail(parsed.email);
      const name = normalizeName(parsed.name);
      const password = parsed.password;

      if (!isValidEmail(email)) {
        return writeJson(res, 400, { error: 'A valid email is required.' });
      }
      if (!isValidName(name)) {
        return writeJson(res, 400, { error: 'Please enter your name.' });
      }
      if (!isValidPassword(password)) {
        return writeJson(res, 400, { error: `Password must be at least ${PASSWORD_MIN_LENGTH} characters.` });
      }

      const leadState = getOrCreateLead(email);
      if (leadState.lead.passwordHash) {
        return writeJson(res, 409, { error: 'An account already exists for this email.', code: 'ACCOUNT_EXISTS' });
      }

      const passwordData = hashPassword(password);
      leadState.lead.name = name;
      leadState.lead.passwordSalt = passwordData.salt;
      leadState.lead.passwordHash = passwordData.hash;
      leadState.lead.accountCreatedAt = new Date().toISOString();
      leadState.lead.lastSeen = new Date().toISOString();

      const authToken = issueAuthToken(leadState.email);
      writeJson(res, 200, {
        authToken,
        user: getLeadSnapshot(leadState.email, leadState.lead),
      });
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/signin') {
    let body = '';
    req.on('data', d => (body += d));
    req.on('end', () => {
      let parsed;
      try {
        parsed = JSON.parse(body || '{}');
      } catch {
        return writeJson(res, 400, { error: 'Invalid JSON' });
      }

      const email = normalizeEmail(parsed.email);
      const password = parsed.password;

      if (!isValidEmail(email)) {
        return writeJson(res, 400, { error: 'A valid email is required.' });
      }
      if (!isValidPassword(password)) {
        return writeJson(res, 400, { error: `Password must be at least ${PASSWORD_MIN_LENGTH} characters.` });
      }

      const lead = leads.get(email);
      if (!lead || !lead.passwordHash) {
        return writeJson(res, 404, { error: 'No account found for this email.', code: 'NO_ACCOUNT' });
      }
      syncLeadUsage(lead);
      if (!verifyPassword(password, lead.passwordSalt, lead.passwordHash)) {
        return writeJson(res, 401, { error: 'Incorrect password.', code: 'INVALID_PASSWORD' });
      }

      const authToken = issueAuthToken(email);
      writeJson(res, 200, {
        authToken,
        user: getLeadSnapshot(email, lead),
      });
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/auth/me') {
    const authToken = readAuthToken(req);
    const authLead = getLeadFromAuthToken(authToken);
    if (!authLead) {
      return writeJson(res, 401, { error: 'Authentication required.', code: 'AUTH_REQUIRED' });
    }

    writeJson(res, 200, {
      user: getLeadSnapshot(authLead.email, authLead.lead),
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/lead/session') {
    let body = '';
    req.on('data', d => (body += d));
    req.on('end', () => {
      let parsed;
      try {
        parsed = JSON.parse(body || '{}');
      } catch {
        return writeJson(res, 400, { error: 'Invalid JSON' });
      }

      const authToken = readAuthToken(req, parsed);
      const authLead = getLeadFromAuthToken(authToken);
      if (!authLead) {
        return writeJson(res, 401, { error: 'Your sign-in expired. Please sign in again.', code: 'AUTH_REQUIRED' });
      }

      if (authLead.lead.sessionsUsed >= MONTHLY_FREE_LIMIT) {
        return writeJson(res, 200, {
          allowed: false,
          ...getLeadSnapshot(authLead.email, authLead.lead),
        });
      }

      const sessionGrant = issueSessionGrant(authLead.email);

      writeJson(res, 200, {
        allowed: true,
        sessionGrant,
        ...getLeadSnapshot(authLead.email, authLead.lead),
      });
    });
    return;
  }

  // ADMIN: lead export endpoint. No auth yet.
  if (req.method === 'GET' && url.pathname === '/api/leads/export') {
    const exportedLeads = [];
    for (const [email, lead] of leads.entries()) {
      exportedLeads.push({
        email,
        name: lead.name,
        hasAccount: Boolean(lead.passwordHash),
        sessionsUsed: lead.sessionsUsed,
        firstSeen: lead.firstSeen,
        lastSeen: lead.lastSeen,
        accountCreatedAt: lead.accountCreatedAt,
      });
    }
    writeJson(res, 200, exportedLeads);
    return;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/lead/')) {
    const rawEmail = url.pathname.slice('/api/lead/'.length);
    const email = normalizeEmail(decodeURIComponent(rawEmail));
    if (!isValidEmail(email)) {
      return writeJson(res, 400, { error: 'A valid email is required.' });
    }

    const lead = leads.get(email);
    if (!lead) {
      return writeJson(res, 200, getLeadSnapshot(email, null));
    }

    syncLeadUsage(lead);
    writeJson(res, 200, getLeadSnapshot(email, lead));
    return;
  }

  // REST: ICE servers (STUN + TURN). Served to both tech and user clients
  // so they construct RTCPeerConnection with the same config.
  //
  // Three providers supported, checked in this order:
  //
  //   1. Cloudflare Realtime TURN (recommended — 1TB/month free)
  //      CLOUDFLARE_TURN_KEY_ID     — from Cloudflare Dashboard → Realtime → TURN
  //      CLOUDFLARE_TURN_API_TOKEN  — API token for that TURN app
  //
  //   2. Metered.ca (free tier after signup, ~500MB/month)
  //      METERED_DOMAIN   — your subdomain, e.g. "goshowme.metered.live"
  //      METERED_API_KEY  — from metered.ca dashboard
  //
  //   3. Static TURN creds (e.g. self-hosted coturn, or Twilio static creds)
  //      TURN_URL         — comma-separated turn: URLs
  //      TURN_USERNAME    — TURN username
  //      TURN_CREDENTIAL  — TURN password
  //
  // If none are set, STUN-only is returned with a loud warning — peers behind
  // symmetric NATs / carrier CGNAT will FAIL to connect. This is the bug you
  // just hit. Configure one of the options above.
  if (req.method === 'GET' && url.pathname === '/api/ice-servers') {
    getIceServers()
      .then(iceServers => {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify({ iceServers }));
      })
      .catch(err => {
        console.error('[ICE] provider error:', err.message);
        // Still return STUN so the client can at least try.
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify({
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
          ],
          warning: 'TURN provider failed: ' + err.message,
        }));
      });
    return;
  }

  // REST: session status
  if (req.method === 'GET' && url.pathname.startsWith('/api/session/')) {
    const token = url.pathname.split('/')[3];
    const s = sessions.get(token);
    if (!s) return writeJson(res, 200, { valid: false });
    writeJson(res, 200, {
      valid: true,
      label: s.label,
      techOnline: s.techAlive,
      expiresAt: s.createdAt + s.ttl,
    });
    return;
  }

  // REST: AI vision analysis — keeps API key and prompt contract server-side
  if (req.method === 'POST' && url.pathname === '/api/ai/analyze') {
    if (!ANTHROPIC_API_KEY) {
      return writeJson(res, 500, { error: 'ANTHROPIC_API_KEY not set on server.' });
    }

    let body = '';
    req.on('data', d => (body += d));
    req.on('end', async () => {
      let parsed;
      try { parsed = JSON.parse(body); } catch {
        return writeJson(res, 400, { error: 'Invalid JSON' });
      }

      const mode = String(parsed.mode || '').trim();
      const imageBase64 = String(parsed.imageBase64 || '').trim();
      const mediaType = String(parsed.mediaType || 'image/jpeg').trim();

      if (!VISION_AI_MODES[mode]) {
        return writeJson(res, 400, { error: 'Invalid Vision AI mode.' });
      }

      if (!imageBase64) {
        return writeJson(res, 400, { error: 'Image data is required.' });
      }

      if (!['image/jpeg', 'image/png', 'image/webp'].includes(mediaType)) {
        return writeJson(res, 400, { error: 'Unsupported image media type.' });
      }

      const payload = JSON.stringify({
        model: ANTHROPIC_VISION_MODEL,
        max_tokens: 900,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
            { type: 'text', text: buildVisionPrompt(mode, parsed.context || {}) },
          ],
        }],
      });

      try {
        const upstream = await httpsJson({
          hostname: 'api.anthropic.com',
          path: '/v1/messages',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
            'x-api-key': ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
          },
          body: payload,
        });

        const rawText = getAnthropicText(upstream);
        let result;
        try {
          result = normalizeVisionResult(extractJsonObject(rawText));
        } catch (parseErr) {
          console.warn('[VisionAI] non-JSON model response:', parseErr.message);
          result = normalizeVisionResult({
            confidence: 0.35,
            observations: [cleanVisionString(rawText, 'The model returned an unstructured response.')],
            possibleIssue: 'Vision AI returned an unstructured response.',
            recommendedNextSteps: ['Verify the image manually.', 'Try the analysis again.', 'Capture a clearer frame if needed.'],
          });
        }
        writeJson(res, 200, result);
      } catch (err) {
        console.error('[VisionAI] analysis failed:', err.message);
        writeJson(res, 502, { error: `Vision AI failed: ${err.message}` });
      }
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
        if (session.userWs) {
          safeSend(ws, { type: 'user_connected' });
          safeSend(session.userWs, { type: 'tech_connected' });
        }
      }

      if (role === 'user') {
        session.userWs = ws;
        safeSend(ws, { type: 'joined', role: 'user', label: session.label, expiresAt: session.createdAt + session.ttl, techOnline: !!session.techWs });
        if (session.techWs) {
          safeSend(ws, { type: 'tech_connected' });
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

    if (['offer', 'answer', 'candidate', 'annotate', 'recording_started', 'recording_stopped', 'orientation', 'torch', 'torch_capability', 'torch_state'].includes(msg.type)) {
      safeSend(peer, msg);
      return;
    }

    if (msg.type === 'chat') {
      // Server stamps sender role + timestamp so it can't be spoofed by a misbehaving client.
      const text = typeof msg.text === 'string' ? msg.text.slice(0, 2000) : '';
      if (!text.trim()) return;
      const out = { type: 'chat', text, from: ws._role || 'unknown', ts: Date.now() };
      safeSend(peer, out);
      // Echo back to sender so both sides render the same message ordering from the server clock.
      safeSend(ws, out);
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
  const provider = turnProviderName();
  if (provider) {
    console.log(`  TURN      : ${provider}`);
  } else {
    console.warn(`  TURN      : ⚠ NOT CONFIGURED — peer connections WILL FAIL behind strict NAT/CGNAT.`);
    console.warn(`              Set ONE of these env-var sets on Railway:`);
    console.warn(`                • CLOUDFLARE_TURN_KEY_ID + CLOUDFLARE_TURN_API_TOKEN  (recommended)`);
    console.warn(`                • METERED_DOMAIN + METERED_API_KEY`);
    console.warn(`                • TURN_URL + TURN_USERNAME + TURN_CREDENTIAL  (static)`);
  }
  console.log('');
});
