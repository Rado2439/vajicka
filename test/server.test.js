'use strict';
// Testy: node --test   (bez externých knižníc)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vajicka-'));
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
cfg.people = [
  { name: 'Ján Novák', email: 'jan@firma.sk', supplier: true },
  { name: 'Mária Kováčová', email: 'maria@firma.sk' },
  { name: 'Peter Horváth' },
];
fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify(cfg));
process.env.CONFIG_PATH = path.join(tmp, 'config.json');
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.PEOPLE_PATH = path.join(tmp, 'neexistuje.json');
process.env.APP_URL = 'https://vajicka.example';
delete process.env.TEAMS_WEBHOOK_URL;
delete process.env.ADMIN_PIN;

const app = require('../server.js');
app.loadDb();
const [jan, maria, peter] = app.db.people;
const iso = (ts) => new Date(ts).toISOString();

test('uzávierka je v utorok o 20:00 miestneho času (zimný aj letný čas)', () => {
  assert.equal(iso(app.deadlineFor('2026-11-04')), '2026-11-03T19:00:00.000Z'); // CET
  assert.equal(iso(app.deadlineFor('2026-06-10')), '2026-06-09T18:00:00.000Z'); // CEST
  assert.equal(iso(app.deadlineFor('2026-04-01')), '2026-03-31T18:00:00.000Z'); // po zmene času
});

test('nová objednávka sa otvorí hneď po uzávierke', () => {
  assert.equal(app.openDeliveryKey(Date.parse('2026-10-27T18:59:00Z')), '2026-10-28');
  assert.equal(app.openDeliveryKey(Date.parse('2026-10-27T19:01:00Z')), '2026-11-04');
  assert.equal(app.openDeliveryKey(Date.parse('2026-11-02T07:00:00Z')), '2026-11-04');
});

test('pripomienka je v pondelok o 8:00 miestneho času', () => {
  assert.equal(iso(app.reminderAt('2026-11-04')), '2026-11-02T07:00:00.000Z');
  assert.equal(iso(app.reminderAt('2026-06-10')), '2026-06-08T06:00:00.000Z');
});

test('pripomienka sa pošle len v okne po 8:00 a len raz', () => {
  const o = app.ensureOrder('2026-11-04');
  assert.equal(app.reminderDue(o, Date.parse('2026-11-02T06:59:00Z')), false, 'pred 8:00');
  assert.equal(app.reminderDue(o, Date.parse('2026-11-02T07:00:00Z')), true, 'o 8:00');
  assert.equal(app.reminderDue(o, Date.parse('2026-11-02T14:00:00Z')), false, 'neskôr ako 6 h');
  o.reminder = { sentAt: '2026-11-02T07:00:30Z', error: null, autoAttempts: 1 };
  assert.equal(app.reminderDue(o, Date.parse('2026-11-02T07:05:00Z')), false, 'už odoslaná');
  delete o.reminder;
});

test('pripomienka označí len tých, čo nemajú objednané a nevypli si ju', () => {
  const o = app.ensureOrder('2026-11-04');
  o.entries = { [jan.id]: { qty: 20, paid: false } };
  peter.remind = true;
  let card = app.buildReminderPayload(o).attachments[0].content;
  let text = card.body.map((b) => b.text).join('\n');
  assert.match(text, /<at>Mária Kováčová<\/at>/);
  assert.match(text, /\*\*Peter Horváth\*\*/, 'bez e-mailu len tučne');
  assert.doesNotMatch(text, /Ján Novák/, 'už objednal');
  assert.deepEqual(card.msteams.entities.map((e) => e.mentioned.id), ['maria@firma.sk']);
  assert.equal(card.actions[0].url, 'https://vajicka.example');

  maria.remind = false;
  text = app.buildReminderPayload(o).attachments[0].content.body.map((b) => b.text).join('\n');
  assert.doesNotMatch(text, /Mária/);
  maria.remind = true;
  o.entries = {};
});

test('súhrn označí zabezpečovateľa a spočíta sumy', () => {
  const o = app.ensureOrder('2026-11-04');
  o.entries = { [jan.id]: { qty: 30, paid: false }, [maria.id]: { qty: 10, paid: true } };
  const s = app.summarize(o);
  assert.equal(s.totalQty, 40);
  assert.equal(s.totalCents, 1200);
  assert.equal(s.unpaidCents, 900);
  const card = app.buildTeamsPayload(s).attachments[0].content;
  assert.deepEqual(card.msteams.entities[0].mentioned, { id: 'jan@firma.sk', name: 'Ján Novák' });
  o.entries = {};
});

test('HTTP: objednávka len po 10 ks, platby a pripomienky', async (t) => {
  await new Promise((r) => app.server.listen(0, r));
  t.after(() => app.server.close());
  const base = `http://localhost:${app.server.address().port}`;
  const call = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const { body: boot } = await call('GET', '/api/bootstrap');
  const id = boot.openOrderId;
  assert.ok(id);

  assert.equal((await call('PUT', `/api/orders/${id}/entries/${maria.id}`, { qty: 15 })).status, 400);
  assert.equal((await call('PUT', `/api/orders/${id}/entries/${maria.id}`, { qty: 20 })).body.totalQty, 20);

  const foreign = await call('PUT', `/api/orders/${id}/entries/${maria.id}/paid`, { paid: true, actorId: peter.id });
  assert.equal(foreign.status, 403, 'za iného len zabezpečovateľ');
  const bySupplier = await call('PUT', `/api/orders/${id}/entries/${maria.id}/paid`, { paid: true, actorId: jan.id });
  assert.equal(bySupplier.body.rows[0].paid, true);

  assert.equal((await call('PUT', `/api/people/${peter.id}/remind`, { remind: false, actorId: jan.id })).status, 403);
  assert.equal((await call('PUT', `/api/people/${peter.id}/remind`, { remind: false, actorId: peter.id })).body.remind, false);

  const bulk = await call('POST', '/api/admin/people/bulk', { text: 'Eva Nová; eva@firma.sk\nIvo Starý <ivo@firma.sk>\nOto Bez\nJán Novák; jan@firma.sk\n' });
  assert.deepEqual(bulk.body, { added: 3, skipped: 1 });
  const eva = app.db.people.find((p) => p.name === 'Eva Nová');
  assert.equal(eva.email, 'eva@firma.sk');
  assert.equal(app.db.people.find((p) => p.name === 'Ivo Starý').email, 'ivo@firma.sk');

  const r = await call('POST', '/api/reminder');
  assert.equal(r.status, 502, 'bez webhooku chyba');
  assert.match(r.body.error, /TEAMS_WEBHOOK_URL/);
});
