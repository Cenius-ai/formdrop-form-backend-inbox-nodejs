'use strict';

/* ---------------------------------------------------------------------------
 * Formdrop — a self-hostable form backend for static sites.
 *
 * Everything the server does lives in this one file: routing, storage,
 * authentication, HTML rendering, the public form intake, and the JSON API.
 * Persistence is a single JSON file written atomically (temp file + rename).
 * No runtime dependencies, no build step: `node main.js`.
 * ------------------------------------------------------------------------- */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/* ---------------------------------- config -------------------------------- */

loadDotEnvFile();

const ROOT_DIR = __dirname;
const STATIC_DIR = path.join(ROOT_DIR, 'static');
const DATA_DIR = path.resolve(ROOT_DIR, process.env.FORMDROP_DATA_DIR || 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const HOST = process.env.HOST || '0.0.0.0';
const PORT = parsePort(process.env.PORT);

// Public origin used for endpoint URLs shown in the UI and for the fallback base
// when a request arrives without a Host header. Set FORMDROP_PUBLIC_ORIGIN when the
// app is served behind a proxy or on a different host than it binds (split deploy);
// otherwise the request Host is used. The fallback stays a local dev origin.
const PUBLIC_ORIGIN = String(process.env.FORMDROP_PUBLIC_ORIGIN || '').trim().replace(/\/+$/, '');
const ORIGIN_SCHEME = String(process.env.FORMDROP_ORIGIN_SCHEME || 'http').trim() || 'http';
const ORIGIN_HOST = String(process.env.FORMDROP_HOST_FALLBACK || 'localhost').trim() || 'localhost';
const BASE_ORIGIN = `${ORIGIN_SCHEME}://${ORIGIN_HOST}`;

const MAX_BODY_BYTES = 64 * 1024;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const COOKIE_NAME = 'formdrop_session';
const FORM_FIELD_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
const MAX_FORM_NAME = 80;

const DEMO_PRIMARY = { email: 'cenius@cenius.ai', password: 'cenius' };
const DEMO_SECONDARY = { email: 'demo@formdrop.dev', password: 'demo1234' };

function parsePort(value) {
  if (value === undefined || value === null || String(value).trim() === '') return 3000;
  const port = Number.parseInt(String(value), 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) return 3000;
  return port;
}

function loadDotEnvFile() {
  const file = path.join(__dirname, '.env');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const line of raw.split('\n')) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (value.length > 1 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    if (process.env[match[1]] === undefined) process.env[match[1]] = value;
  }
}

/* ---------------------------------- utils --------------------------------- */

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

function escapeHtml(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(9).toString('base64url')}`;
}

function nowIso() {
  return new Date().toISOString();
}

function fieldToString(value) {
  if (Array.isArray(value)) return value.map((item) => String(item)).join('; ');
  if (value === null || value === undefined) return '';
  return String(value);
}

function truncate(text, max) {
  const value = String(text === null || text === undefined ? '' : text);
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function plural(count, singular, pluralForm) {
  return `${count} ${count === 1 ? singular : pluralForm || `${singular}s`}`;
}

function formatDate(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'Unknown date';
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatDateTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'Unknown date';
  return date.toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function humanizeWhen(iso) {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return 'Unknown time';
  const minutes = Math.round((Date.now() - then) / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  return formatDate(iso);
}

function slugify(value) {
  const slug = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || 'form';
}

function safeNextPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) {
    return '/app';
  }
  return value;
}

/* --------------------------------- storage -------------------------------- */

let db;

function emptyDatabase() {
  return {
    version: 1,
    meta: { seededWorkspaces: {} },
    users: [],
    sessions: [],
    forms: [],
    submissions: [],
  };
}

function loadDatabase() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch (error) {
      console.error(`[formdrop] ${DB_FILE} could not be parsed as JSON: ${error.message}`);
      console.error('[formdrop] refusing to start so stored submissions are not overwritten.');
      process.exit(1);
    }
    db = parsed && typeof parsed === 'object' ? parsed : emptyDatabase();
    for (const key of ['users', 'sessions', 'forms', 'submissions']) {
      if (!Array.isArray(db[key])) db[key] = [];
    }
    if (!db.meta || typeof db.meta !== 'object' || Array.isArray(db.meta)) db.meta = { seededWorkspaces: {} };
    if (!db.meta.seededWorkspaces || typeof db.meta.seededWorkspaces !== 'object') db.meta.seededWorkspaces = {};
  } else {
    db = emptyDatabase();
    persist();
    console.log(`[formdrop] created ${path.relative(ROOT_DIR, DB_FILE)}`);
  }
  if (pruneExpiredSessions()) persist();
}

function persist() {
  const temporary = `${DB_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(db, null, 2)}\n`);
  fs.renameSync(temporary, DB_FILE);
}

/* ------------------------------- repositories ----------------------------- */

function findUserByEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return null;
  return db.users.find((user) => user.email === normalized) || null;
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    isDemo: Boolean(user.isDemo),
    createdAt: user.createdAt,
  };
}

function ownedForm(user, formId) {
  if (!user) return null;
  return db.forms.find((form) => form.id === formId && form.userId === user.id) || null;
}

function ownedSubmission(user, submissionId) {
  const submission = db.submissions.find((item) => item.id === submissionId);
  if (!submission) return null;
  const form = ownedForm(user, submission.formId);
  if (!form) return null;
  return { submission, form };
}

function submissionsForForm(formId) {
  return db.submissions
    .filter((submission) => submission.formId === formId)
    .sort((a, b) => String(b.submittedAt).localeCompare(String(a.submittedAt)));
}

function countSubmissions(formId) {
  const counts = { all: 0, inbox: 0, spam: 0 };
  for (const submission of db.submissions) {
    if (submission.formId !== formId) continue;
    counts.all += 1;
    if (submission.isSpam) counts.spam += 1;
    else counts.inbox += 1;
  }
  return counts;
}

function createForm(user, name) {
  let id;
  do {
    id = crypto.randomBytes(8).toString('base64url');
  } while (db.forms.some((form) => form.id === id));
  const timestamp = nowIso();
  const form = {
    id,
    userId: user.id,
    name,
    allowedOrigins: [],
    honeypotEnabled: false,
    honeypotField: 'website',
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  db.forms.push(form);
  persist();
  return form;
}

function deleteFormCascade(form) {
  db.forms = db.forms.filter((item) => item.id !== form.id);
  db.submissions = db.submissions.filter((item) => item.formId !== form.id);
  persist();
}

/* --------------------------------- passwords ------------------------------ */

const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const SCRYPT_KEYLEN = 64;

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const passwordHash = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN, SCRYPT_OPTIONS).toString('hex');
  return { passwordHash, passwordSalt: salt };
}

function passwordMatches(password, user) {
  if (!user || !user.passwordHash || !user.passwordSalt) return false;
  const expected = Buffer.from(user.passwordHash, 'hex');
  const actual = crypto.scryptSync(String(password), user.passwordSalt, SCRYPT_KEYLEN, SCRYPT_OPTIONS);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

/* --------------------------------- sessions ------------------------------- */

function createUser(email, password, isDemo = false) {
  const { passwordHash, passwordSalt } = hashPassword(password);
  const user = {
    id: newId('usr'),
    email: String(email).trim().toLowerCase(),
    passwordHash,
    passwordSalt,
    isDemo,
    createdAt: nowIso(),
  };
  db.users.push(user);
  persist();
  return user;
}

function createSession(user) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.sessions.push({
    id: newId('ses'),
    tokenHash: hashToken(token),
    userId: user.id,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
    createdAt: nowIso(),
  });
  persist();
  return token;
}

function sessionFromRequest(req) {
  const token = readCookie(req, COOKIE_NAME);
  if (!token) return null;
  const tokenHash = hashToken(token);
  const session = db.sessions.find((item) => item.tokenHash === tokenHash);
  if (!session) return null;
  if (Date.parse(session.expiresAt) <= Date.now()) {
    db.sessions = db.sessions.filter((item) => item.id !== session.id);
    persist();
    return null;
  }
  return session;
}

function currentUser(req) {
  const session = sessionFromRequest(req);
  if (!session) return null;
  return db.users.find((user) => user.id === session.userId) || null;
}

function destroySession(req) {
  const token = readCookie(req, COOKIE_NAME);
  if (!token) return;
  const tokenHash = hashToken(token);
  const before = db.sessions.length;
  db.sessions = db.sessions.filter((item) => item.tokenHash !== tokenHash);
  if (db.sessions.length !== before) persist();
}

function pruneExpiredSessions() {
  const before = db.sessions.length;
  const now = Date.now();
  db.sessions = db.sessions.filter((session) => Date.parse(session.expiresAt) > now);
  return db.sessions.length !== before;
}

/* ---------------------------------- cookies ------------------------------- */

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return '';
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) {
      try {
        return decodeURIComponent(part.slice(index + 1).trim());
      } catch {
        return '';
      }
    }
  }
  return '';
}

function isHttps(req) {
  if (req.socket && req.socket.encrypted) return true;
  const forwarded = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  return forwarded === 'https';
}

function sessionCookie(req, token) {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (isHttps(req)) parts.push('Secure');
  return parts.join('; ');
}

function clearedSessionCookie(req) {
  const parts = [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (isHttps(req)) parts.push('Secure');
  return parts.join('; ');
}

/* -------------------------------- rate limit ------------------------------ */

const loginHits = new Map();

function rateLimited(key, limit, windowMs) {
  const now = Date.now();
  const recent = (loginHits.get(key) || []).filter((stamp) => now - stamp < windowMs);
  recent.push(now);
  loginHits.set(key, recent);
  if (loginHits.size > 5000) loginHits.clear();
  return recent.length > limit;
}

function requestIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || (req.socket && req.socket.remoteAddress) || 'unknown';
}

/* ------------------------------ http responses ---------------------------- */

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Content-Security-Policy': [
    "default-src 'self'",
    "img-src 'self' data:",
    "style-src 'self'",
    "script-src 'self'",
    "font-src 'self'",
    "connect-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join('; '),
};

function send(res, status, body, headers = {}) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body === undefined || body === null ? '' : String(body), 'utf8');
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Length': payload.length,
    ...headers,
  });
  const isHead = res.req && res.req.method === 'HEAD';
  res.end(isHead ? undefined : payload);
}

function sendHtml(res, status, html, headers = {}) {
  send(res, status, html, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
}

function sendJson(res, status, data, headers = {}) {
  send(res, status, JSON.stringify(data), {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
}

function redirect(res, location, status = 303) {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    Location: location,
    'Cache-Control': 'no-store',
    'Content-Length': 0,
  });
  res.end();
}

function originOf(req) {
  if (PUBLIC_ORIGIN) return PUBLIC_ORIGIN;
  const protocol = isHttps(req) ? 'https' : ORIGIN_SCHEME;
  const host = req.headers.host || `${ORIGIN_HOST}:${PORT}`;
  return `${protocol}://${host}`;
}

/* --------------------------- request body handling ------------------------ */

async function readBody(req, limit = MAX_BODY_BYTES) {
  const declared = Number.parseInt(req.headers['content-length'] || '', 10);
  if (Number.isFinite(declared) && declared > limit) {
    throw new HttpError(413, `Request body is too large — the limit is ${Math.round(limit / 1024)} KB.`);
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total <= limit) chunks.push(chunk);
  }
  if (total > limit) {
    throw new HttpError(413, `Request body is too large — the limit is ${Math.round(limit / 1024)} KB.`);
  }
  return Buffer.concat(chunks, Math.min(total, limit));
}

async function readJsonBody(req) {
  const raw = await readBody(req);
  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  if (!raw.length) return {};
  if (contentType.includes('application/json')) {
    let parsed;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new HttpError(400, 'Request body must be valid JSON.');
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new HttpError(400, 'Request body must be a JSON object.');
    }
    return parsed;
  }
  if (contentType.includes('application/x-www-form-urlencoded')) {
    return parseUrlEncoded(raw);
  }
  throw new HttpError(415, 'Send application/json or application/x-www-form-urlencoded.');
}

function parseUrlEncoded(raw) {
  const fields = Object.create(null);
  for (const [name, value] of new URLSearchParams(raw.toString('utf8'))) {
    addField(fields, name, value);
  }
  return fields;
}

function addField(fields, rawName, rawValue) {
  const name = String(rawName || '').trim().slice(0, 100);
  if (!name) return;
  if (name === '__proto__' || name === 'constructor' || name === 'prototype') return;
  if (Object.keys(fields).length >= 100 && !Object.prototype.hasOwnProperty.call(fields, name)) return;
  const value = String(rawValue === null || rawValue === undefined ? '' : rawValue).slice(0, 5000);
  if (Object.prototype.hasOwnProperty.call(fields, name)) {
    const existing = fields[name];
    fields[name] = Array.isArray(existing) ? existing.concat(value) : [existing, value];
  } else {
    fields[name] = value;
  }
}

function parseSubmittedFields(contentType, raw) {
  const type = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (type === 'application/x-www-form-urlencoded') return parseUrlEncoded(raw);
  if (type === 'multipart/form-data') return parseMultipart(contentType, raw);
  throw new HttpError(415, 'Send the form as application/x-www-form-urlencoded or multipart/form-data.');
}

function parseMultipart(contentType, raw) {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!boundaryMatch) throw new HttpError(400, 'Malformed multipart body: the boundary is missing.');
  const boundary = `--${(boundaryMatch[1] || boundaryMatch[2]).trim()}`;
  const body = raw.toString('latin1');
  const fields = Object.create(null);
  const parts = body.split(boundary).slice(1);
  for (const part of parts) {
    const trimmed = part.replace(/^\r\n/, '');
    const headerEnd = trimmed.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;
    const headers = trimmed.slice(0, headerEnd);
    let value = trimmed.slice(headerEnd + 4);
    if (value.endsWith('\r\n')) value = value.slice(0, -2);
    if (/filename="[^"]*"/i.test(headers)) {
      throw new HttpError(415, 'File uploads are not supported by this endpoint.');
    }
    const nameMatch = /name="([^"]*)"/i.exec(headers);
    if (!nameMatch) continue;
    addField(fields, nameMatch[1], Buffer.from(value, 'latin1').toString('utf8'));
  }
  return fields;
}

function wantsJson(req) {
  const accept = String(req.headers.accept || '');
  return accept.includes('application/json') && !accept.includes('text/html');
}

function sameOrigin(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return true;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === (req.headers.host || '');
  } catch {
    return false;
  }
}

/* ------------------------------ form settings ----------------------------- */

function normalizedOrigin(parsedUrl) {
  return `${parsedUrl.protocol}//${parsedUrl.host}`;
}

function parseOriginsInput(text) {
  const lines = String(text || '')
    .split(/[\n,]+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const origins = [];
  for (const line of lines) {
    let parsed;
    try {
      parsed = new URL(line);
    } catch {
      return { error: `“${truncate(line, 60)}” is not a full URL. Use the form https://example.com.` };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { error: `“${truncate(line, 60)}” must start with http:// or https://.` };
    }
    const origin = normalizedOrigin(parsed);
    if (!origins.includes(origin)) origins.push(origin);
  }
  return { origins };
}

function validateFormSettings(input) {
  const errors = {};
  const name = String(input.name === undefined ? '' : input.name).trim();
  if (!name) errors.name = 'Give the form a name so you can recognise it later.';
  else if (name.length > MAX_FORM_NAME) errors.name = `Keep the name under ${MAX_FORM_NAME} characters.`;

  let allowedOrigins;
  if (input.allowedOrigins !== undefined) {
    const result = parseOriginsInput(input.allowedOrigins);
    if (result.error) errors.allowedOrigins = result.error;
    else allowedOrigins = result.origins;
  }

  const honeypotEnabled = input.honeypotEnabled === undefined ? undefined : Boolean(input.honeypotEnabled);
  let honeypotField;
  if (input.honeypotField !== undefined) {
    const value = String(input.honeypotField).trim();
    if (value && !FORM_FIELD_NAME.test(value)) {
      errors.honeypotField = 'Use letters, numbers, dashes or underscores, starting with a letter.';
    } else {
      honeypotField = value || 'website';
    }
  }

  return { errors, name, allowedOrigins, honeypotEnabled, honeypotField };
}

/* ---------------------------------- CSV ----------------------------------- */

function csvCell(value) {
  let text = value === null || value === undefined ? '' : String(value);
  // Neutralise spreadsheet formula injection before quoting.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

function submissionsToCsv(submissions) {
  const fieldNames = [];
  for (const submission of submissions) {
    for (const name of Object.keys(submission.fields || {})) {
      if (!fieldNames.includes(name)) fieldNames.push(name);
    }
  }
  const header = ['id', 'submitted_at', 'spam', ...fieldNames];
  const lines = [header.map(csvCell).join(',')];
  for (const submission of submissions) {
    const row = [
      submission.id,
      submission.submittedAt,
      submission.isSpam ? 'spam' : 'inbox',
      ...fieldNames.map((name) => fieldToString((submission.fields || {})[name])),
    ];
    lines.push(row.map(csvCell).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}
/* ---------------------------------- seed ---------------------------------- */

function seedDemoWorkspace() {
  const demoUsers = [
    ensureDemoUser(DEMO_PRIMARY.email, DEMO_PRIMARY.password, true),
    ensureDemoUser(DEMO_SECONDARY.email, DEMO_SECONDARY.password, true),
  ];
  for (const user of demoUsers) seedWorkspaceFor(user);
  persist();
}

function ensureDemoUser(email, password, isDemo) {
  const existing = findUserByEmail(email);
  if (!existing) return createUser(email, password, isDemo);
  // Repair the credential if the stored hash ever drifts, so the demo login
  // printed on the login card always works.
  if (!passwordMatches(password, existing)) {
    const { passwordHash, passwordSalt } = hashPassword(password);
    existing.passwordHash = passwordHash;
    existing.passwordSalt = passwordSalt;
    persist();
  }
  return existing;
}

function seedWorkspaceFor(user) {
  if (db.meta.seededWorkspaces[user.id]) return;
  db.meta.seededWorkspaces[user.id] = nowIso();
  const presets = user.email === DEMO_PRIMARY.email ? PRIMARY_WORKSPACE : SECONDARY_WORKSPACE;
  for (const preset of presets) {
    const timestamp = new Date(Date.now() - preset.ageDays * 86400000).toISOString();
    const form = {
      id: crypto.randomBytes(8).toString('base64url'),
      userId: user.id,
      name: preset.name,
      allowedOrigins: preset.allowedOrigins.slice(),
      honeypotEnabled: preset.honeypotEnabled,
      honeypotField: preset.honeypotField,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    db.forms.push(form);
    for (const sample of preset.submissions) {
      db.submissions.push({
        id: newId('sub'),
        formId: form.id,
        fields: { ...sample.fields },
        isSpam: Boolean(sample.isSpam),
        spamReason: sample.spamReason || '',
        origin: sample.origin || '',
        userAgent: sample.userAgent || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        submittedAt: new Date(Date.now() - sample.minutesAgo * 60000).toISOString(),
      });
    }
  }
}

const PRIMARY_WORKSPACE = [
  {
    name: 'Product waitlist',
    ageDays: 34,
    allowedOrigins: [],
    honeypotEnabled: true,
    honeypotField: 'company',
    submissions: [
      {
        minutesAgo: 38,
        fields: {
          name: 'Ada Okafor',
          email: 'ada@northlight.studio',
          message: 'Hi — we ship our marketing site on Astro and want to leave a hosted form service. Can one Formdrop install serve several client sites?',
        },
      },
      {
        minutesAgo: 214,
        fields: {
          name: 'Ravi Menon',
          email: 'ravi@paperkite.dev',
          message: 'Joined the waitlist. Anything I should know before pointing our contact page at the endpoint?',
        },
      },
      {
        minutesAgo: 1520,
        origin: 'https://fischer.design',
        fields: {
          name: 'Elena Fischer',
          email: 'elena@fischer.design',
          message: 'Please add me. I run three small client sites and would self-host this on a small VPS.',
        },
      },
      {
        minutesAgo: 1890,
        fields: {
          name: 'Tomas Vega',
          email: 'tomas@vega.works',
          message: 'Does the endpoint accept a plain multipart post from HTML? None of my sites have a build step.',
        },
      },
      {
        minutesAgo: 2880,
        fields: {
          name: 'Priya Raman',
          email: 'priya@studio-raman.com',
          message: 'Interested. We need CSV export for a client enquiry form — is that per form?',
        },
      },
      {
        minutesAgo: 3000,
        isSpam: true,
        spamReason: 'Honeypot field “company” was filled in',
        fields: {
          name: 'SEO Growth Team',
          email: 'growth@rankfast.example',
          message: 'Buy 10,000 do-follow backlinks, first page in 14 days. https://rankfast.example',
          company: 'https://rankfast.example',
        },
      },
      {
        minutesAgo: 3200,
        isSpam: true,
        spamReason: 'Flagged manually as spam',
        fields: {
          name: 'CoinBlast Promo',
          email: 'promo@coinblast.example',
          message: 'Earn 12% daily with our automated vault. Reply to claim your allocation.',
        },
      },
      {
        minutesAgo: 4320,
        fields: {
          name: 'Jonas Weber',
          email: 'jonas@weber.gmbh',
          message: 'Quick question: can I restrict an endpoint to my own domain only? I would rather it not be reposted elsewhere.',
        },
      },
      {
        minutesAgo: 5760,
        fields: {
          name: 'Mira Sato',
          email: 'mira@satoworks.jp',
          message: 'Waitlist please. Seeing spam separately would be great — manual flagging is fine for now.',
          company: '',
        },
      },
    ],
  },
  {
    name: 'Support contact',
    ageDays: 21,
    allowedOrigins: ['https://acme-studio.com'],
    honeypotEnabled: true,
    honeypotField: 'website',
    submissions: [
      {
        minutesAgo: 95,
        origin: 'https://acme-studio.com',
        fields: {
          name: 'Carla Nunes',
          email: 'carla@acme-studio.com',
          subject: 'Invoice for August',
          message: 'Hi — the August invoice is missing our PO number. Could you reissue it?',
        },
      },
      {
        minutesAgo: 420,
        origin: 'https://acme-studio.com',
        fields: {
          name: 'Ben Carter',
          email: 'ben@acme-studio.com',
          subject: 'Staging deploy',
          message: 'Staging still shows the old hero image. Cache issue or did the build fail?',
        },
      },
      {
        minutesAgo: 2760,
        origin: 'https://acme-studio.com',
        fields: {
          name: 'Dana Whitfield',
          email: 'dana@acme-studio.com',
          subject: 'New starter',
          message: 'Adding Lila to the design channel on Monday. Anything needed from your side?',
        },
      },
      {
        minutesAgo: 4300,
        origin: 'https://acme-studio.com',
        fields: {
          name: 'Carla Nunes',
          email: 'carla@acme-studio.com',
          subject: 'Re: invoice',
          message: 'Thanks — got the reissue, all reconciled now.\nAppreciate the quick turnaround.',
        },
      },
      {
        minutesAgo: 5100,
        isSpam: true,
        spamReason: 'Flagged manually as spam',
        origin: 'https://acme-studio.com',
        fields: {
          name: 'Guest Post Desk',
          email: 'editor@contentfarm.example',
          subject: 'Collaboration',
          message: 'We can publish 3 guest posts with do-follow links for ninety-nine dollars. Interested?',
        },
      },
      {
        minutesAgo: 7200,
        origin: 'https://acme-studio.com',
        fields: {
          name: 'Owen Blake',
          email: 'owen@acme-studio.com',
          subject: 'Form handling',
          message: 'Which endpoint should the careers page post to? It is not on the allowlist yet.',
        },
      },
    ],
  },
];

const SECONDARY_WORKSPACE = [
  {
    name: 'Contact form',
    ageDays: 18,
    allowedOrigins: [],
    honeypotEnabled: true,
    honeypotField: 'website',
    submissions: [
      {
        minutesAgo: 55,
        fields: { name: 'Marta Silva', email: 'marta@silva.co', message: 'Do you take on small brochure sites? Two pages, one contact form.' },
      },
      {
        minutesAgo: 700,
        fields: { name: 'Ines Duarte', email: 'ines@duarte.studio', message: 'Loved the case study on the bakery rebuild. Who did the photography?' },
      },
      {
        minutesAgo: 1600,
        fields: { name: 'Hugo Almeida', email: 'hugo@almeida.dev', message: 'Can you invoice in euros with 30 day terms?' },
      },
      {
        minutesAgo: 2600,
        fields: { name: 'Sofia Marques', email: 'sofia@marques.pt', message: 'Following up on my last note about the shop migration — no rush.' },
      },
      {
        minutesAgo: 3500,
        isSpam: true,
        spamReason: 'Honeypot field “website” was filled in',
        fields: {
          name: 'Web Traffic Pro',
          email: 'sales@trafficpro.example',
          message: 'Get 50,000 visitors this month — guaranteed.',
          website: 'https://trafficpro.example/offer',
        },
      },
      {
        minutesAgo: 4400,
        fields: { name: 'Tiago Ferreira', email: 'tiago@ferreira.pt', message: 'Any availability in September for a small brand refresh?' },
      },
      {
        minutesAgo: 5900,
        fields: { name: 'Lena Hoffmann', email: 'lena@hoffmann.de', message: 'Sending the brief next week — is email still the best way to share it?' },
      },
    ],
  },
  {
    name: 'Newsletter signup',
    ageDays: 12,
    allowedOrigins: [],
    honeypotEnabled: false,
    honeypotField: 'website',
    submissions: [
      { minutesAgo: 130, fields: { email: 'nadia@fieldnotes.example', source: 'footer' } },
      { minutesAgo: 980, fields: { email: 'petra@slowweb.example', source: 'article' } },
      { minutesAgo: 2200, fields: { email: 'jules@typeandgrid.example', source: 'footer' } },
      { minutesAgo: 3900, fields: { email: 'amir@postcards.example', source: 'article' } },
      { minutesAgo: 6100, fields: { email: 'olga@printshop.example', source: 'footer' } },
    ],
  },
];
/* ---------------------------------- icons --------------------------------- */

const ICONS = {
  logo: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="3.5" y="4.5" width="17" height="15" rx="3" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M7.5 9.5h9M7.5 13h6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  chevron: '<svg class="icon" viewBox="0 0 20 20" aria-hidden="true" focusable="false"><path d="M8 5l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  check: '<svg class="icon" viewBox="0 0 20 20" aria-hidden="true" focusable="false"><path d="M4 10.5l4 4 8-9" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  shield: '<svg class="icon" viewBox="0 0 20 20" aria-hidden="true" focusable="false"><path d="M10 3l6 2.5v5c0 3.2-2.4 5.6-6 6.5-3.6-.9-6-3.3-6-6.5v-5L10 3z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>',
  inbox: '<svg class="icon" viewBox="0 0 20 20" aria-hidden="true" focusable="false"><path d="M3 11.5l2.2-6h9.6l2.2 6v3.5a1 1 0 01-1 1H4a1 1 0 01-1-1v-3.5z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M3 11.5h4l1 2h4l1-2h4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>',
  alert: '<svg class="icon" viewBox="0 0 20 20" aria-hidden="true" focusable="false"><path d="M10 3.5l7 12.5H3l7-12.5z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M10 8.5v3.2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="10" cy="14" r="0.9" fill="currentColor"/></svg>',
  table: '<svg class="icon" viewBox="0 0 20 20" aria-hidden="true" focusable="false"><rect x="3.5" y="4.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M3.5 8.5h13M8.5 8.5v7" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  link: '<svg class="icon" viewBox="0 0 20 20" aria-hidden="true" focusable="false"><path d="M8.5 11.5l3-3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M7 13l-1.2 1.2a2.7 2.7 0 01-3.8-3.8L4.2 8.2a2.7 2.7 0 013.8 0" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M13 7l1.2-1.2a2.7 2.7 0 013.8 3.8L15.8 11.8a2.7 2.7 0 01-3.8 0" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  plus: '<svg class="icon" viewBox="0 0 20 20" aria-hidden="true" focusable="false"><path d="M10 4.5v11M4.5 10h11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
};

/* ---------------------------------- layout -------------------------------- */

function pageShell({ title, description = '', user = null, breadcrumb = [], content, bodyClass = '' }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description || 'Formdrop is a self-hostable form backend for static sites: endpoints, an inbox, spam flags and CSV export.')}">
<link rel="icon" href="/static/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/static/fonts.css">
<link rel="stylesheet" href="/static/app.css">
<script src="/static/app.js" defer></script>
</head>
<body class="${escapeHtml(bodyClass)}">
<a class="skip-link" href="#main">Skip to content</a>
${renderTopbar({ user, breadcrumb })}
<main id="main" class="shell">
${content}
</main>
<footer class="site-footer">
  <p>Formdrop — form endpoints for static sites. Everything is stored in one local JSON file; nothing leaves this server.</p>
</footer>
${user ? renderCommandPalette() : ''}
</body>
</html>`;
}

function renderTopbar({ user, breadcrumb }) {
  const crumbs = breadcrumb && breadcrumb.length ? renderBreadcrumb(breadcrumb) : '<span class="topbar-spacer"></span>';
  const actions = user
    ? `<button type="button" class="kbd-btn" data-palette-open aria-label="Open the command palette">Jump to <kbd>⌘K</kbd></button>
      <span class="whoami" title="Signed in as">${escapeHtml(user.email)}</span>
      <form class="inline-form" method="post" action="/logout"><button class="btn btn-ghost btn-sm" type="submit">Sign out</button></form>`
    : '<a class="btn btn-primary btn-sm" href="/login">Sign in</a>';
  return `<header class="topbar">
  <div class="topbar-inner">
    <a class="brand" href="${user ? '/app' : '/login'}">
      ${ICONS.logo}
      <span>Formdrop</span>
    </a>
    ${crumbs}
    <div class="topbar-actions">
      ${actions}
    </div>
  </div>
</header>`;
}

function renderBreadcrumb(items) {
  const entries = items
    .map((item, index) => {
      const isLast = index === items.length - 1;
      if (item.href && !isLast) {
        return `<li><a href="${escapeHtml(item.href)}">${escapeHtml(item.label)}</a></li>`;
      }
      return `<li><span aria-current="page">${escapeHtml(item.label)}</span></li>`;
    })
    .join('');
  return `<nav class="crumbs" aria-label="Breadcrumb"><ol>${entries}</ol></nav>`;
}

function renderCommandPalette() {
  return `<dialog class="palette" id="command-palette" aria-labelledby="palette-title">
  <h2 class="sr-only" id="palette-title">Command palette</h2>
  <input class="palette-input" id="palette-input" type="search" placeholder="Jump to a form, page or action…" aria-label="Search forms and pages" autocomplete="off" aria-controls="palette-list" aria-describedby="palette-hint">
  <p class="sr-only" id="palette-hint">Type to filter, use the arrow keys to move, Enter to open and Escape to close.</p>
  <ul class="palette-list" id="palette-list" role="listbox" aria-label="Matches"></ul>
  <p class="palette-hint" aria-hidden="true">↑ ↓ to move · Enter to open · Esc to close</p>
</dialog>`;
}

function renderFeatureList(items) {
  return `<ul class="feature-list">${items
    .map((item) => `<li><span class="ico">${item.icon}</span><span>${item.text}</span></li>`)
    .join('')}</ul>`;
}

/* --------------------------------- auth view ------------------------------ */

function loginPage({ mode = 'login', values = {}, errors = {}, formError = '' }) {
  const isSignup = mode === 'signup';
  const emailError = errors.email ? `<p class="field-error" id="email-error">${escapeHtml(errors.email)}</p>` : '';
  const passwordError = errors.password
    ? `<p class="field-error" id="password-error">${escapeHtml(errors.password)}</p>`
    : '';
  const banner = formError ? `<p class="banner banner-error" role="alert">${escapeHtml(formError)}</p>` : '';

  const content = `<div class="auth-layout">
  <section class="auth-card reveal" aria-labelledby="auth-title">
    <p class="eyebrow">Formdrop</p>
    <h1 id="auth-title">${isSignup ? 'Create your workspace' : 'Sign in to your inbox'}</h1>
    <p class="lede">${isSignup ? 'One account holds every form endpoint and every submission.' : 'Submissions from your static sites land here.'}</p>

    <div class="tabs">
      <a class="tab${isSignup ? '' : ' is-active'}" href="/login"${isSignup ? '' : ' aria-current="page"'}>Sign in</a>
      <a class="tab${isSignup ? ' is-active' : ''}" href="/login?mode=signup"${isSignup ? ' aria-current="page"' : ''}>Create account</a>
    </div>

    ${banner}
    <form class="auth-form" method="post" action="/login" data-busy-on-submit>
      <input type="hidden" name="mode" value="${isSignup ? 'signup' : 'login'}">
      <div class="field">
        <label for="email">Email</label>
        <input class="input" id="email" name="email" type="email" inputmode="email" autocomplete="username" required value="${escapeHtml(values.email || '')}"${errors.email ? ' aria-invalid="true" aria-describedby="email-error"' : ''}>
        ${emailError}
      </div>
      <div class="field">
        <label for="password">Password</label>
        <div class="password-wrap">
          <input class="input" id="password" name="password" type="password" autocomplete="${isSignup ? 'new-password' : 'current-password'}" required${isSignup ? ' minlength="8"' : ''}${errors.password ? ' aria-invalid="true" aria-describedby="password-error"' : ''}>
          <button class="pw-toggle" type="button" data-password-toggle aria-pressed="false" aria-controls="password">Show</button>
        </div>
        ${passwordError}
        <p class="hint">${isSignup ? 'At least 8 characters.' : 'Passwords are stored as salted scrypt hashes.'}</p>
      </div>
      <button class="btn btn-primary btn-block" type="submit" data-busy-label="${isSignup ? 'Creating account…' : 'Signing in…'}">${isSignup ? 'Create account' : 'Sign in'}</button>
    </form>

    <aside class="demo-card" aria-labelledby="demo-title">
      <p class="demo-kicker" id="demo-title">Demo workspace</p>
      <p class="demo-copy">Demo: ${escapeHtml(DEMO_PRIMARY.email)} / ${escapeHtml(DEMO_PRIMARY.password)}</p>
      <dl class="demo-creds">
        <div><dt>Email</dt><dd>${escapeHtml(DEMO_PRIMARY.email)}</dd></div>
        <div><dt>Password</dt><dd>${escapeHtml(DEMO_PRIMARY.password)}</dd></div>
      </dl>
      <button class="btn btn-sm" type="button" data-fill-demo data-demo-email="${escapeHtml(DEMO_PRIMARY.email)}" data-demo-password="${escapeHtml(DEMO_PRIMARY.password)}">Use demo credentials</button>
      <p class="demo-note">Second seeded account: ${escapeHtml(DEMO_SECONDARY.email)} / ${escapeHtml(DEMO_SECONDARY.password)}</p>
    </aside>
  </section>

  <aside class="auth-aside reveal" aria-labelledby="auth-aside-title">
    <h2 id="auth-aside-title">One endpoint per page, one inbox for all of them.</h2>
    <p class="lede">Drop a <code class="mono">/f/&lt;id&gt;</code> action into any HTML form. Formdrop stores the submission, flags the obvious spam, and exports the rest as CSV.</p>
    ${renderFeatureList([
      { icon: ICONS.link, text: 'Per-form endpoints that accept urlencoded and multipart posts from plain HTML.' },
      { icon: ICONS.shield, text: 'Allowed-origin checks and a honeypot field per form — no CAPTCHA, no third party.' },
      { icon: ICONS.inbox, text: 'An inbox with All / Inbox / Spam filters and expandable rows for arbitrary fields.' },
      { icon: ICONS.table, text: 'CSV export that follows the filter you are looking at.' },
    ])}
  </aside>
</div>`;

  return pageShell({
    title: `${isSignup ? 'Create your account' : 'Sign in'} · Formdrop`,
    description: 'Sign in to Formdrop, the self-hostable form backend for static sites.',
    content,
    bodyClass: 'auth-body',
  });
}

/* ------------------------------- dashboard view --------------------------- */

function dashboardPage({ user, forms, stats, values = {}, error = '', flash = '', requestOrigin }) {
  const list = forms.length
    ? `<ul class="endpoint-list">${forms.map((form) => renderFormRow(form, requestOrigin)).join('')}</ul>`
    : `<div class="empty">
        <h3>No endpoints yet</h3>
        <p>Name your first form above — for example <em>Product waitlist</em> — and Formdrop gives you a URL you can paste into any static page.</p>
      </div>`;

  const content = `<div class="page-head reveal">
  <div>
    <p class="eyebrow">Workspace</p>
    <h1>Your form endpoints</h1>
    <p class="lede">Signed in as ${escapeHtml(user.email)}. Each endpoint accepts posts from plain HTML and stores them in its own inbox.</p>
  </div>
  <dl class="stat-strip">
    <div class="stat"><dt>Endpoints</dt><dd class="num">${stats.forms}</dd></div>
    <div class="stat"><dt>In inbox</dt><dd class="num">${stats.inbox}</dd></div>
    <div class="stat"><dt>Spam</dt><dd class="num">${stats.spam}</dd></div>
    <div class="stat"><dt>Last submission</dt><dd class="num num-text">${escapeHtml(stats.lastSubmission)}</dd></div>
  </dl>
</div>

${flash ? `<p class="banner banner-ok" role="status">${escapeHtml(flash)}</p>` : ''}

<section class="panel reveal" aria-labelledby="create-title">
  <div class="panel-head">
    <h2 id="create-title">New endpoint</h2>
    <p class="meta">Name it after the page it serves — you can rename it later.</p>
  </div>
  <form class="create-form" method="post" action="/app/forms" data-busy-on-submit>
    <div class="field field-grow">
      <label for="form-name">Form name</label>
      <input class="input" id="form-name" name="name" type="text" required maxlength="${MAX_FORM_NAME}" placeholder="Product waitlist" value="${escapeHtml(values.name || '')}"${error ? ' aria-invalid="true" aria-describedby="form-name-error"' : ''}>
    </div>
    <button class="btn btn-primary" type="submit" data-busy-label="Creating…">${ICONS.plus}Create form</button>
  </form>
  ${error ? `<p class="field-error" id="form-name-error" role="alert">${escapeHtml(error)}</p>` : ''}
</section>

<section class="panel reveal" aria-labelledby="endpoints-title">
  <div class="panel-head">
    <h2 id="endpoints-title">Endpoints</h2>
    <p class="meta">Counts update as submissions arrive.</p>
  </div>
  ${list}
</section>`;

  return pageShell({
    title: 'Your form endpoints · Formdrop',
    user,
    breadcrumb: [{ label: 'Workspace', href: '/app' }, { label: 'Endpoints' }],
    content,
  });
}

function renderFormRow(form, requestOrigin) {
  const counts = countSubmissions(form.id);
  const endpointUrl = `${requestOrigin}/f/${form.id}`;
  const originPolicy = form.allowedOrigins.length
    ? plural(form.allowedOrigins.length, 'allowed origin')
    : 'Any origin may post';
  return `<li class="endpoint-row">
  <div class="endpoint-main">
    <h3 class="endpoint-name"><a href="/app/forms/${escapeHtml(form.id)}" data-palette="${escapeHtml(`${form.name} — inbox`)}">${escapeHtml(form.name)}</a></h3>
    <p class="endpoint-url">
      <span class="mono">${escapeHtml(endpointUrl)}</span>
      <button class="btn btn-xs" type="button" data-copy="${escapeHtml(endpointUrl)}">Copy URL</button>
    </p>
    <p class="meta">${form.honeypotEnabled ? `Honeypot on field “${escapeHtml(form.honeypotField)}”` : 'Honeypot off'} · ${escapeHtml(originPolicy)}</p>
  </div>
  <dl class="counts">
    <div><dt>Inbox</dt><dd class="num">${counts.inbox}</dd></div>
    <div><dt>Spam</dt><dd class="num">${counts.spam}</dd></div>
    <div><dt>Total</dt><dd class="num">${counts.all}</dd></div>
  </dl>
  <div class="endpoint-actions">
    <a class="btn btn-sm" href="/app/forms/${escapeHtml(form.id)}">Open inbox</a>
    <a class="btn btn-sm btn-ghost" href="/f/${escapeHtml(form.id)}" data-palette="${escapeHtml(`${form.name} — public form`)}">View form</a>
  </div>
</li>`;
}
/* --------------------------------- form view ------------------------------ */

function formPage({ user, form, submissions, counts, filter, saved, error, settingsErrors, settingsValues, requestOrigin }) {
  const endpointUrl = `${requestOrigin}/f/${form.id}`;
  const chips = [
    { key: 'all', label: 'All', count: counts.all },
    { key: 'inbox', label: 'Inbox', count: counts.inbox },
    { key: 'spam', label: 'Spam', count: counts.spam },
  ]
    .map(
      (chip) =>
        `<a class="chip${filter === chip.key ? ' is-active' : ''}" href="/app/forms/${escapeHtml(form.id)}?filter=${chip.key}"${filter === chip.key ? ' aria-current="true"' : ''}>${chip.label} <span class="num">${chip.count}</span></a>`,
    )
    .join('');

  const rows = submissions.length
    ? submissions.map((submission) => renderSubmissionRow(submission, form, filter)).join('')
    : `<div class="empty">
        <h3>${filter === 'spam' ? 'Nothing flagged as spam' : filter === 'inbox' ? 'The inbox is empty' : 'No submissions yet'}</h3>
        <p>${filter === 'spam' ? 'Manual flags and honeypot catches will appear here.' : 'Send a test post from the public form — it will show up here immediately.'}</p>
        <p><a class="btn btn-sm" href="/f/${escapeHtml(form.id)}">Open the public form</a></p>
      </div>`;

  const settingsNameError = settingsErrors.name
    ? `<p class="field-error" id="settings-name-error">${escapeHtml(settingsErrors.name)}</p>`
    : '';
  const settingsOriginsError = settingsErrors.allowedOrigins
    ? `<p class="field-error" id="settings-origins-error">${escapeHtml(settingsErrors.allowedOrigins)}</p>`
    : '';
  const settingsHoneypotError = settingsErrors.honeypotField
    ? `<p class="field-error" id="settings-honeypot-error">${escapeHtml(settingsErrors.honeypotField)}</p>`
    : '';

  const originSummary = form.allowedOrigins.length
    ? `Only ${form.allowedOrigins.map((origin) => `<code class="mono">${escapeHtml(origin)}</code>`).join(', ')} may post.`
    : 'Any origin may post — no allowlist is set.';

  const content = `<div class="page-head reveal">
  <div>
    <p class="eyebrow">Endpoint</p>
    <h1>${escapeHtml(form.name)}</h1>
    <p class="endpoint-url">
      <span class="mono">${escapeHtml(endpointUrl)}</span>
      <button class="btn btn-xs" type="button" data-copy="${escapeHtml(endpointUrl)}">Copy URL</button>
      <a class="btn btn-xs btn-ghost" href="/f/${escapeHtml(form.id)}" data-palette="${escapeHtml(`${form.name} — public form`)}">View public form</a>
    </p>
  </div>
  <div class="page-actions">
    <a class="btn" href="/api/forms/${escapeHtml(form.id)}/submissions/export.csv?filter=${escapeHtml(filter)}" download>${ICONS.table}Export CSV</a>
  </div>
</div>

${saved ? '<p class="banner banner-ok" role="status">Settings saved.</p>' : ''}
${error ? `<p class="banner banner-error" role="alert">${escapeHtml(error)}</p>` : ''}

<div class="workspace">
  <section class="panel workspace-inbox reveal" aria-labelledby="inbox-title">
    <div class="panel-head panel-head-row">
      <div>
        <h2 id="inbox-title">Submissions</h2>
        <p class="meta">${plural(counts.all, 'submission')} stored · ${counts.spam} flagged as spam</p>
      </div>
      <div class="filters" role="group" aria-label="Filter submissions by status">${chips}</div>
    </div>
    ${rows}
  </section>

  <aside class="panel workspace-settings reveal" id="settings" aria-labelledby="settings-title">
    <div class="panel-head">
      <h2 id="settings-title">Settings</h2>
      <p class="meta">Saved to this endpoint immediately.</p>
    </div>

    <form class="settings-form" method="post" action="/app/forms/${escapeHtml(form.id)}/settings" data-busy-on-submit>
      <div class="field">
        <label for="settings-name">Form name</label>
        <input class="input" id="settings-name" name="name" type="text" required maxlength="${MAX_FORM_NAME}" value="${escapeHtml(settingsValues.name)}"${settingsErrors.name ? ' aria-invalid="true" aria-describedby="settings-name-error"' : ''}>
        ${settingsNameError}
      </div>

      <div class="field">
        <label for="settings-origins">Allowed origins</label>
        <textarea class="input textarea" id="settings-origins" name="allowedOrigins" rows="4" spellcheck="false" placeholder="https://example.com"${settingsErrors.allowedOrigins ? ' aria-invalid="true" aria-describedby="settings-origins-error"' : ''}>${escapeHtml(settingsValues.allowedOrigins)}</textarea>
        <p class="hint">One origin per line, full URL. Leave empty to accept posts from any origin.</p>
        ${settingsOriginsError}
      </div>

      <fieldset class="fieldset">
        <legend>Honeypot</legend>
        <label class="check">
          <input type="checkbox" name="honeypotEnabled" value="yes"${settingsValues.honeypotEnabled ? ' checked' : ''}>
          <span>Flag submissions that fill the hidden field</span>
        </label>
        <div class="field">
          <label for="settings-honeypot">Hidden field name</label>
          <input class="input mono" id="settings-honeypot" name="honeypotField" type="text" maxlength="40" value="${escapeHtml(settingsValues.honeypotField)}"${settingsErrors.honeypotField ? ' aria-invalid="true" aria-describedby="settings-honeypot-error"' : ''}>
          ${settingsHoneypotError}
        </div>
      </fieldset>

      <button class="btn btn-primary btn-block" type="submit" data-busy-label="Saving…">Save settings</button>
    </form>

    <section class="settings-summary" aria-labelledby="effective-title">
      <h3 id="effective-title">Effective settings</h3>
      ${renderFeatureList([
        { icon: ICONS.shield, text: originSummary },
        {
          icon: ICONS.alert,
          text: form.honeypotEnabled
            ? `A filled “${escapeHtml(form.honeypotField)}” field stores the post as spam.`
            : 'Honeypot is off — every post lands in the inbox.',
        },
        { icon: ICONS.inbox, text: 'Spam can be toggled by hand from any row in the inbox.' },
        { icon: ICONS.table, text: 'CSV export follows the filter above.' },
      ])}
    </section>

    <section class="danger-zone" aria-labelledby="danger-title">
      <h3 id="danger-title">Delete endpoint</h3>
      <p class="meta">Removes the endpoint and all ${counts.all} stored submissions. This cannot be undone.</p>
      <form method="post" action="/app/forms/${escapeHtml(form.id)}/delete">
        <label class="check">
          <input type="checkbox" name="confirm" value="yes" required>
          <span>I understand this deletes the endpoint and its submissions.</span>
        </label>
        <button class="btn btn-danger btn-block" type="submit">Delete form</button>
      </form>
    </section>
  </aside>
</div>`;

  return pageShell({
    title: `${form.name} · Formdrop`,
    description: `Submissions and settings for the ${form.name} endpoint.`,
    user,
    breadcrumb: [{ label: 'Workspace', href: '/app' }, { label: form.name }],
    content,
  });
}

function summariseSubmission(submission) {
  const entries = Object.entries(submission.fields || {}).map(([name, value]) => [name, fieldToString(value)]);
  const find = (pattern) => entries.find(([name]) => pattern.test(name));
  const email = find(/e-?mail/i);
  const named = find(/^(full\s*)?name$/i) || find(/name/i);
  const message = find(/message|comment|body|notes?|msg|details/i);
  const longest = entries.slice().sort((a, b) => b[1].length - a[1].length)[0];
  const who = (email && email[1]) || (named && named[1]) || (entries[0] && entries[0][1]) || 'No fields';
  const snippet = (message && message[1]) || (longest && longest[1]) || 'No content';
  return {
    who: truncate(who, 56),
    snippet: truncate(snippet.replace(/\s+/g, ' '), 96),
  };
}

function renderSubmissionRow(submission, form, filter) {
  const summary = summariseSubmission(submission);
  const status = submission.isSpam
    ? '<span class="pill pill-spam">Spam</span>'
    : '<span class="pill pill-inbox">Inbox</span>';
  const fieldRows = Object.entries(submission.fields || {})
    .map(([name, value]) => `<div><dt>${escapeHtml(name)}</dt><dd>${escapeHtml(fieldToString(value)) || '<span class="meta">empty</span>'}</dd></div>`)
    .join('');
  return `<details class="sub">
  <summary>
    <span class="chev" aria-hidden="true">${ICONS.chevron}</span>
    <span class="sub-when"><time datetime="${escapeHtml(submission.submittedAt)}">${escapeHtml(humanizeWhen(submission.submittedAt))}</time></span>
    <span class="sub-who">${escapeHtml(summary.who)}</span>
    <span class="sub-snippet">${escapeHtml(summary.snippet)}</span>
    <span class="sub-status">${status}</span>
  </summary>
  <div class="sub-body">
    <p class="meta">Received ${escapeHtml(formatDateTime(submission.submittedAt))}${submission.origin ? ` from <code class="mono">${escapeHtml(submission.origin)}</code>` : ' without an Origin header'}</p>
    <dl class="field-table">${fieldRows || '<div><dt>fields</dt><dd><span class="meta">none submitted</span></dd></div>'}</dl>
    <div class="sub-actions">
      <form class="inline-form" method="post" action="/app/forms/${escapeHtml(form.id)}/submissions/${escapeHtml(submission.id)}/spam">
        <input type="hidden" name="filter" value="${escapeHtml(filter)}">
        <input type="hidden" name="isSpam" value="${submission.isSpam ? 'false' : 'true'}">
        <button class="btn btn-sm" type="submit">${submission.isSpam ? 'Mark as not spam' : 'Mark as spam'}</button>
      </form>
      <form class="inline-form" method="post" action="/app/forms/${escapeHtml(form.id)}/submissions/${escapeHtml(submission.id)}/delete">
        <input type="hidden" name="filter" value="${escapeHtml(filter)}">
        <label class="check check-inline"><input type="checkbox" name="confirm" value="yes" required><span>Confirm</span></label>
        <button class="btn btn-sm btn-danger" type="submit">Delete submission</button>
      </form>
      ${submission.spamReason ? `<span class="meta">Flag reason: ${escapeHtml(submission.spamReason)}</span>` : ''}
    </div>
  </div>
</details>`;
}

/* ------------------------------ public form view -------------------------- */

function publicFormPage({ form, requestOrigin, error = '', status = 0 }) {
  const endpointUrl = `${requestOrigin}/f/${form.id}`;
  const honeypot = form.honeypotEnabled
    ? `<div class="hp" aria-hidden="true">
        <label for="hp-field">Leave this field empty</label>
        <input id="hp-field" name="${escapeHtml(form.honeypotField)}" type="text" tabindex="-1" autocomplete="off">
      </div>`
    : '';

  const content = `<div class="public-wrap reveal">
  <header class="public-head">
    <p class="eyebrow">Public form</p>
    <h1>${escapeHtml(form.name)}</h1>
    <p class="lede">This is the example form Formdrop renders for the endpoint. Posts go to <code class="mono">/f/${escapeHtml(form.id)}</code> on this instance.</p>
  </header>

  ${error ? `<p class="banner banner-error" role="alert">${escapeHtml(error)}</p>` : ''}

  <form class="panel public-form" method="post" action="/f/${escapeHtml(form.id)}" data-busy-on-submit>
    <div class="field">
      <label for="pf-name">Name</label>
      <input class="input" id="pf-name" name="name" type="text" autocomplete="name" required maxlength="120">
    </div>
    <div class="field">
      <label for="pf-email">Email</label>
      <input class="input" id="pf-email" name="email" type="email" inputmode="email" autocomplete="email" required maxlength="160">
    </div>
    <div class="field">
      <label for="pf-message">Message</label>
      <textarea class="input textarea" id="pf-message" name="message" rows="5" required maxlength="4000"></textarea>
    </div>
    ${honeypot}
    <button class="btn btn-primary" type="submit" data-busy-label="Sending…">Send message</button>
  </form>

  <section class="embed-note panel" aria-labelledby="embed-title">
    <h2 id="embed-title">Embed it on your site</h2>
    <p class="meta">Any field name works — Formdrop stores whatever the form posts.</p>
    <pre class="code"><code>&lt;form action="${escapeHtml(endpointUrl)}" method="post"&gt;
  &lt;input name="name" type="text"&gt;
  &lt;input name="email" type="email"&gt;
  &lt;textarea name="message"&gt;&lt;/textarea&gt;
  &lt;button type="submit"&gt;Send&lt;/button&gt;
&lt;/form&gt;</code></pre>
    ${renderFeatureList([
      {
        icon: ICONS.shield,
        text: form.allowedOrigins.length
          ? `Posts are accepted from ${form.allowedOrigins.map((origin) => escapeHtml(origin)).join(', ')}.`
          : 'Any origin may post to this endpoint.',
      },
      {
        icon: ICONS.alert,
        text: form.honeypotEnabled
          ? `The hidden “${escapeHtml(form.honeypotField)}” field flags bots as spam.`
          : 'No honeypot is configured for this endpoint.',
      },
      { icon: ICONS.inbox, text: 'Submissions land in the owner’s inbox and can be exported as CSV.' },
    ])}
    <p class="meta">Own this page? <a href="/login">Sign in</a> to open the inbox.</p>
  </section>
</div>`;

  return pageShell({
    title: `${form.name} · Formdrop`,
    description: `Send a message through the ${form.name} form endpoint.`,
    content,
    bodyClass: 'public-body',
  });
}

function thankYouPage({ form, requestOrigin }) {
  const content = `<div class="public-wrap reveal">
  <section class="panel thanks" aria-labelledby="thanks-title">
    <p class="thanks-mark" aria-hidden="true">${ICONS.check}</p>
    <h1 id="thanks-title">Submission received</h1>
    <p class="lede">Thanks — your message went to the <strong>${escapeHtml(form.name)}</strong> inbox. Fields are stored exactly as they were posted.</p>
    <div class="thanks-actions">
      <a class="btn" href="/f/${escapeHtml(form.id)}">Send another</a>
      <a class="btn btn-ghost" href="/login">Sign in to the inbox</a>
    </div>
    <p class="meta mono">${escapeHtml(requestOrigin)}/f/${escapeHtml(form.id)}</p>
  </section>
</div>`;
  return pageShell({
    title: `Submission received · ${form.name} · Formdrop`,
    description: 'Your submission was stored.',
    content,
    bodyClass: 'public-body',
  });
}

/* -------------------------------- error views ----------------------------- */

function notFoundPage({ user = null, message = 'That page does not exist.', detail = '' }) {
  const content = `<div class="not-found reveal">
  <p class="eyebrow">404</p>
  <h1>Not found</h1>
  <p class="lede">${escapeHtml(message)}</p>
  ${detail ? `<p class="meta">${escapeHtml(detail)}</p>` : ''}
  <div class="page-actions">
    <a class="btn" href="${user ? '/app' : '/login'}">${user ? 'Back to your endpoints' : 'Go to sign in'}</a>
  </div>
</div>`;
  return pageShell({
    title: 'Not found · Formdrop',
    user,
    breadcrumb: user ? [{ label: 'Workspace', href: '/app' }, { label: 'Not found' }] : [],
    content,
  });
}

function errorPage({ status = 500, title = 'Something went wrong', message = '', detail = '', user = null, retryHref = '' }) {
  const content = `<div class="not-found reveal">
  <p class="eyebrow">${status}</p>
  <h1>${escapeHtml(title)}</h1>
  <p class="lede">${escapeHtml(message || 'The request could not be completed.')}</p>
  ${detail ? `<p class="meta">${escapeHtml(detail)}</p>` : ''}
  <div class="page-actions">
    ${retryHref ? `<a class="btn" href="${escapeHtml(retryHref)}">Try again</a>` : ''}
    <a class="btn btn-ghost" href="${user ? '/app' : '/login'}">${user ? 'Your endpoints' : 'Sign in'}</a>
  </div>
</div>`;
  return pageShell({
    title: `${title} · Formdrop`,
    user,
    breadcrumb: user ? [{ label: 'Workspace', href: '/app' }, { label: title }] : [],
    content,
  });
}
/* --------------------------------- handlers ------------------------------- */

function requireUserHtml(req, res) {
  const user = currentUser(req);
  if (!user) {
    redirect(res, '/login', 302);
    return null;
  }
  return user;
}

function requireApiUser(req, res) {
  const user = currentUser(req);
  if (!user) {
    sendJson(res, 401, { error: 'unauthorized', message: 'Sign in to continue.' });
    return null;
  }
  return user;
}

function readFilter(value) {
  return value === 'inbox' || value === 'spam' ? value : 'all';
}

function filterSubmissions(list, filter) {
  if (filter === 'spam') return list.filter((submission) => submission.isSpam);
  if (filter === 'inbox') return list.filter((submission) => !submission.isSpam);
  return list;
}

function countList(list) {
  const counts = { all: list.length, inbox: 0, spam: 0 };
  for (const submission of list) {
    if (submission.isSpam) counts.spam += 1;
    else counts.inbox += 1;
  }
  return counts;
}

function settingsValuesFromForm(form) {
  return {
    name: form.name,
    allowedOrigins: form.allowedOrigins.join('\n'),
    honeypotEnabled: form.honeypotEnabled,
    honeypotField: form.honeypotField,
  };
}

function dashboardStats(forms) {
  const formIds = new Set(forms.map((form) => form.id));
  let inbox = 0;
  let spam = 0;
  let latest = '';
  for (const submission of db.submissions) {
    if (!formIds.has(submission.formId)) continue;
    if (submission.isSpam) spam += 1;
    else inbox += 1;
    if (!latest || submission.submittedAt > latest) latest = submission.submittedAt;
  }
  return {
    forms: forms.length,
    inbox,
    spam,
    lastSubmission: latest ? humanizeWhen(latest) : 'No submissions',
  };
}

function formsForUser(user) {
  return db.forms
    .filter((form) => form.userId === user.id)
    .sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));
}

function handleHealth(req, res) {
  send(res, 200, 'ok', { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
}

function handleRoot(req, res) {
  const user = currentUser(req);
  redirect(res, user ? '/app' : '/login', 302);
}

function handleLoginPage(req, res) {
  const user = currentUser(req);
  if (user) {
    redirect(res, safeNextPath(null), 302);
    return;
  }
  const mode = new URL(req.url || '/login', BASE_ORIGIN).searchParams.get('mode') === 'signup' ? 'signup' : 'login';
  sendHtml(res, 200, loginPage({ mode }));
}

function handleSignupPage(req, res) {
  const user = currentUser(req);
  if (user) {
    redirect(res, '/app', 302);
    return;
  }
  sendHtml(res, 200, loginPage({ mode: 'signup' }));
}

async function handleLoginSubmit(req, res) {
  const raw = await readBody(req, 8 * 1024);
  const fields = parseSubmittedFields(req.headers['content-type'], raw);
  const mode = fields.mode === 'signup' ? 'signup' : 'login';
  const email = String(fields.email || '').trim();
  const password = String(fields.password || '');

  const errors = {};
  if (!email) errors.email = 'Enter your email address.';
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = 'That does not look like an email address.';
  if (!password) errors.password = mode === 'signup' ? 'Choose a password of at least 8 characters.' : 'Enter your password.';
  else if (mode === 'signup' && password.length < 8) errors.password = 'Use at least 8 characters.';

  if (Object.keys(errors).length) {
    sendHtml(res, 422, loginPage({ mode, values: { email }, errors }));
    return;
  }

  if (rateLimited(`ip:${requestIp(req)}`, 60, 15 * 60000) || rateLimited(`id:${email.toLowerCase()}`, 10, 15 * 60000)) {
    sendHtml(
      res,
      429,
      loginPage({ mode, values: { email }, formError: 'Too many attempts. Wait a few minutes and try again.' }),
      { 'Retry-After': '300' },
    );
    return;
  }

  if (mode === 'signup') {
    if (findUserByEmail(email)) {
      sendHtml(res, 409, loginPage({ mode, values: { email }, errors: { email: 'That email already has an account — sign in instead.' } }));
      return;
    }
    const user = createUser(email, password, false);
    const token = createSession(user);
    res.setHeader('Set-Cookie', sessionCookie(req, token));
    redirect(res, '/app');
    return;
  }

  const user = findUserByEmail(email);
  if (!user || !passwordMatches(password, user)) {
    // One message for both an unknown email and a wrong password.
    sendHtml(res, 401, loginPage({ mode: 'login', values: { email }, formError: 'Email or password is incorrect.' }));
    return;
  }
  const token = createSession(user);
  res.setHeader('Set-Cookie', sessionCookie(req, token));
  redirect(res, '/app');
}

function handleLogout(req, res) {
  destroySession(req);
  res.setHeader('Set-Cookie', clearedSessionCookie(req));
  redirect(res, '/login');
}

function handleDashboard(req, res) {
  const user = requireUserHtml(req, res);
  if (!user) return;
  const forms = formsForUser(user);
  const flash = req.url && req.url.includes('created=') ? 'Form created — the endpoint is ready to embed.' : '';
  sendHtml(
    res,
    200,
    dashboardPage({
      user,
      forms,
      stats: dashboardStats(forms),
      values: { name: '' },
      error: '',
      flash,
      requestOrigin: originOf(req),
    }),
  );
}

async function handleCreateFormSubmit(req, res) {
  const user = requireUserHtml(req, res);
  if (!user) return;
  const raw = await readBody(req, 8 * 1024);
  const fields = parseSubmittedFields(req.headers['content-type'], raw);
  const name = String(fields.name || '').trim();
  const forms = formsForUser(user);

  let error = '';
  if (!name) error = 'Give the form a name — for example “Product waitlist”.';
  else if (name.length > MAX_FORM_NAME) error = `Keep the name under ${MAX_FORM_NAME} characters.`;

  if (error) {
    sendHtml(
      res,
      422,
      dashboardPage({
        user,
        forms,
        stats: dashboardStats(forms),
        values: { name },
        error,
        flash: '',
        requestOrigin: originOf(req),
      }),
    );
    return;
  }

  const form = createForm(user, name);
  redirect(res, `/app?created=${encodeURIComponent(form.id)}`);
}

function renderFormWorkspace(req, res, user, form, extras = {}) {
  const filter = readFilter(extras.filter);
  const all = submissionsForForm(form.id);
  sendHtml(
    res,
    extras.status || 200,
    formPage({
      user,
      form,
      filter,
      submissions: filterSubmissions(all, filter),
      counts: countList(all),
      requestOrigin: originOf(req),
      saved: Boolean(extras.saved),
      error: extras.error || '',
      settingsErrors: extras.settingsErrors || {},
      settingsValues: extras.settingsValues || settingsValuesFromForm(form),
    }),
  );
}

function handleFormDetail(req, res, ctx) {
  const user = requireUserHtml(req, res);
  if (!user) return;
  const form = ownedForm(user, ctx.params.formId);
  if (!form) {
    sendHtml(res, 404, notFoundPage({ user, message: 'That endpoint does not exist, or it belongs to another account.' }));
    return;
  }
  renderFormWorkspace(req, res, user, form, {
    filter: ctx.url.searchParams.get('filter') || 'all',
    saved: ctx.url.searchParams.get('saved') === '1',
  });
}

async function handleSettingsSubmit(req, res, ctx) {
  const user = requireUserHtml(req, res);
  if (!user) return;
  const form = ownedForm(user, ctx.params.formId);
  if (!form) {
    sendHtml(res, 404, notFoundPage({ user, message: 'That endpoint does not exist, or it belongs to another account.' }));
    return;
  }
  const raw = await readBody(req, 16 * 1024);
  const fields = parseSubmittedFields(req.headers['content-type'], raw);
  const input = {
    name: fields.name === undefined ? form.name : fields.name,
    allowedOrigins: fields.allowedOrigins === undefined ? '' : fields.allowedOrigins,
    honeypotEnabled: fields.honeypotEnabled === 'yes' || fields.honeypotEnabled === 'true',
    honeypotField: fields.honeypotField === undefined ? form.honeypotField : fields.honeypotField,
  };
  const result = validateFormSettings(input);
  const submittedValues = {
    name: String(input.name),
    allowedOrigins: String(input.allowedOrigins),
    honeypotEnabled: Boolean(input.honeypotEnabled),
    honeypotField: String(input.honeypotField),
  };

  if (Object.keys(result.errors).length) {
    renderFormWorkspace(req, res, user, form, {
      status: 422,
      filter: 'all',
      error: 'That change was not saved — check the highlighted field.',
      settingsErrors: result.errors,
      settingsValues: submittedValues,
    });
    return;
  }

  form.name = result.name;
  form.allowedOrigins = result.allowedOrigins || [];
  form.honeypotEnabled = Boolean(result.honeypotEnabled);
  form.honeypotField = result.honeypotField || form.honeypotField;
  form.updatedAt = nowIso();
  persist();
  redirect(res, `/app/forms/${encodeURIComponent(form.id)}?saved=1`);
}

async function handleFormDeleteSubmit(req, res, ctx) {
  const user = requireUserHtml(req, res);
  if (!user) return;
  const form = ownedForm(user, ctx.params.formId);
  if (!form) {
    sendHtml(res, 404, notFoundPage({ user, message: 'That endpoint does not exist, or it belongs to another account.' }));
    return;
  }
  const raw = await readBody(req, 4 * 1024);
  const fields = parseSubmittedFields(req.headers['content-type'], raw);
  if (fields.confirm !== 'yes') {
    renderFormWorkspace(req, res, user, form, {
      status: 422,
      error: 'Tick the confirmation box before deleting this endpoint.',
    });
    return;
  }
  deleteFormCascade(form);
  redirect(res, '/app');
}

async function handleSpamSubmit(req, res, ctx) {
  const user = requireUserHtml(req, res);
  if (!user) return;
  const found = ownedSubmission(user, ctx.params.submissionId);
  if (!found) {
    sendHtml(res, 404, notFoundPage({ user, message: 'That submission does not exist, or it belongs to another account.' }));
    return;
  }
  const raw = await readBody(req, 4 * 1024);
  const fields = parseSubmittedFields(req.headers['content-type'], raw);
  found.submission.isSpam = fields.isSpam === 'true';
  found.submission.spamReason = found.submission.isSpam ? 'Flagged manually as spam' : '';
  persist();
  redirect(res, `/app/forms/${encodeURIComponent(found.form.id)}?filter=${readFilter(fields.filter)}`);
}

async function handleSubmissionDeleteSubmit(req, res, ctx) {
  const user = requireUserHtml(req, res);
  if (!user) return;
  const found = ownedSubmission(user, ctx.params.submissionId);
  if (!found) {
    sendHtml(res, 404, notFoundPage({ user, message: 'That submission does not exist, or it belongs to another account.' }));
    return;
  }
  const raw = await readBody(req, 4 * 1024);
  const fields = parseSubmittedFields(req.headers['content-type'], raw);
  if (fields.confirm !== 'yes') {
    renderFormWorkspace(req, res, user, found.form, {
      status: 422,
      filter: readFilter(fields.filter),
      error: 'Tick the confirmation box before deleting a submission.',
    });
    return;
  }
  db.submissions = db.submissions.filter((item) => item.id !== found.submission.id);
  persist();
  redirect(res, `/app/forms/${encodeURIComponent(found.form.id)}?filter=${readFilter(fields.filter)}`);
}

/* ------------------------------- public intake ---------------------------- */

function handlePublicFormPage(req, res, ctx) {
  const form = db.forms.find((item) => item.id === ctx.params.formId);
  if (!form) {
    sendHtml(res, 404, notFoundPage({ message: 'That form endpoint does not exist on this Formdrop instance.' }));
    return;
  }
  sendHtml(res, 200, publicFormPage({ form, requestOrigin: originOf(req) }));
}

async function handlePublicFormSubmit(req, res, ctx) {
  const form = db.forms.find((item) => item.id === ctx.params.formId);
  if (!form) {
    throw new HttpError(404, 'That form endpoint does not exist on this Formdrop instance.');
  }

  const raw = await readBody(req);
  const fields = parseSubmittedFields(req.headers['content-type'], raw);

  const origin = String(req.headers.origin || '');
  if (form.allowedOrigins.length && origin) {
    let requestOrigin = origin;
    try {
      requestOrigin = normalizedOrigin(new URL(origin));
    } catch {
      requestOrigin = origin;
    }
    // The instance's own origin is always accepted so an owner can test the
    // endpoint from its public example form; the allowlist governs other sites.
    const fromThisInstance = requestOrigin === originOf(req);
    if (!fromThisInstance && !form.allowedOrigins.includes(requestOrigin)) {
      const message = `This endpoint only accepts posts from ${form.allowedOrigins.join(', ')} (received ${requestOrigin}).`;
      if (wantsJson(req)) {
        sendJson(res, 403, { error: 'origin_not_allowed', message });
        return;
      }
      sendHtml(res, 403, publicFormPage({ form, requestOrigin: originOf(req), error: message }));
      return;
    }
  }

  if (Object.keys(fields).length === 0) {
    throw new HttpError(400, 'That post contained no fields to store.');
  }

  const trapValue = form.honeypotEnabled ? fieldToString(fields[form.honeypotField]) : '';
  const isSpam = Boolean(form.honeypotEnabled && trapValue.trim());
  const submission = {
    id: newId('sub'),
    formId: form.id,
    fields: { ...fields },
    isSpam,
    spamReason: isSpam ? `Honeypot field “${form.honeypotField}” was filled in` : '',
    origin,
    userAgent: String(req.headers['user-agent'] || '').slice(0, 300),
    submittedAt: nowIso(),
  };
  db.submissions.push(submission);
  form.updatedAt = submission.submittedAt;
  persist();

  if (wantsJson(req)) {
    sendJson(res, 201, { ok: true, id: submission.id, spam: isSpam });
    return;
  }
  sendHtml(res, 200, thankYouPage({ form, requestOrigin: originOf(req) }));
}
/* ----------------------------------- API ---------------------------------- */

function apiFormPayload(form, requestOrigin) {
  const counts = countSubmissions(form.id);
  return {
    id: form.id,
    name: form.name,
    endpointPath: `/f/${form.id}`,
    endpointUrl: `${requestOrigin}/f/${form.id}`,
    allowedOrigins: form.allowedOrigins,
    honeypotEnabled: form.honeypotEnabled,
    honeypotField: form.honeypotField,
    createdAt: form.createdAt,
    updatedAt: form.updatedAt,
    submissionCount: counts.all,
    inboxCount: counts.inbox,
    spamCount: counts.spam,
  };
}

function apiSubmissionPayload(submission) {
  return {
    id: submission.id,
    formId: submission.formId,
    fields: submission.fields,
    isSpam: Boolean(submission.isSpam),
    spamReason: submission.spamReason || '',
    origin: submission.origin || '',
    userAgent: submission.userAgent || '',
    submittedAt: submission.submittedAt,
  };
}

function handleApiMe(req, res) {
  const user = currentUser(req);
  if (!user) {
    sendJson(res, 401, { error: 'unauthorized', message: 'Sign in to continue.' });
    return;
  }
  sendJson(res, 200, { user: publicUser(user) });
}

async function handleApiSignup(req, res) {
  const body = await readJsonBody(req);
  const email = String(body.email === undefined ? '' : body.email).trim();
  const password = String(body.password === undefined ? '' : body.password);
  const errors = {};
  if (!email) errors.email = 'Enter your email address.';
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = 'That does not look like an email address.';
  if (!password) errors.password = 'Choose a password of at least 8 characters.';
  else if (password.length < 8) errors.password = 'Use at least 8 characters.';
  if (Object.keys(errors).length) {
    sendJson(res, 400, { error: 'invalid_input', message: 'Check the highlighted fields.', errors });
    return;
  }
  if (findUserByEmail(email)) {
    sendJson(res, 409, { error: 'email_taken', message: 'That email already has an account — sign in instead.' });
    return;
  }
  const user = createUser(email, password, false);
  const token = createSession(user);
  res.setHeader('Set-Cookie', sessionCookie(req, token));
  sendJson(res, 201, { user: publicUser(user), redirect: '/app' });
}

async function handleApiLogin(req, res) {
  const body = await readJsonBody(req);
  const email = String(body.email === undefined ? '' : body.email).trim();
  const password = String(body.password === undefined ? '' : body.password);

  if (!email || !password) {
    sendJson(res, 400, { error: 'invalid_input', message: 'Email and password are both required.' });
    return;
  }
  if (rateLimited(`ip:${requestIp(req)}`, 60, 15 * 60000) || rateLimited(`id:${email.toLowerCase()}`, 10, 15 * 60000)) {
    sendJson(res, 429, { error: 'too_many_attempts', message: 'Too many attempts. Wait a few minutes and try again.' }, { 'Retry-After': '300' });
    return;
  }
  const user = findUserByEmail(email);
  if (!user || !passwordMatches(password, user)) {
    sendJson(res, 401, { error: 'invalid_credentials', message: 'Email or password is incorrect.' });
    return;
  }
  const token = createSession(user);
  res.setHeader('Set-Cookie', sessionCookie(req, token));
  sendJson(res, 200, { user: publicUser(user), redirect: '/app' });
}

function handleApiLogout(req, res) {
  destroySession(req);
  res.setHeader('Set-Cookie', clearedSessionCookie(req));
  sendJson(res, 200, { ok: true });
}

function handleApiFormsList(req, res) {
  const user = requireApiUser(req, res);
  if (!user) return;
  sendJson(res, 200, {
    forms: formsForUser(user).map((form) => apiFormPayload(form, originOf(req))),
  });
}

async function handleApiFormCreate(req, res) {
  const user = requireApiUser(req, res);
  if (!user) return;
  const body = await readJsonBody(req);
  const name = String(body.name === undefined ? '' : body.name).trim();
  if (!name) {
    sendJson(res, 400, { error: 'invalid_input', message: 'A form name is required.', errors: { name: 'A form name is required.' } });
    return;
  }
  if (name.length > MAX_FORM_NAME) {
    sendJson(res, 400, {
      error: 'invalid_input',
      message: `Keep the name under ${MAX_FORM_NAME} characters.`,
      errors: { name: `Keep the name under ${MAX_FORM_NAME} characters.` },
    });
    return;
  }
  const form = createForm(user, name);
  sendJson(res, 201, { form: apiFormPayload(form, originOf(req)) });
}

function handleApiFormGet(req, res, ctx) {
  const user = requireApiUser(req, res);
  if (!user) return;
  const form = ownedForm(user, ctx.params.formId);
  if (!form) {
    sendJson(res, 404, { error: 'not_found', message: 'That endpoint does not exist.' });
    return;
  }
  sendJson(res, 200, { form: apiFormPayload(form, originOf(req)) });
}

function formUpdateInput(form, body) {
  const input = { name: body.name === undefined ? form.name : String(body.name) };
  if (body.allowedOrigins !== undefined) {
    input.allowedOrigins = Array.isArray(body.allowedOrigins) ? body.allowedOrigins.join('\n') : String(body.allowedOrigins);
  }
  if (body.honeypotEnabled !== undefined) {
    input.honeypotEnabled = body.honeypotEnabled === true || body.honeypotEnabled === 'true' || body.honeypotEnabled === 'yes';
  }
  if (body.honeypotField !== undefined) input.honeypotField = String(body.honeypotField);
  return input;
}

async function handleApiFormUpdate(req, res, ctx) {
  const user = requireApiUser(req, res);
  if (!user) return;
  const form = ownedForm(user, ctx.params.formId);
  if (!form) {
    sendJson(res, 404, { error: 'not_found', message: 'That endpoint does not exist.' });
    return;
  }
  const body = await readJsonBody(req);
  const supported = ['name', 'allowedOrigins', 'honeypotEnabled', 'honeypotField'];
  if (!supported.some((key) => body[key] !== undefined)) {
    sendJson(res, 400, { error: 'invalid_input', message: `Send at least one of: ${supported.join(', ')}.` });
    return;
  }
  const result = validateFormSettings(formUpdateInput(form, body));
  if (Object.keys(result.errors).length) {
    sendJson(res, 400, { error: 'invalid_input', message: 'Check the highlighted fields.', errors: result.errors });
    return;
  }
  form.name = result.name;
  form.allowedOrigins = result.allowedOrigins || [];
  if (result.honeypotEnabled !== undefined) form.honeypotEnabled = result.honeypotEnabled;
  if (result.honeypotField) form.honeypotField = result.honeypotField;
  form.updatedAt = nowIso();
  persist();
  sendJson(res, 200, { form: apiFormPayload(form, originOf(req)) });
}

function handleApiFormDelete(req, res, ctx) {
  const user = requireApiUser(req, res);
  if (!user) return;
  const form = ownedForm(user, ctx.params.formId);
  if (!form) {
    sendJson(res, 404, { error: 'not_found', message: 'That endpoint does not exist.' });
    return;
  }
  const removed = countSubmissions(form.id).all;
  deleteFormCascade(form);
  sendJson(res, 200, { ok: true, deletedFormId: form.id, deletedSubmissions: removed });
}

function handleApiSubmissionsList(req, res, ctx) {
  const user = requireApiUser(req, res);
  if (!user) return;
  const form = ownedForm(user, ctx.params.formId);
  if (!form) {
    sendJson(res, 404, { error: 'not_found', message: 'That endpoint does not exist.' });
    return;
  }
  const filter = readFilter(ctx.url.searchParams.get('filter'));
  const all = submissionsForForm(form.id);
  sendJson(res, 200, {
    filter,
    counts: countList(all),
    submissions: filterSubmissions(all, filter).map(apiSubmissionPayload),
  });
}

async function handleApiSubmissionUpdate(req, res, ctx) {
  const user = requireApiUser(req, res);
  if (!user) return;
  const found = ownedSubmission(user, ctx.params.submissionId);
  if (!found) {
    sendJson(res, 404, { error: 'not_found', message: 'That submission does not exist.' });
    return;
  }
  const body = await readJsonBody(req);
  if (typeof body.isSpam !== 'boolean') {
    sendJson(res, 400, { error: 'invalid_input', message: 'Send { "isSpam": true } or { "isSpam": false }.' });
    return;
  }
  found.submission.isSpam = body.isSpam;
  found.submission.spamReason = body.isSpam
    ? String(body.spamReason || 'Flagged manually as spam').slice(0, 200)
    : '';
  persist();
  sendJson(res, 200, { submission: apiSubmissionPayload(found.submission) });
}

function handleApiSubmissionDelete(req, res, ctx) {
  const user = requireApiUser(req, res);
  if (!user) return;
  const found = ownedSubmission(user, ctx.params.submissionId);
  if (!found) {
    sendJson(res, 404, { error: 'not_found', message: 'That submission does not exist.' });
    return;
  }
  db.submissions = db.submissions.filter((item) => item.id !== found.submission.id);
  persist();
  sendJson(res, 200, { ok: true, deletedSubmissionId: found.submission.id });
}

function handleApiSubmissionsExport(req, res, ctx) {
  const user = requireApiUser(req, res);
  if (!user) return;
  const form = ownedForm(user, ctx.params.formId);
  if (!form) {
    sendJson(res, 404, { error: 'not_found', message: 'That endpoint does not exist.' });
    return;
  }
  const filter = readFilter(ctx.url.searchParams.get('filter'));
  const rows = filterSubmissions(submissionsForForm(form.id), filter);
  const csv = submissionsToCsv(rows);
  const filename = `formdrop-${slugify(form.name)}-${filter}.csv`;
  send(res, 200, csv, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'no-store',
  });
}

/* -------------------------------- static files ---------------------------- */

const STATIC_ROUTES = {
  '/static/app.css': { file: 'app.css', type: 'text/css; charset=utf-8' },
  '/static/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/static/fonts.css': { file: 'fonts.css', type: 'text/css; charset=utf-8' },
  '/static/favicon.svg': { file: 'favicon.svg', type: 'image/svg+xml' },
};

function serveStatic(res, pathname) {
  let filePath = null;
  let contentType = 'application/octet-stream';
  let cacheControl = 'no-cache';

  if (STATIC_ROUTES[pathname]) {
    filePath = path.join(STATIC_DIR, STATIC_ROUTES[pathname].file);
    contentType = STATIC_ROUTES[pathname].type;
  } else {
    const fontMatch = /^\/static\/fonts\/([a-z0-9-]+\.woff2)$/.exec(pathname);
    if (fontMatch) {
      filePath = path.join(STATIC_DIR, 'fonts', fontMatch[1]);
      contentType = 'font/woff2';
      cacheControl = 'public, max-age=31536000, immutable';
    }
  }

  if (!filePath) {
    send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
    return;
  }
  try {
    const data = fs.readFileSync(filePath);
    send(res, 200, data, { 'Content-Type': contentType, 'Cache-Control': cacheControl });
  } catch (error) {
    console.error(`[formdrop] static asset missing: ${filePath}`, error.message);
    send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
  }
}

/* ---------------------------------- router -------------------------------- */

const ROUTES = [
  ['GET', '/health', handleHealth],
  ['GET', '/', handleRoot],
  ['GET', '/login', handleLoginPage],
  ['GET', '/signup', handleSignupPage],
  ['POST', '/login', handleLoginSubmit],
  ['POST', '/logout', handleLogout],
  ['GET', '/app', handleDashboard],
  ['POST', '/app/forms', handleCreateFormSubmit],
  ['GET', '/app/forms/:formId', handleFormDetail],
  ['POST', '/app/forms/:formId/settings', handleSettingsSubmit],
  ['POST', '/app/forms/:formId/delete', handleFormDeleteSubmit],
  ['POST', '/app/forms/:formId/submissions/:submissionId/spam', handleSpamSubmit],
  ['POST', '/app/forms/:formId/submissions/:submissionId/delete', handleSubmissionDeleteSubmit],
  ['GET', '/f/:formId', handlePublicFormPage],
  ['POST', '/f/:formId', handlePublicFormSubmit],
  ['GET', '/api/auth/me', handleApiMe],
  ['POST', '/api/auth/signup', handleApiSignup],
  ['POST', '/api/auth/login', handleApiLogin],
  ['POST', '/api/auth/logout', handleApiLogout],
  ['GET', '/api/forms', handleApiFormsList],
  ['POST', '/api/forms', handleApiFormCreate],
  ['GET', '/api/forms/:formId', handleApiFormGet],
  ['PATCH', '/api/forms/:formId', handleApiFormUpdate],
  ['DELETE', '/api/forms/:formId', handleApiFormDelete],
  ['GET', '/api/forms/:formId/submissions', handleApiSubmissionsList],
  ['GET', '/api/forms/:formId/submissions/export.csv', handleApiSubmissionsExport],
  ['PATCH', '/api/submissions/:submissionId', handleApiSubmissionUpdate],
  ['DELETE', '/api/submissions/:submissionId', handleApiSubmissionDelete],
];

function matchPattern(pattern, pathname) {
  const patternParts = pattern.split('/');
  const pathParts = pathname.split('/');
  if (patternParts.length !== pathParts.length) return null;
  const params = {};
  for (let index = 0; index < patternParts.length; index += 1) {
    const segment = patternParts[index];
    if (segment.startsWith(':')) {
      if (!pathParts[index]) return null;
      try {
        params[segment.slice(1)] = decodeURIComponent(pathParts[index]);
      } catch {
        return null;
      }
    } else if (segment !== pathParts[index]) {
      return null;
    }
  }
  return params;
}

function matchRoute(method, pathname) {
  for (const [routeMethod, pattern, handler] of ROUTES) {
    if (routeMethod !== method) continue;
    const params = matchPattern(pattern, pathname);
    if (params) return { handler, params };
  }
  return null;
}

function titleForStatus(status) {
  switch (status) {
    case 400:
      return 'That request could not be read';
    case 403:
      return 'Not allowed';
    case 404:
      return 'Not found';
    case 413:
      return 'That post is too large';
    case 415:
      return 'Unsupported content type';
    case 429:
      return 'Too many attempts';
    default:
      return 'Something went wrong';
  }
}

async function handleRequest(req, res) {
  const url = new URL(req.url || '/', PUBLIC_ORIGIN || `${ORIGIN_SCHEME}://${req.headers.host || ORIGIN_HOST}`);
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  const method = req.method === 'HEAD' ? 'GET' : req.method;

  if (pathname.startsWith('/static/')) {
    serveStatic(res, pathname);
    return;
  }

  const route = matchRoute(method, pathname);
  if (!route) {
    if (pathname.startsWith('/api/')) {
      sendJson(res, 404, { error: 'not_found', message: `No API route for ${method} ${pathname}.` });
      return;
    }
    const user = currentUser(req);
    sendHtml(res, 404, notFoundPage({ user, message: 'That page does not exist.' }));
    return;
  }

  // CSRF guard: cross-origin state changes are rejected. The public intake
  // endpoint has its own per-form origin allowlist instead.
  if (!pathname.startsWith('/f/') && !sameOrigin(req)) {
    throw new HttpError(403, 'Cross-origin request blocked. Reload the page and try again.');
  }

  await route.handler(req, res, { params: route.params, url, pathname });
}

/* --------------------------------- bootstrap ------------------------------ */

function handleRequestFailure(req, res, error) {
  const status = error instanceof HttpError ? error.status : 500;
  if (!(error instanceof HttpError)) {
    console.error(`[formdrop] unhandled error on ${req.method} ${req.url}:`, error);
  }
  if (res.headersSent) {
    try {
      res.end();
    } catch (endError) {
      console.error('[formdrop] failed to close response', endError.message);
    }
    return;
  }
  const safeMessage =
    status === 500
      ? 'Something went wrong on the server. The full error is in the server log.'
      : error.message || 'The request could not be completed.';
  const isApi = String(req.url || '').startsWith('/api/') || wantsJson(req);
  if (isApi) {
    sendJson(res, status, { error: status === 500 ? 'internal_error' : 'request_failed', message: safeMessage });
    return;
  }
  let user = null;
  try {
    user = currentUser(req);
  } catch (lookupError) {
    console.error('[formdrop] could not resolve the session for the error page', lookupError.message);
  }
  sendHtml(
    res,
    status,
    errorPage({
      status,
      title: titleForStatus(status),
      message: safeMessage,
      user,
      retryHref: req.method === 'GET' ? req.url : '',
    }),
  );
}

function startServer() {
  loadDatabase();
  seedDemoWorkspace();

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((error) => handleRequestFailure(req, res, error));
  });

  server.on('error', (error) => {
    console.error('[formdrop] server error:', error);
    process.exit(1);
  });

  server.listen(PORT, HOST, () => {
    const address = server.address();
    const boundPort = address && typeof address === 'object' ? address.port : PORT;
    console.log(`[formdrop] listening on http://${HOST}:${boundPort}`);
    console.log(`[formdrop] demo login: ${DEMO_PRIMARY.email} / ${DEMO_PRIMARY.password}`);
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  return server;
}

function runSeedCommand() {
  loadDatabase();
  seedDemoWorkspace();
  const forms = db.forms.length;
  const submissions = db.submissions.length;
  console.log(`[formdrop] seed complete — ${db.users.length} users, ${forms} forms, ${submissions} submissions`);
  console.log(`[formdrop] demo login: ${DEMO_PRIMARY.email} / ${DEMO_PRIMARY.password}`);
}

if (process.argv.includes('--seed')) {
  runSeedCommand();
  process.exit(0);
}

startServer();
