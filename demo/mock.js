// DEMO: simulovaný server v prehliadači (dáta sa neukladajú)
(() => {
  const pad = (n) => String(n).padStart(2, '0');
  const key = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const deadlineOf = (d) => { const t = new Date(d); t.setDate(t.getDate() - 1); t.setHours(20, 0, 0, 0); return t; };
  let wed = new Date(); wed.setHours(12, 0, 0, 0);
  wed.setDate(wed.getDate() + ((3 - wed.getDay() + 7) % 7));
  if (deadlineOf(wed) <= new Date()) wed.setDate(wed.getDate() + 7);
  const weeks = [0, 1, 2, 3].map((i) => { const d = new Date(wed); d.setDate(d.getDate() - 7 * i); return d; });

  const names = ['Ján Novák', 'Mária Kováčová', 'Peter Horváth', 'Zuzana Bieliková', 'Martin Šimko', 'Lucia Tóthová', 'Tomáš Baláž', 'Eva Kráľová'];
  // build.py môže vložiť skutočný zoznam z people.json (window.DEMO_PEOPLE)
  const src = window.DEMO_PEOPLE || names.map((name, i) => ({ name, email: i === 0 ? 'jan.novak@firma.sk' : '', supplier: i === 0 }));
  const people = src.map((p, i) => ({ id: 'p' + i, name: p.name, email: p.email || '', active: true, remind: true }));
  let supplierId = 'p' + Math.max(0, src.findIndex((p) => p.supplier));
  const orders = {};
  const mk = (d, entries, sent) => {
    const id = key(d);
    orders[id] = { id, deliveryDate: id, deadline: deadlineOf(d).toISOString(), packSize: 10, packPriceCents: 300, entries, teams: { sentAt: sent ? new Date(deadlineOf(d).getTime() + 60000).toISOString() : null, error: null } };
  };
  mk(weeks[0], { p0: { qty: 30, paid: false }, p2: { qty: 20, paid: true, paidBy: 'p2' }, p3: { qty: 10, paid: false }, p5: { qty: 10, paid: false } });
  mk(weeks[1], { p0: { qty: 20, paid: true }, p1: { qty: 10, paid: false }, p2: { qty: 40, paid: true, paidBy: 'p0' }, p4: { qty: 10, paid: false }, p6: { qty: 30, paid: true } }, true);
  mk(weeks[2], { p0: { qty: 30, paid: true }, p1: { qty: 20, paid: true }, p3: { qty: 10, paid: true }, p7: { qty: 20, paid: true } }, true);
  mk(weeks[3], { p1: { qty: 10, paid: true }, p2: { qty: 20, paid: true }, p6: { qty: 10, paid: false } }, true);
  let reminderSent = null;
  const openId = key(weeks[0]), lastClosed = key(weeks[1]);

  const pById = (id) => people.find((p) => p.id === id);
  const summarize = (o) => {
    const rows = Object.entries(o.entries).filter(([, e]) => e.qty > 0).map(([pid, e]) => ({
      personId: pid, name: pById(pid).name, qty: e.qty, cents: Math.round(e.qty * o.packPriceCents / o.packSize),
      paid: !!e.paid, paidByName: e.paidBy ? pById(e.paidBy).name : '' })).sort((a, b) => a.name.localeCompare(b.name, 'sk'));
    const unpaid = rows.filter((r) => !r.paid);
    const totalQty = rows.reduce((s, r) => s + r.qty, 0);
    return { id: o.id, deliveryDate: o.deliveryDate, deadline: o.deadline, status: o.id === openId ? 'open' : 'closed',
      editablePayments: o.id === openId || o.id === lastClosed, packSize: o.packSize, packPriceCents: o.packPriceCents,
      rows, totalQty, totalCents: rows.reduce((s, r) => s + r.cents, 0), packs: totalQty / o.packSize,
      unpaidCount: unpaid.length, unpaidCents: unpaid.reduce((s, r) => s + r.cents, 0), teams: o.teams };
  };
  const err = (status, error) => ({ status, body: { error } });
  function handle(method, path, body) {
    let m;
    if (path === '/api/bootstrap') return { body: { config: { appTitle: 'VAJÍČKA !', packSize: 10, packPriceCents: 300, currency: '€', defaultQty: 10, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
      people: people.filter((p) => p.active).map(({ id, name, remind }) => ({ id, name, remind })), supplierId, openOrderId: openId, nextOpensAt: null, lastClosedId: lastClosed, teamsConfigured: true } };
    if (path === '/api/orders') return { body: Object.values(orders).map(summarize).sort((a, b) => b.id.localeCompare(a.id)) };
    if ((m = path.match(/^\/api\/orders\/([\d-]+)$/))) return { body: summarize(orders[m[1]]) };
    if ((m = path.match(/^\/api\/orders\/([\d-]+)\/entries\/([^/]+)$/))) {
      const o = orders[m[1]]; const e = o.entries[m[2]] || { qty: 0, paid: false };
      e.qty = Math.max(0, Math.round(body.qty / 10) * 10); o.entries[m[2]] = e; return { body: summarize(o) };
    }
    if ((m = path.match(/^\/api\/orders\/([\d-]+)\/entries\/(\w+)\/paid$/))) {
      const o = orders[m[1]];
      if (body.actorId !== m[2] && body.actorId !== supplierId) return err(403, 'Platbu za iných môže označiť len zabezpečovateľ');
      Object.assign(o.entries[m[2]], { paid: !!body.paid, paidBy: body.paid ? body.actorId : null }); return { body: summarize(o) };
    }
    if ((m = path.match(/^\/api\/orders\/([\d-]+)\/teams$/))) { orders[m[1]].teams = { sentAt: new Date().toISOString(), error: null }; return { body: summarize(orders[m[1]]) }; }
    if ((m = path.match(/^\/api\/people\/(\w+)\/remind$/))) { pById(m[1]).remind = !!body.remind; return { body: { remind: !!body.remind } }; }
    if (path === '/api/reminder') { reminderSent = new Date().toISOString(); return { body: { ok: true } }; }
    if (path === '/api/admin/people' && method === 'GET') {
      const at = new Date(wed); at.setDate(at.getDate() - 2); at.setHours(8, 0, 0, 0);
      return { body: { people: people.filter((p) => p.active), supplierId, reminder: { enabled: true, nextAt: at.toISOString(), sentAt: reminderSent, error: null } } };
    }
    if (path === '/api/admin/people' && method === 'POST') {
      if (!String(body.name || '').trim()) return err(400, 'Meno je povinné');
      people.push({ id: 'p' + people.length, name: body.name.trim(), email: body.email || '', active: true }); return { body: { ok: true } };
    }
    if ((m = path.match(/^\/api\/admin\/people\/(\w+)$/))) {
      const p = pById(m[1]);
      if (method === 'DELETE') { if (m[1] === supplierId) return err(409, 'Najprv urč iného zabezpečovateľa'); p.active = false; return { body: { ok: true } }; }
      if (body.name) p.name = body.name; if (body.email !== undefined) p.email = body.email; if (body.supplier) supplierId = m[1];
      return { body: { ok: true } };
    }
    return err(404, 'Neznáma požiadavka');
  }
  // demo nahrádza napojenie na Supabase (backend.js)
  window.vajickaBackend = async (method, path, body) => {
    const r = handle(method, path, body || {});
    await new Promise((res) => setTimeout(res, 120));
    if (r.status >= 400) { const e = new Error(r.body.error); e.status = r.status; throw e; }
    return JSON.parse(JSON.stringify(r.body));
  };
  // demo nepoužíva uložené meno z iných spustení
  try { localStorage.removeItem('vajicka.me'); } catch {}
})();
