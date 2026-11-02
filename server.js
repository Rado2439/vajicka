'use strict';
// Vajíčka – spoločné objednávanie vajíčok. Bez externých závislostí (Node 20+).

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname;
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(ROOT, 'config.json');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');
// počiatočný zoznam ľudí mimo gitu (skutočné mená a e-maily)
const PEOPLE_PATH = process.env.PEOPLE_PATH || path.join(ROOT, 'people.json');
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 3000);
const TEAMS_WEBHOOK_URL = process.env.TEAMS_WEBHOOK_URL || '';
const ADMIN_PIN = process.env.ADMIN_PIN || '';
const APP_URL = process.env.APP_URL || '';

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const TZ = config.timezone || 'Europe/Bratislava';
const packPriceCents = Math.round(Number(config.packPrice) * 100);
const packSize = Number(config.packSize) || 10;

// ---------- Časové pásmo ----------

const dtf = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
});
const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function zonedParts(ts) {
  const p = {};
  for (const { type, value } of dtf.formatToParts(new Date(ts))) p[type] = value;
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second, wd: WD[p.weekday] };
}

function tzOffset(ts) {
  const p = zonedParts(ts);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ts / 1000) * 1000;
}

// Lokálny čas v TZ -> UTC timestamp
function zonedToUtc(y, m, d, h = 0, mi = 0) {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  let ts = guess - tzOffset(guess);
  ts = guess - tzOffset(ts);
  return ts;
}

const pad = (n) => String(n).padStart(2, '0');
const dateKey = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
function addDays(key, n) {
  const [y, m, d] = key.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return dateKey(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

function deadlineFor(deliveryKey) {
  const [h, mi] = String(config.deadlineTime || '20:00').split(':').map(Number);
  const [y, m, d] = addDays(deliveryKey, -(config.deadlineDaysBefore ?? 1)).split('-').map(Number);
  return zonedToUtc(y, m, d, h, mi);
}

function opensAt(deliveryKey) {
  const prev = addDays(deliveryKey, -7);
  if (config.openNextOn === 'delivery') {
    const [y, m, d] = prev.split('-').map(Number);
    return zonedToUtc(y, m, d, 0, 0);
  }
  return deadlineFor(prev);
}

function nextDeliveries(now, count = 3) {
  const p = zonedParts(now);
  let key = dateKey(p.y, p.m, p.d);
  const shift = (config.deliveryWeekday - p.wd + 7) % 7;
  key = addDays(key, shift - 7);
  const out = [];
  for (let i = 0; i < count + 1; i++) out.push(addDays(key, 7 * i));
  return out;
}

// Aktuálne otvorená objednávka (alebo null, ak je medzi uzávierkou a stredou a openNextOn=delivery)
function openDeliveryKey(now = Date.now()) {
  for (const k of nextDeliveries(now)) {
    if (now < deadlineFor(k) && now >= opensAt(k)) return k;
  }
  return null;
}

// ---------- Úložisko ----------

let db;
function loadDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_PATH)) {
    db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } else {
    db = { people: [], supplierId: null, orders: {} };
    const seed = fs.existsSync(PEOPLE_PATH) ? JSON.parse(fs.readFileSync(PEOPLE_PATH, 'utf8')) : config.people || [];
    for (const p of seed) {
      const id = newId();
      db.people.push({ id, name: p.name, email: p.email || '', active: true });
      if (p.supplier) db.supplierId = id;
    }
    saveDb();
  }
}
function saveDb() {
  const tmp = DB_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_PATH);
}
function newId() { return crypto.randomBytes(6).toString('hex'); }

function ensureOrder(key) {
  if (!db.orders[key]) {
    db.orders[key] = {
      id: key,
      deliveryDate: key,
      deadline: new Date(deadlineFor(key)).toISOString(),
      packSize,
      packPriceCents,
      entries: {},
      teams: { sentAt: null, error: null, autoAttempts: 0 },
    };
    saveDb();
  }
  return db.orders[key];
}

const isOpen = (o, now = Date.now()) => now < Date.parse(o.deadline);
const amountCents = (o, qty) => Math.round((qty * o.packPriceCents) / o.packSize);

function lastClosedKey(now = Date.now()) {
  return Object.values(db.orders)
    .filter((o) => !isOpen(o, now) && Object.keys(o.entries).length)
    .map((o) => o.id).sort().pop() || null;
}

function personById(id) { return db.people.find((p) => p.id === id); }

function summarize(o) {
  const rows = Object.entries(o.entries)
    .filter(([, e]) => e.qty > 0)
    .map(([pid, e]) => {
      const p = personById(pid);
      return {
        personId: pid, name: p ? p.name : e.name, qty: e.qty,
        cents: amountCents(o, e.qty), paid: !!e.paid, paidAt: e.paidAt || null,
        paidByName: e.paidBy ? (personById(e.paidBy)?.name || '') : '',
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'sk'));
  const totalQty = rows.reduce((s, r) => s + r.qty, 0);
  const totalCents = rows.reduce((s, r) => s + r.cents, 0);
  const unpaid = rows.filter((r) => !r.paid);
  const status = isOpen(o) ? 'open' : 'closed';
  const lc = lastClosedKey();
  return {
    id: o.id, deliveryDate: o.deliveryDate, deadline: o.deadline, status,
    editablePayments: status === 'open' || o.id === lc,
    packSize: o.packSize, packPriceCents: o.packPriceCents,
    rows, totalQty, totalCents,
    packs: totalQty / o.packSize,
    unpaidCount: unpaid.length,
    unpaidCents: unpaid.reduce((s, r) => s + r.cents, 0),
    teams: { sentAt: o.teams.sentAt, error: o.teams.error },
  };
}

// ---------- Teams ----------

const fmtEur = (c) => (c / 100).toFixed(2).replace('.', ',') + ' ' + (config.currency || '€');
const fmtDate = (key) => { const [y, m, d] = key.split('-'); return `${+d}. ${+m}. ${y}`; };
const fmtPacks = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1).replace('.', ','));

function buildTeamsPayload(s) {
  const supplier = personById(db.supplierId);
  const body = [];
  const entities = [];
  let greeting;
  if (supplier && supplier.email) {
    greeting = `<at>${supplier.name}</at>, tu je objednávka vajíčok na stredu ${fmtDate(s.deliveryDate)}:`;
    entities.push({ type: 'mention', text: `<at>${supplier.name}</at>`, mentioned: { id: supplier.email, name: supplier.name } });
  } else {
    greeting = `${supplier ? '**' + supplier.name + '**, t' : 'T'}u je objednávka vajíčok na stredu ${fmtDate(s.deliveryDate)}:`;
  }
  body.push({ type: 'TextBlock', size: 'Large', weight: 'Bolder', text: '🥚 Objednávka vajíčok – ' + fmtDate(s.deliveryDate) });
  body.push({ type: 'TextBlock', wrap: true, text: greeting });
  if (s.rows.length) {
    body.push({
      type: 'FactSet',
      facts: s.rows.map((r) => ({ title: r.name, value: `${r.qty} ks – ${fmtEur(r.cents)}${r.paid ? ' ✅' : ''}` })),
    });
  } else {
    body.push({ type: 'TextBlock', text: 'Tento týždeň si nikto nič neobjednal.', wrap: true });
  }
  const whole = Number.isInteger(s.packs);
  body.push({
    type: 'FactSet', separator: true,
    facts: [
      { title: 'Spolu kusov', value: `${s.totalQty} ks` },
      { title: `Balení po ${s.packSize} ks`, value: fmtPacks(s.packs) + (whole ? '' : ` (do celého balenia chýba ${s.packSize - (s.totalQty % s.packSize)} ks)`) },
      { title: 'Celková suma', value: fmtEur(s.totalCents) },
      { title: 'Nezaplatené', value: `${s.unpaidCount} os. / ${fmtEur(s.unpaidCents)}` },
    ],
  });
  return wrapCard(body, entities, 'Otvoriť aplikáciu');
}

function wrapCard(body, entities, actionTitle) {
  const card = {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard', version: '1.4', body,
    msteams: { width: 'Full', ...(entities.length ? { entities } : {}) },
  };
  if (APP_URL) card.actions = [{ type: 'Action.OpenUrl', title: actionTitle, url: APP_URL }];
  return {
    type: 'message',
    attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', contentUrl: null, content: card }],
  };
}

// Osoba v správe: @označenie, ak má e-mail, inak tučné meno
function mention(p, entities) {
  if (!p.email) return `**${p.name}**`;
  entities.push({ type: 'mention', text: `<at>${p.name}</at>`, mentioned: { id: p.email, name: p.name } });
  return `<at>${p.name}</at>`;
}

// Koho pripomienka označí: aktívni, nevypli si ju a ešte nemajú objednané
function reminderRecipients(o) {
  return db.people.filter((p) => p.active && p.remind !== false && !(o.entries[p.id]?.qty > 0))
    .sort((a, b) => a.name.localeCompare(b.name, 'sk'));
}

function buildReminderPayload(o) {
  const s = summarize(o);
  const entities = [];
  const who = reminderRecipients(o).map((p) => mention(p, entities));
  const body = [
    { type: 'TextBlock', size: 'Large', weight: 'Bolder', wrap: true, text: `🥚 Vajíčka na stredu ${fmtDate(o.deliveryDate)}?` },
    { type: 'TextBlock', wrap: true, text: `Uzávierka: ${fmtDeadline(o.deadline)}. Cena ${fmtEur(o.packPriceCents)} za ${o.packSize} ks.` },
  ];
  if (who.length) body.push({ type: 'TextBlock', wrap: true, text: `Ešte si neobjednali: ${who.join(', ')}` });
  body.push({ type: 'TextBlock', wrap: true, isSubtle: true, spacing: 'Small',
    text: s.rows.length ? `Zatiaľ objednané: ${s.totalQty} ks od ${s.rows.length} ${s.rows.length === 1 ? 'človeka' : 'ľudí'}.` : 'Zatiaľ si nikto neobjednal.' });
  return wrapCard(body, entities, 'Objednať');
}

const WEEKDAYS = ['nedeľa', 'pondelok', 'utorok', 'streda', 'štvrtok', 'piatok', 'sobota'];
function fmtDeadline(iso) {
  const p = zonedParts(Date.parse(iso));
  return `${WEEKDAYS[p.wd]} ${p.d}. ${p.m}. o ${pad(p.h)}:${pad(p.mi)}`;
}

async function postToTeams(payload) {
  if (!TEAMS_WEBHOOK_URL) throw new Error('Nie je nastavená premenná TEAMS_WEBHOOK_URL');
  const res = await fetch(TEAMS_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Teams odpovedal ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

async function sendReminder(orderId) {
  const o = db.orders[orderId];
  if (!o) throw new Error('Objednávka neexistuje');
  o.reminder ||= { sentAt: null, error: null, autoAttempts: 0 };
  try {
    await postToTeams(buildReminderPayload(o));
    o.reminder.sentAt = new Date().toISOString();
    o.reminder.error = null;
  } catch (e) {
    o.reminder.error = e.message;
    saveDb();
    throw e;
  }
  saveDb();
}

async function sendToTeams(orderId) {
  const o = db.orders[orderId];
  if (!o) throw new Error('Objednávka neexistuje');
  try {
    await postToTeams(buildTeamsPayload(summarize(o)));
    o.teams.sentAt = new Date().toISOString();
    o.teams.error = null;
  } catch (e) {
    o.teams.error = e.message;
    saveDb();
    throw e;
  }
  saveDb();
}

// Čas pondelkovej pripomienky pre objednávku s dodaním v daný deň
function reminderAt(deliveryKey) {
  const [h, mi] = String(config.reminderTime || '08:00').split(':').map(Number);
  const [y, m, d] = addDays(deliveryKey, -(config.reminderDaysBefore ?? 2)).split('-').map(Number);
  return zonedToUtc(y, m, d, h, mi);
}

// Pripomienka ide len raz, len kým je objednávka otvorená a nie neskôr ako 6 h po termíne
// (napr. po výpadku servera sa nepošle v utorok večer)
function reminderDue(o, now = Date.now()) {
  if (config.reminderEnabled === false || !isOpen(o, now)) return false;
  const at = reminderAt(o.deliveryDate);
  const r = o.reminder || {};
  return now >= at && now - at < 6 * 3600000 && !r.sentAt && (r.autoAttempts || 0) < 5;
}

// Plánovač: otvorí novú objednávku, v pondelok pripomenie a po uzávierke pošle súhrn
async function tick() {
  const now = Date.now();
  const k = openDeliveryKey(now);
  if (k) {
    const o = ensureOrder(k);
    if (reminderDue(o, now)) {
      o.reminder ||= { sentAt: null, error: null, autoAttempts: 0 };
      o.reminder.autoAttempts++;
      saveDb();
      try { await sendReminder(k); console.log(`[teams] pripomienka ${k} odoslaná`); }
      catch (e) { console.error(`[teams] pripomienka ${k}: ${e.message}`); }
    }
  }
  const windowMs = (config.autoSendWithinDays ?? 3) * 86400000;
  for (const o of Object.values(db.orders)) {
    const dl = Date.parse(o.deadline);
    if (now >= dl && now - dl < windowMs && !o.teams.sentAt && o.teams.autoAttempts < 5) {
      o.teams.autoAttempts++;
      saveDb();
      try { await sendToTeams(o.id); console.log(`[teams] súhrn ${o.id} odoslaný`); }
      catch (e) { console.error(`[teams] ${o.id}: ${e.message}`); }
    }
  }
}

// ---------- HTTP ----------

function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new HttpError(400, 'Neplatný JSON')); } });
    req.on('error', reject);
  });
}

function requireAdmin(req) {
  if (ADMIN_PIN && req.headers['x-admin-pin'] !== ADMIN_PIN) throw new HttpError(403, 'Nesprávny PIN');
}

const publicPeople = () => db.people.filter((p) => p.active).map(({ id, name, remind }) => ({ id, name, remind: remind !== false }));

const routes = [
  ['GET', /^\/api\/bootstrap$/, () => {
    const k = openDeliveryKey();
    if (k) ensureOrder(k);
    const nk = k || nextDeliveries(Date.now()).find((x) => Date.now() < deadlineFor(x));
    return {
      config: {
        appTitle: config.appTitle, packSize, packPriceCents, currency: config.currency || '€',
        defaultQty: config.defaultQty ?? packSize, timezone: TZ,
      },
      people: publicPeople(),
      supplierId: db.supplierId,
      openOrderId: k,
      nextOpensAt: k ? null : new Date(opensAt(nk)).toISOString(),
      lastClosedId: lastClosedKey(),
      teamsConfigured: !!TEAMS_WEBHOOK_URL,
      adminPinRequired: !!ADMIN_PIN,
      serverTime: new Date().toISOString(),
    };
  }],
  ['GET', /^\/api\/orders$/, () =>
    Object.values(db.orders).map(summarize)
      .filter((s) => s.rows.length || s.status === 'open')
      .sort((a, b) => b.id.localeCompare(a.id))
      .map(({ rows, ...rest }) => rest)],
  ['GET', /^\/api\/orders\/(\d{4}-\d\d-\d\d)$/, (req, [id]) => {
    const o = db.orders[id];
    if (!o) throw new HttpError(404, 'Objednávka neexistuje');
    return summarize(o);
  }],
  ['PUT', /^\/api\/orders\/(\d{4}-\d\d-\d\d)\/entries\/(\w+)$/, async (req, [id, pid]) => {
    const { qty } = await readBody(req);
    const o = db.orders[id];
    if (!o) throw new HttpError(404, 'Objednávka neexistuje');
    if (!isOpen(o)) throw new HttpError(409, 'Objednávka je už uzavretá');
    const p = personById(pid);
    if (!p || !p.active) throw new HttpError(404, 'Neznáma osoba');
    const n = Math.floor(Number(qty));
    if (!Number.isFinite(n) || n < 0 || n > 1000) throw new HttpError(400, 'Neplatný počet kusov');
    if (n % packSize) throw new HttpError(400, `Objednať sa dá len po ${packSize} ks`);
    const e = o.entries[pid] || { qty: 0, paid: false };
    e.qty = n; e.name = p.name; e.updatedAt = new Date().toISOString();
    if (n === 0 && !e.paid) delete o.entries[pid]; else o.entries[pid] = e;
    saveDb();
    return summarize(o);
  }],
  ['PUT', /^\/api\/orders\/(\d{4}-\d\d-\d\d)\/entries\/(\w+)\/paid$/, async (req, [id, pid]) => {
    const { paid, actorId } = await readBody(req);
    const o = db.orders[id];
    if (!o) throw new HttpError(404, 'Objednávka neexistuje');
    if (!summarize(o).editablePayments) throw new HttpError(409, 'Staršie týždne sú len na čítanie');
    if (actorId !== pid && actorId !== db.supplierId) throw new HttpError(403, 'Platbu za iných môže označiť len zabezpečovateľ');
    const e = o.entries[pid];
    if (!e) throw new HttpError(404, 'Táto osoba nemá objednávku');
    e.paid = !!paid;
    e.paidAt = paid ? new Date().toISOString() : null;
    e.paidBy = paid ? actorId : null;
    saveDb();
    return summarize(o);
  }],
  ['POST', /^\/api\/orders\/(\d{4}-\d\d-\d\d)\/teams$/, async (req, [id]) => {
    if (!db.orders[id]) throw new HttpError(404, 'Objednávka neexistuje');
    try { await sendToTeams(id); } catch (e) { throw new HttpError(502, e.message); }
    return summarize(db.orders[id]);
  }],
  ['PUT', /^\/api\/people\/(\w+)\/remind$/, async (req, [pid]) => {
    const { remind, actorId } = await readBody(req);
    const p = personById(pid);
    if (!p || !p.active) throw new HttpError(404, 'Neznáma osoba');
    if (actorId !== pid) throw new HttpError(403, 'Pripomienky si môže zmeniť len každý sám');
    p.remind = !!remind;
    saveDb();
    return { remind: p.remind };
  }],
  ['POST', /^\/api\/reminder$/, async (req) => {
    requireAdmin(req);
    const k = openDeliveryKey();
    if (!k) throw new HttpError(409, 'Žiadna otvorená objednávka');
    ensureOrder(k);
    try { await sendReminder(k); } catch (e) { throw new HttpError(502, e.message); }
    return { ok: true, sentAt: db.orders[k].reminder.sentAt };
  }],
  // --- správa ľudí ---
  ['GET', /^\/api\/admin\/people$/, (req) => {
    requireAdmin(req);
    const k = openDeliveryKey();
    const o = k && db.orders[k];
    return {
      people: db.people.filter((p) => p.active), supplierId: db.supplierId,
      reminder: {
        enabled: config.reminderEnabled !== false,
        nextAt: o ? new Date(reminderAt(k)).toISOString() : null,
        sentAt: o?.reminder?.sentAt || null, error: o?.reminder?.error || null,
      },
    };
  }],
  ['POST', /^\/api\/admin\/people$/, async (req) => {
    requireAdmin(req);
    const { name, email } = await readBody(req);
    const n = String(name || '').trim();
    if (!n) throw new HttpError(400, 'Meno je povinné');
    const existing = db.people.find((p) => p.name.toLowerCase() === n.toLowerCase());
    if (existing && existing.active) throw new HttpError(409, 'Toto meno už v zozname je');
    if (existing) { existing.active = true; existing.email = String(email || existing.email || '').trim(); }
    else db.people.push({ id: newId(), name: n, email: String(email || '').trim(), active: true });
    saveDb();
    return { ok: true };
  }],
  // hromadné pridanie: riadky „Meno; email“, „Meno <email>“ alebo len „Meno“
  ['POST', /^\/api\/admin\/people\/bulk$/, async (req) => {
    requireAdmin(req);
    const { text } = await readBody(req);
    let added = 0, skipped = 0;
    for (const line of String(text || '').split(/\r?\n/)) {
      const m = line.trim().match(/^(.+?)\s*(?:[;,\t]\s*|<)\s*([^\s<>;,]+@[^\s<>;,]+)>?\s*$/);
      const name = (m ? m[1] : line).trim();
      if (!name) continue;
      const email = m ? m[2] : '';
      const existing = db.people.find((p) => p.name.toLowerCase() === name.toLowerCase());
      if (existing && existing.active) { skipped++; continue; }
      if (existing) Object.assign(existing, { active: true, email: email || existing.email });
      else db.people.push({ id: newId(), name, email, active: true });
      added++;
    }
    saveDb();
    return { added, skipped };
  }],
  ['PUT', /^\/api\/admin\/people\/(\w+)$/, async (req, [pid]) => {
    requireAdmin(req);
    const p = personById(pid);
    if (!p) throw new HttpError(404, 'Neznáma osoba');
    const { name, email, supplier } = await readBody(req);
    if (name !== undefined && String(name).trim()) p.name = String(name).trim();
    if (email !== undefined) p.email = String(email).trim();
    if (supplier) db.supplierId = pid;
    saveDb();
    return { ok: true };
  }],
  ['DELETE', /^\/api\/admin\/people\/(\w+)$/, (req, [pid]) => {
    requireAdmin(req);
    const p = personById(pid);
    if (!p) throw new HttpError(404, 'Neznáma osoba');
    if (db.supplierId === pid) throw new HttpError(409, 'Najprv urč iného zabezpečovateľa');
    p.active = false; // ponecháme kvôli histórii
    const k = openDeliveryKey();
    if (k && db.orders[k] && db.orders[k].entries[pid] && !db.orders[k].entries[pid].paid) delete db.orders[k].entries[pid];
    saveDb();
    return { ok: true };
  }],
];

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://x');
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Nenájdené'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://x').pathname;
  if (!pathname.startsWith('/api/')) return serveStatic(req, res);
  for (const [method, re, handler] of routes) {
    const m = pathname.match(re);
    if (m && req.method === method) {
      try { return send(res, 200, await handler(req, m.slice(1))); }
      catch (e) { return send(res, e.status || 500, { error: e.message }); }
    }
  }
  send(res, 404, { error: 'Neznáma požiadavka' });
});

function start() {
  loadDb();
  tick();
  setInterval(() => tick().catch((e) => console.error(e)), 60_000);
  server.listen(PORT, () => {
    console.log(`Vajíčka bežia na http://localhost:${PORT}`);
    console.log(`Teams webhook: ${TEAMS_WEBHOOK_URL ? 'nastavený' : 'NENASTAVENÝ (TEAMS_WEBHOOK_URL)'}; admin PIN: ${ADMIN_PIN ? 'áno' : 'nie'}`);
  });
}

if (require.main === module) start();

// pre testy
module.exports = {
  zonedToUtc, deadlineFor, openDeliveryKey, reminderAt, reminderDue,
  buildTeamsPayload, buildReminderPayload, summarize, ensureOrder, loadDb, server, tick,
  get db() { return db; },
};
