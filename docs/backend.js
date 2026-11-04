'use strict';
// Napojenie na Supabase: preloží požiadavky appky na volania databázových funkcií vj_*
// cez Supabase REST (/rest/v1/rpc/…). Adresa a verejný kľúč sú v config.js.

(() => {
  const cfg = window.VAJICKA_SUPABASE || {};

  async function rpc(fn, args) {
    if (!cfg.url || !cfg.anonKey || cfg.url.includes('DOPLN')) {
      const e = new Error('Appka ešte nie je napojená na Supabase – doplň adresu a kľúč v súbore config.js.');
      e.status = 503;
      throw e;
    }
    // nový „publishable“ kľúč (sb_publishable_…) ide len v hlavičke apikey,
    // starší anon kľúč (JWT) aj v Authorization
    const headers = { 'Content-Type': 'application/json', apikey: cfg.anonKey };
    if (!cfg.anonKey.startsWith('sb_')) headers.Authorization = `Bearer ${cfg.anonKey}`;
    const res = await fetch(`${cfg.url.replace(/\/$/, '')}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(args),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // databáza posiela HTTP stav (401, 403, 409…) v poli „hint“
      const e = new Error(data.code === 'PGRST202'
        ? 'V Supabase ešte nie je nahraná databáza Vajíčok – spusti supabase/databaza.sql v SQL Editore.'
        : data.message || `Chyba ${res.status}`);
      e.status = Number(data.hint) || res.status;
      throw e;
    }
    return data;
  }

  const routes = [
    ['GET', /^\/api\/bootstrap$/, (c) => rpc('vj_bootstrap', { p_code: c.code })],
    ['GET', /^\/api\/orders$/, (c) => rpc('vj_orders', { p_code: c.code })],
    ['GET', /^\/api\/orders\/([\d-]+)$/, (c, [id]) => rpc('vj_order', { p_code: c.code, p_id: id })],
    ['PUT', /^\/api\/orders\/([\d-]+)\/entries\/([^/]+)$/, (c, [id, pid], b) =>
      rpc('vj_set_qty', { p_code: c.code, p_id: id, p_person: pid, p_qty: b.qty })],
    ['PUT', /^\/api\/orders\/([\d-]+)\/entries\/([^/]+)\/paid$/, (c, [id, pid], b) =>
      rpc('vj_set_paid', { p_code: c.code, p_id: id, p_person: pid, p_actor: b.actorId, p_paid: b.paid })],
    ['POST', /^\/api\/orders\/([\d-]+)\/teams$/, (c, [id]) => rpc('vj_send_summary', { p_code: c.code, p_id: id })],
    ['PUT', /^\/api\/people\/([^/]+)\/remind$/, (c, [pid], b) =>
      rpc('vj_set_remind', { p_code: c.code, p_person: pid, p_actor: b.actorId, p_remind: b.remind })],
    ['POST', /^\/api\/reminder$/, (c) => rpc('vj_send_reminder', { p_code: c.code, p_pin: c.pin })],
    ['GET', /^\/api\/admin\/people$/, (c) => rpc('vj_admin_people', { p_code: c.code, p_pin: c.pin })],
    ['POST', /^\/api\/admin\/people$/, (c, m, b) => rpc('vj_admin_add', { p_code: c.code, p_pin: c.pin, p_name: b.name, p_email: b.email })],
    ['POST', /^\/api\/admin\/people\/bulk$/, (c, m, b) => rpc('vj_admin_bulk', { p_code: c.code, p_pin: c.pin, p_text: b.text })],
    ['PUT', /^\/api\/admin\/people\/([^/]+)$/, (c, [pid], b) => rpc('vj_admin_update', {
      p_code: c.code, p_pin: c.pin, p_person: pid, p_name: b.name ?? null, p_email: b.email ?? null, p_supplier: !!b.supplier })],
    ['DELETE', /^\/api\/admin\/people\/([^/]+)$/, (c, [pid]) => rpc('vj_admin_remove', { p_code: c.code, p_pin: c.pin, p_person: pid })],
  ];

  window.vajickaBackend = async (method, path, body, ctx) => {
    for (const [m, re, fn] of routes) {
      const match = path.match(re);
      if (match && m === method) return fn(ctx, match.slice(1), body || {});
    }
    throw new Error(`Neznáma požiadavka ${method} ${path}`);
  };
})();
