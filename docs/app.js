'use strict';

const $ = (s, el = document) => el.querySelector(s);
const main = $('#main');
const LS_ME = 'vajicka.me';
const LS_PIN = 'vajicka.pin';
const LS_CODE = 'vajicka.kod';

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* bez úložiska */ } },
};

const state = {
  boot: null,
  me: store.get(LS_ME),
  view: 'order',
  order: null,
  draft: 0,
  saveTimer: null,
  saveState: '',
  saveError: '',
  summaryId: null,
  histId: null,
  adminPin: store.get(LS_PIN) || '',
  code: store.get(LS_CODE) || '',
};

// Kód skupiny môže prísť v odkaze z Teams (…#kod=ABC123); uložíme ho a z adresy ho skryjeme
{
  const m = location.hash.match(/kod=([^&]+)/);
  if (m) {
    state.code = decodeURIComponent(m[1]);
    store.set(LS_CODE, state.code);
    history.replaceState(null, '', location.pathname + location.search);
  }
}

// ---------- pomocné ----------

// Všetky požiadavky idú cez backend.js (Supabase)
function api(method, url, body) {
  return window.vajickaBackend(method, url, body, { code: state.code, pin: state.adminPin });
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const eur = (c) => (c / 100).toFixed(2).replace('.', ',') + ' ' + (state.boot?.config.currency || '€');
const tzFmt = (opts) => new Intl.DateTimeFormat('sk-SK', { timeZone: state.boot?.config.timezone || 'Europe/Bratislava', ...opts });
const fmtDay = (key) => { const [y, m, d] = key.split('-'); return `${+d}. ${+m}. ${y}`; };
const fmtShort = (key) => { const [, m, d] = key.split('-'); return `${+d}. ${+m}.`; };
const fmtDeadline = (iso) => {
  const d = new Date(iso);
  return `${tzFmt({ weekday: 'long' }).format(d)} ${tzFmt({ day: 'numeric', month: 'numeric' }).format(d)} o ${tzFmt({ hour: '2-digit', minute: '2-digit' }).format(d)}`;
};
const fmtPacks = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1).replace('.', ','));
function countdown(iso) {
  let ms = Date.parse(iso) - Date.now();
  if (ms <= 0) return 'uzavreté';
  const d = Math.floor(ms / 864e5); ms -= d * 864e5;
  const h = Math.floor(ms / 36e5); ms -= h * 36e5;
  const m = Math.floor(ms / 6e4);
  return (d ? `${d} d ` : '') + `${h} h ${m} min`;
}
const initials = (name) => name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
const me = () => state.boot?.people.find((p) => p.id === state.me);
const isSupplier = () => state.me && state.me === state.boot?.supplierId;
const supplierName = () => state.boot?.people.find((p) => p.id === state.boot.supplierId)?.name || '—';
const cents = (qty) => Math.round((qty * state.boot.config.packPriceCents) / state.boot.config.packSize);
// Stav platby riadku: zaplatené / doplatiť X / nezaplatené
const payStatus = (r) => r.qty === 0 ? { text: r.paidCents > 0 ? `vrátiť ${eur(r.refundCents)}` : 'nedodané', cls: r.paidCents > 0 ? 'stav--pozor' : '' }
  : r.refundCents > 0 ? { text: `vrátiť ${eur(r.refundCents)}`, cls: 'stav--pozor' }
  : r.paid ? { text: 'zaplatené', cls: '' }
  : r.paidCents > 0 ? { text: `doplatiť ${eur(r.dueCents)}`, cls: 'stav--pozor' }
  : { text: 'nezaplatené', cls: 'stav--pozor' };
// Koľko kusov je už zaplatených (pod to sa objednávka nedá znížiť)
const paidQty = (r) => (r && r.paidCents > 0 ? Math.round((r.paidCents * state.boot.config.packSize) / state.boot.config.packPriceCents) : 0);
const CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

function payToggle({ checked, disabled, label, data = '' }) {
  return `<label class="pay"><input type="checkbox" ${data} ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
    <span class="pay__box">${CHECK}</span><span class="pay__label">${esc(label)}</span><span class="sr">${esc(label)}</span></label>`;
}

// ---------- navigácia ----------

document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', (e) => { e.preventDefault(); go(b.dataset.view); }));

function updateChrome() {
  const p = me();
  $('#tabs').hidden = !p;
  $('#userChip').hidden = !p;
  if (p) { $('#userName').textContent = p.name; $('#userInitials').textContent = initials(p.name); }
  $('#userChip').setAttribute('aria-label', p ? `Prihlásený: ${p.name}. Zmeniť meno` : '');
  document.querySelectorAll('#tabs [data-view]').forEach((b) => {
    if (b.dataset.view === state.view) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
}

async function go(view, opts = {}) {
  if (view !== 'who' && view !== 'admin' && !me()) view = 'who';
  state.view = view;
  updateChrome();
  const y = window.scrollY;
  try {
    await VIEWS[view](opts);
  } catch (e) {
    if (e.status === 401) return showCode();
    main.innerHTML = `<div class="card"><h2>Niečo sa pokazilo</h2><p class="alert">${esc(e.message)}</p>
      <button class="kros-btn" id="retry">Skúsiť znova</button></div>`;
    $('#retry').onclick = () => go(view);
  }
  window.scrollTo(0, opts.keepScroll ? y : 0);
}

async function refreshBoot() { state.boot = await api('GET', '/api/bootstrap'); }

function hero(light, strong, sub) {
  return `<section class="hero">
    <h1><span class="kros-jemne">${light}</span><span class="kros-klucove">${strong}</span></h1>
    <div class="kros-ukazovatel" aria-hidden="true"></div>
    ${sub ? `<p>${sub}</p>` : ''}
  </section>`;
}

const VIEWS = {
  // --- výber mena ---
  async who() {
    main.innerHTML = `${hero('Spoločná objednávka', 'vajíčok', 'Vyber svoje meno. Prehliadač si ho zapamätá, heslo netreba.')}
      <div class="people">${state.boot.people.map((p) => `
        <button class="person" data-id="${p.id}" aria-pressed="${p.id === state.me}">
          <span class="user__avatar" aria-hidden="true">${esc(initials(p.name))}</span>
          <span>${esc(p.name)}${p.id === state.boot.supplierId ? '<br><span class="small muted">zabezpečovateľ</span>' : ''}</span>
        </button>`).join('')}</div>
      ${state.boot.people.length
        ? `<p class="small muted" style="margin-top:20px">Nie si v zozname? Pridá ťa ${esc(supplierName())}.</p>`
        : '<p class="alert">Zoznam je zatiaľ prázdny.</p><p><button class="kros-btn" data-go="admin">Pridať ľudí</button></p>'}`;
    main.querySelectorAll('[data-go]').forEach((a) => a.onclick = (e) => { e.preventDefault(); go('admin'); });
    main.querySelectorAll('.person').forEach((b) => b.onclick = () => {
      state.me = b.dataset.id; store.set(LS_ME, state.me); go('order');
    });
  },

  // --- objednávka ---
  async order() {
    const b = state.boot;
    const lastClosed = b.lastClosedId ? await api('GET', `/api/orders/${b.lastClosedId}`) : null;
    const myLast = lastClosed?.rows.find((r) => r.personId === state.me);
    const lastCard = myLast ? `<div class="card ${myLast.paid ? 'card--plocha' : ''}">
        <p class="kicker">Minulý týždeň · ${fmtShort(lastClosed.deliveryDate)}</p>
        <div class="total" style="border:0;margin:0;padding:0">
          <span>${myLast.qty} ks${myLast.orderedQty !== myLast.qty ? ` <span class="small muted">(objednané ${myLast.orderedQty}, farmár dodal menej)</span>` : ''}</span><strong>${eur(myLast.cents)}</strong>
        </div>
        <p class="small muted" style="margin:6px 0 14px">${myLast.refundCents > 0 ? `Zaplatil si viac – ${esc(supplierName())} ti vráti ${eur(myLast.refundCents)}.`
          : myLast.qty === 0 ? 'Na teba tento týždeň nezvýšilo, nič neplatíš.'
          : myLast.paid ? 'Zaplatené, ďakujeme.'
          : myLast.paidCents > 0 ? `Zaplatené ${eur(myLast.paidCents)}, doplatiť ${eur(myLast.dueCents)} – ${esc(supplierName())}`
          : `Zaplať: ${esc(supplierName())}`}</p>
        ${myLast.qty > 0 && !myLast.refundCents ? payToggle({ checked: myLast.paid, disabled: myLast.paid && !isSupplier(), label: myLast.paidCents > 0 && !myLast.paid ? 'Doplatil som' : 'Zaplatil som', data: 'id="paidLast"' }) : ''}
        ${myLast.paid && !myLast.refundCents ? '' : ` <span class="stav ${payStatus(myLast).cls}" style="margin-left:8px">${payStatus(myLast).text}</span>`}
      </div>` : '';

    if (!b.openOrderId) {
      main.innerHTML = `${hero('Objednávka', 'je zatvorená', `Nová sa otvorí ${b.nextOpensAt ? esc(fmtDeadline(b.nextOpensAt)) : 'čoskoro'}.`)}${lastCard}`;
      bindPaidLast(lastClosed);
      return;
    }
    if (!state.order || state.order.id !== b.openOrderId || !state.saveTimer) {
      state.order = await api('GET', `/api/orders/${b.openOrderId}`);
      const mine = state.order.rows.find((r) => r.personId === state.me);
      state.draft = mine ? mine.qty : 0;
    }
    const o = state.order;
    const mine = o.rows.find((r) => r.personId === state.me);
    const step = b.config.packSize;
    const quick = [1, 2, 3, 6].map((k) => k * step);

    main.innerHTML = `
      ${hero('Vajíčka na stredu', fmtDay(o.deliveryDate), `Uzávierka ${esc(fmtDeadline(o.deadline))} · zostáva <b id="cd">${countdown(o.deadline)}</b>`)}
      <div class="grid">
        <div class="card">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:10px">
            <h2>Moja objednávka</h2><span class="stav">otvorená</span>
          </div>
          <p class="small muted" style="margin:0">${eur(o.packPriceCents)} za ${o.packSize} ks · ${eur(Math.round(o.packPriceCents / o.packSize))} / ks</p>
          <div class="stepper">
            <button class="round" id="m10" aria-label="Ubrať ${step} kusov">−${step}</button>
            <div class="qty">
              <output id="qtyInput" class="qty__num" aria-live="polite" aria-label="Počet kusov">${state.draft}</output>
              <span class="qty__unit">kusov</span>
            </div>
            <button class="round" id="p10" aria-label="Pridať ${step} kusov">+${step}</button>
          </div>
          <div class="eggs" id="eggs" aria-hidden="true">${eggsHtml(state.draft)}</div>
          <div class="chips" role="group" aria-label="Rýchla voľba">${quick.map((q) =>
            `<button class="chip" data-q="${q}" aria-pressed="${q === state.draft}">${q} ks</button>`).join('')}
            <button class="chip" data-q="0" aria-pressed="false">nič</button></div>
          <div class="total"><span class="muted">Spolu</span><strong id="sum">${eur(cents(state.draft))}</strong></div>
          <div class="save" id="saveState">${saveStateHtml()}</div>
        </div>
        <div>
          <div class="card card--plocha" id="payCard">${payCardHtml(mine)}</div>
          <div class="card">
            <p class="kicker">Pripomienka</p>
            <p class="small muted" style="margin:0 0 14px">Ak si v pondelok ráno ešte nemáš objednané, označíme ťa v Teams chate „vajká na stredu“.</p>
            ${payToggle({ checked: me().remind, label: 'Pripomínať mi v pondelok', data: 'id="remindMe"' })}
          </div>
          ${lastCard}
        </div>
      </div>`;

    $('#m10').onclick = () => setQty(state.draft - step);
    $('#p10').onclick = () => setQty(state.draft + step);
    main.querySelectorAll('.chip').forEach((c) => c.onclick = () => setQty(+c.dataset.q));
    bindPayCard();
    updateLimits();
    $('#remindMe').onchange = (e) => api('PUT', `/api/people/${state.me}/remind`, { remind: e.target.checked, actorId: state.me })
      .then(refreshBoot).catch((er) => { alert(er.message); e.target.checked = !e.target.checked; });
    bindPaidLast(lastClosed);
  },

  // --- súhrn ---
  async summary() {
    const b = state.boot;
    const ids = [b.openOrderId, b.lastClosedId].filter(Boolean);
    if (!ids.length) { main.innerHTML = hero('Súhrn', 'objednávky', '') + '<p class="empty">Zatiaľ žiadna objednávka.</p>'; return; }
    if (!ids.includes(state.summaryId)) state.summaryId = ids[0];
    const o = await api('GET', `/api/orders/${state.summaryId}`);
    main.innerHTML = `
      ${hero('Súhrn objednávky', `streda ${fmtDay(o.deliveryDate)}`, o.status === 'open'
        ? `Uzávierka ${esc(fmtDeadline(o.deadline))} · zostáva <b>${countdown(o.deadline)}</b>`
        : 'Objednávka je uzavretá – množstvá sa už nedajú meniť, platby áno.')}
      ${ids.length > 1 ? `<div class="seg" role="group" aria-label="Týždeň">${ids.map((id) =>
        `<button data-id="${id}" aria-pressed="${id === o.id}">${id === b.openOrderId ? 'Otvorená' : 'Uzavretá'} · ${fmtShort(id)}</button>`).join('')}</div>` : ''}
      ${summaryHtml(o, true)}`;
    main.querySelectorAll('.seg button').forEach((btn) => btn.onclick = () => { state.summaryId = btn.dataset.id; go('summary'); });
    bindSummary(o);
  },

  // --- história ---
  async history() {
    if (state.histId) {
      const o = await api('GET', `/api/orders/${state.histId}`);
      main.innerHTML = `<button class="back" id="back">← Späť na históriu</button>
        ${hero('Streda', fmtDay(o.deliveryDate), 'Archív – len na čítanie.')}${summaryHtml(o, false)}`;
      $('#back').onclick = () => { state.histId = null; go('history'); };
      return;
    }
    const list = (await api('GET', '/api/orders')).filter((o) => o.status === 'closed');
    main.innerHTML = `${hero('História', 'objednávok', 'Predchádzajúce týždne. Klikni pre detail.')}
      ${list.length ? `<ul class="hist">${list.map((o) => `<li><button data-id="${o.id}">
        <span><span class="d">${fmtDay(o.deliveryDate)}</span><br><span class="small muted">${o.totalQty} ks · ${fmtPacks(o.packs)} bal. · ${eur(o.totalCents)}</span></span>
        ${o.unpaidCount ? `<span class="stav stav--pozor">nezaplatené ${o.unpaidCount}</span>` : '<span class="stav">zaplatené</span>'}
        <span class="chev" aria-hidden="true">→</span>
      </button></li>`).join('')}</ul>` : '<p class="empty">Zatiaľ žiadne uzavreté týždne.</p>'}`;
    main.querySelectorAll('.hist button').forEach((btn) => btn.onclick = () => { state.histId = btn.dataset.id; go('history'); });
  },

  // --- úprava podľa skutočnej dodávky (správca s PIN-om) ---
  async delivery() {
    const id = state.deliveryId;
    const o = await api('GET', `/api/orders/${id}`);
    const ps = o.packSize;
    const top = hero('Farmár dodal', 'menej vajíčok', `Streda ${fmtDay(o.deliveryDate)} · objednaných ${o.orderedQty} ks`);
    // prvý návrh: dodané z poslednej úpravy, inak o balenie menej ako objednané
    if (state.deliveredDraft == null) state.deliveredDraft = o.delivery ? o.delivery.deliveredQty : Math.max(0, o.orderedQty - ps);
    let prev;
    try { prev = await api('POST', `/api/orders/${id}/delivery/preview`, { delivered: state.deliveredDraft }); }
    catch (e) {
      if (e.status === 403) return pinForm(top + '<p class="muted">Úpravu podľa dodávky robí len správca.</p>', () => go('delivery'));
      if (e.status !== 400) throw e;
      state.deliveredDraft = o.orderedQty;
      prev = await api('POST', `/api/orders/${id}/delivery/preview`, { delivered: state.deliveredDraft });
    }
    if (!state.alloc) state.alloc = prev.rows.map((r) => ({ ...r }));

    const render = () => {
      const sum = state.alloc.reduce((t, r) => t + r.qty, 0);
      const left = state.deliveredDraft - sum;
      main.innerHTML = `<button class="back" id="back">← Späť na súhrn</button>${top}
        <div class="card">
          <p class="kicker">1 · Koľko farmár skutočne dodal</p>
          <div class="stepper" style="justify-content:flex-start">
            <button class="round" id="dm" aria-label="Ubrať ${ps} kusov" ${state.deliveredDraft <= 0 ? 'disabled' : ''}>−${ps}</button>
            <div class="qty"><output class="qty__num" id="dq">${state.deliveredDraft}</output><span class="qty__unit">z ${o.orderedQty} ks</span></div>
            <button class="round" id="dp" aria-label="Pridať ${ps} kusov" ${state.deliveredDraft >= o.orderedQty ? 'disabled' : ''}>+${ps}</button>
          </div>
          <p class="small muted" style="margin:0">Pri zmene dodaného množstva appka hneď navrhne nové rozdelenie.</p>
        </div>
        <div class="card">
          <p class="kicker">2 · Rozdelenie dookola po baleniach</p>
          <p class="small muted" style="margin:0 0 12px">Každý dostane v každom kole jedno balenie, kým sa neminú. V poslednom kole má prednosť, kto sa objednal skôr. Návrh môžeš ručne upraviť.</p>
          <table class="tbl">
            <thead><tr><th>Meno</th><th class="num">Objednal</th><th class="num">Dostane</th></tr></thead>
            <tbody>${state.alloc.map((r, i) => `<tr class="${r.qty < r.orderedQty ? 'unpaid' : 'paid'}">
              <td class="name"><b>${esc(r.name)}</b>${r.qty < r.orderedQty ? `<small>o ${r.orderedQty - r.qty} ks menej</small>` : ''}</td>
              <td class="num">${r.orderedQty}</td>
              <td class="num"><div class="paycell">
                <button class="chip" data-i="${i}" data-d="-1" ${r.qty <= 0 ? 'disabled' : ''} aria-label="Ubrať ${esc(r.name)}">−</button>
                <b style="min-width:2.4ch;text-align:right">${r.qty}</b>
                <button class="chip" data-i="${i}" data-d="1" ${r.qty >= r.orderedQty || left <= 0 ? 'disabled' : ''} aria-label="Pridať ${esc(r.name)}">+</button>
              </div></td></tr>`).join('')}</tbody>
            <tfoot><tr><td>Spolu</td><td class="num">${o.orderedQty}</td><td class="num">${sum}</td></tr></tfoot>
          </table>
          <p class="${left === 0 ? 'stav' : 'alert'}" style="display:inline-block;margin:14px 0 0">${left === 0 ? 'Rozdelené všetko ✓'
            : left > 0 ? `Zostáva rozdeliť ${left} ks` : `Rozdelených je o ${-left} ks viac, ako farmár dodal`}</p>
        </div>
        <div class="btn-row">
          <button class="kros-btn" id="confirm" ${left !== 0 ? 'disabled' : ''}>Potvrdiť a poslať do Teams</button>
          <button class="kros-btn kros-btn--obrys" id="reset">Obnoviť návrh</button>
        </div>
        <p class="small muted">Po potvrdení sa objednávky upravia, prepočítajú sa sumy a kto zaplatil viac, uvidí „vrátiť“. Do Teams chatu príde správa s označením tých, ktorým sa objednávka zmenila.</p>`;
      $('#back').onclick = () => { state.alloc = null; state.deliveredDraft = null; state.summaryId = id; go('summary'); };
      const change = async (d) => {
        state.deliveredDraft = Math.min(o.orderedQty, Math.max(0, state.deliveredDraft + d));
        const p = await api('POST', `/api/orders/${id}/delivery/preview`, { delivered: state.deliveredDraft });
        state.alloc = p.rows.map((r) => ({ ...r }));
        render();
      };
      $('#dm').onclick = () => change(-ps);
      $('#dp').onclick = () => change(ps);
      $('#reset').onclick = () => { state.alloc = prev.rows.map((r) => ({ ...r })); change(0); };
      main.querySelectorAll('.chip[data-i]').forEach((b) => b.onclick = () => {
        const r = state.alloc[+b.dataset.i];
        r.qty = Math.min(r.orderedQty, Math.max(0, r.qty + ps * +b.dataset.d));
        render();
      });
      $('#confirm').onclick = async (e) => {
        if (!confirm(`Upraviť objednávky na ${state.deliveredDraft} ks a poslať správu do Teams?`)) return;
        e.target.disabled = true;
        try {
          await api('POST', `/api/orders/${id}/delivery`, { delivered: state.deliveredDraft, alloc: state.alloc.map((r) => ({ personId: r.personId, qty: r.qty })) });
          state.alloc = null; state.deliveredDraft = null; state.summaryId = id;
          go('summary');
        } catch (er) { alert(er.message); e.target.disabled = false; }
      };
    };
    render();
  },

  // --- správa ľudí ---
  async admin() {
    let data;
    try { data = await api('GET', '/api/admin/people'); }
    catch (e) {
      if (e.status !== 403) throw e;
      return pinForm(hero('Správa', 'ľudí', 'Táto časť je chránená PIN-om.'), () => go('admin'));
    }
    main.innerHTML = `${hero('Správa', 'ľudí', 'Pridaj alebo odober ľudí a urč zabezpečovateľa. E-mail slúži na označenie (@mention) v Teams.')}
      <div class="card">
        ${data.people.map((p) => `<div class="adm" data-id="${p.id}">
          <input class="kros-vstup name" type="text" value="${esc(p.name)}" aria-label="Meno">
          <input class="kros-vstup email" type="email" value="${esc(p.email)}" placeholder="e-mail v Teams" aria-label="E-mail ${esc(p.name)}">
          <label class="sup"><input type="radio" name="sup" ${p.id === data.supplierId ? 'checked' : ''}> zabezpečuje</label>
          <button class="icon-btn del" type="button" ${p.id === data.supplierId ? 'disabled' : ''} aria-label="Odobrať ${esc(p.name)}">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
        </div>`).join('')}
        <form class="addrow" id="addf">
          <input class="kros-vstup" type="text" id="nn" placeholder="Meno a priezvisko" aria-label="Nové meno" required>
          <input class="kros-vstup" type="email" id="ne" placeholder="e-mail v Teams (kvôli označeniu)" aria-label="E-mail">
          <button class="kros-btn">Pridať</button>
        </form>
        <div class="msg" id="amsg" role="status"></div>
        <details style="margin-top:12px">
          <summary class="small" style="cursor:pointer;font-weight:500">Hromadne pridať viac ľudí</summary>
          <form id="bulkf" style="margin-top:10px">
            <label class="small muted" for="bulk">Každý na nový riadok: <i>Meno Priezvisko; email</i> (e-mail je nepovinný)</label>
            <textarea class="kros-vstup" id="bulk" rows="6" style="border-radius:16px;margin:8px 0;resize:vertical" placeholder="Meno Priezvisko; meno@firma.sk"></textarea>
            <button class="kros-btn">Pridať všetkých</button>
          </form>
        </details>
      </div>
      ${reminderCard(data.reminder)}
      ${me() ? '' : '<p style="margin-top:20px"><button class="kros-btn kros-btn--obrys" id="toWho">Hotovo – vybrať svoje meno</button></p>'}`;
    if ($('#toWho')) $('#toWho').onclick = () => go('who');
    if ($('#remindNow')) $('#remindNow').onclick = async (e) => {
      if (!confirm('Poslať pripomienku do Teams kanála teraz?')) return;
      e.target.disabled = true;
      try { await api('POST', '/api/reminder'); await go('admin', { keepScroll: true }); msg('Pripomienka odoslaná'); }
      catch (er) { e.target.disabled = false; msg(er.message, true); }
    };
    const msg = (t, bad) => { const m = $('#amsg'); m.innerHTML = t ? `<span class="${bad ? 'alert' : 'stav'}" style="display:inline-block">${esc(t)}</span>` : ''; };
    const after = async (t) => { await refreshBoot(); await go('admin', { keepScroll: true }); msg(t); };
    main.querySelectorAll('.adm').forEach((row) => {
      const id = row.dataset.id;
      const upd = (body, t) => api('PUT', `/api/admin/people/${id}`, body).then(() => after(t)).catch((e) => msg(e.message, true));
      $('.name', row).onchange = (e) => upd({ name: e.target.value }, 'Meno uložené');
      $('.email', row).onchange = (e) => upd({ email: e.target.value }, 'E-mail uložený');
      $('input[type=radio]', row).onchange = () => upd({ supplier: true }, 'Zabezpečovateľ zmenený');
      $('.del', row).onclick = () => {
        if (!confirm(`Odobrať ${$('.name', row).value} zo zoznamu? História ostane zachovaná.`)) return;
        api('DELETE', `/api/admin/people/${id}`).then(() => after('Odobraté')).catch((e) => msg(e.message, true));
      };
    });
    $('#bulkf').onsubmit = (ev) => {
      ev.preventDefault();
      api('POST', '/api/admin/people/bulk', { text: $('#bulk').value })
        .then((r) => after(`Pridaných: ${r.added}${r.skipped ? `, už v zozname: ${r.skipped}` : ''}`)).catch((e) => msg(e.message, true));
    };
    $('#addf').onsubmit = (ev) => {
      ev.preventDefault();
      api('POST', '/api/admin/people', { name: $('#nn').value, email: $('#ne').value }).then(() => after('Pridané')).catch((e) => msg(e.message, true));
    };
  },
};

// ---------- pripomienka ----------

function reminderCard(r) {
  if (!r) return '';
  const when = (iso) => tzFmt({ weekday: 'long', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
  const status = !r.enabled ? 'Pripomienky sú vypnuté v konfigurácii.'
    : r.sentAt ? `Tento týždeň odoslaná: ${esc(when(r.sentAt))}.`
    : r.nextAt ? `Najbližšia: ${esc(when(r.nextAt))}.` : 'Žiadna otvorená objednávka.';
  return `<div class="card card--plocha teams" style="margin-top:20px">
    <div><b style="font-weight:600">Pondelková pripomienka v Teams</b><br>
      <span class="small muted">${status} Označí tých, ktorí ešte nemajú objednané a pripomienky si nevypli.</span></div>
    ${r.enabled ? '<button class="kros-btn kros-btn--obrys" id="remindNow">Poslať teraz</button>' : ''}
    ${r.error ? `<p class="alert" style="width:100%;margin:0">Chyba: ${esc(r.error)}</p>` : ''}
  </div>`;
}

// PIN pre správcu (správa ľudí, úprava dodávky)
function pinForm(top, done) {
  main.innerHTML = `${top}
    <form class="card" id="pinf" style="max-width:420px">
      <label class="kicker" for="pin">Servisný PIN</label>
      <div class="btn-row"><input class="kros-vstup" type="password" id="pin" autocomplete="off" style="flex:1">
      <button class="kros-btn">Pokračovať</button></div>
      ${state.adminPin ? '<p class="alert" style="margin:12px 0 0">Nesprávny PIN.</p>' : ''}
    </form>`;
  $('#pin').focus();
  $('#pinf').onsubmit = (ev) => { ev.preventDefault(); state.adminPin = $('#pin').value; store.set(LS_PIN, state.adminPin); done(); };
}

// ---------- platba v objednávke ----------

function payCardHtml(mine) {
  const head = `<p class="kicker">Platba</p>
    <p style="margin:0 0 14px">Vajíčka zabezpečuje <b>${esc(supplierName())}</b>. Platí sa len v hotovosti.</p>`;
  if (!mine) return head + '<p class="small muted" style="margin:0">Platbu označíš, keď si niečo objednáš.</p>';
  const partial = !mine.paid && mine.paidCents > 0;
  return head + `
    ${partial ? `<p class="alert" style="margin:0 0 14px">Zaplatené ${eur(mine.paidCents)}, po navýšení doplatiť <b>${eur(mine.dueCents)}</b>.</p>` : ''}
    ${payToggle({ checked: mine.paid, disabled: mine.paid && !isSupplier(), label: partial ? 'Doplatil som' : 'Za tento týždeň už mám zaplatené', data: 'id="paidNow"' })}
    ${mine.paidCents > 0 ? `<p class="small muted" style="margin:10px 0 0">Zaplatené vajíčka (${paidQty(mine)} ks) už nemôžeš odobrať, len pridať.</p>` : ''}`;
}
function bindPayCard() {
  const cb = $('#paidNow');
  if (cb) cb.onchange = (e) => markPaid(state.order.id, state.me, e.target.checked)
    .then(() => { state.order = null; }).catch((er) => alert(er.message)).then(() => go('order', { keepScroll: true }));
}
// Zaplatené kusy sa nedajú odobrať: zablokuje −10 a nižšie voľby
function updateLimits() {
  const min = paidQty(state.order?.rows.find((r) => r.personId === state.me));
  const m10 = $('#m10');
  if (!m10) return;
  m10.disabled = state.draft - state.boot.config.packSize < min;
  main.querySelectorAll('.chip').forEach((c) => { c.disabled = +c.dataset.q < min; });
}

// ---------- súhrn ----------

function summaryHtml(o, interactive) {
  const sup = isSupplier();
  const canPay = interactive && o.editablePayments;
  const whole = Number.isInteger(o.packs);
  const missing = whole ? 0 : o.packSize - (o.totalQty % o.packSize);
  if (!o.rows.length) return '<div class="card"><p class="empty">Zatiaľ si nikto nič neobjednal.</p></div>';
  const rows = o.rows.map((r) => {
    const mine = r.personId === state.me;
    const by = r.paid && r.paidByName && r.paidByName !== r.name ? `označil ${r.paidByName}` : '';
    return `<tr class="${r.paid ? 'paid' : 'unpaid'} ${mine ? 'me' : ''}">
      <td class="name"><b>${esc(r.name)}</b>${r.personId === state.boot.supplierId ? '<small>zabezpečovateľ</small>' : ''}${mine ? '<small>to si ty</small>' : ''}</td>
      <td class="num">${r.qty}${r.orderedQty !== r.qty ? `<small class="muted" style="display:block">z ${r.orderedQty}</small>` : ''}</td>
      <td class="num">${eur(r.cents)}${!r.paid && r.paidCents > 0 ? `<small class="muted" style="display:block">doplatiť ${eur(r.dueCents)}</small>` : ''}</td>
      <td><div class="paycell">
        <span class="stav ${payStatus(r).cls} hide-m" title="${esc(by)}">${payStatus(r).text}</span>
        ${r.refundCents > 0 && sup && canPay ? `<button class="chip" data-refund="${r.personId}" title="Peniaze som vrátila">Vrátené</button>`
          : r.qty === 0 || r.refundCents > 0 ? ''
          : payToggle({ checked: r.paid, disabled: !(canPay && (mine || sup)) || (r.paid && !sup), label: mine ? 'Zaplatil som' : `Zaplatil ${r.name}`, data: `data-pid="${r.personId}"` }).replace('<span class="pay__label">', '<span class="pay__label sr">')}
      </div></td>
    </tr>`;
  }).join('');
  const delivery = o.status !== 'closed' ? '' : o.delivery ? `<div class="card card--plocha teams" style="margin-bottom:20px">
      <div><b style="font-weight:600">Upravené podľa skutočnej dodávky</b><br>
        <span class="small muted">Farmár dodal ${o.delivery.deliveredQty} z ${o.orderedQty} objednaných ks.${o.refundCents > 0 ? ` Vrátiť spolu ${eur(o.refundCents)}.` : ''}</span></div>
      ${interactive ? '<button class="kros-btn kros-btn--obrys" id="deliveryBtn">Upraviť znova</button>' : ''}
      ${o.delivery.error ? `<p class="alert" style="width:100%;margin:0">Teams: ${esc(o.delivery.error)}</p>` : ''}
    </div>` : interactive ? `<div class="card teams" style="margin-bottom:20px">
      <div><b style="font-weight:600">Farmár dodal menej?</b><br>
        <span class="small muted">Správca zadá skutočné množstvo a appka ho rozdelí dookola po baleniach.</span></div>
      <button class="kros-btn kros-btn--obrys" id="deliveryBtn">Upraviť podľa dodávky</button>
    </div>` : '';
  const teams = o.status === 'closed' ? `<div class="card card--plocha teams">
      <div style="display:flex;gap:14px;align-items:center">
        <span class="teams__ico" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 5h16v11H9l-5 4z"/></svg></span>
        <div><b style="font-weight:600">Správa do Teams</b><br>
          <span class="small muted">${o.teams.sentAt ? `Odoslané ${esc(tzFmt({ day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(o.teams.sentAt)))} pre ${esc(supplierName())}` : 'Zatiaľ neodoslané'}</span>
        </div>
      </div>
      ${interactive ? '<button class="kros-btn kros-btn--obrys" id="teamsBtn">Poslať súhrn do Teams znova</button>' : ''}
      ${o.teams.error ? `<p class="alert" style="width:100%;margin:0">Chyba: ${esc(o.teams.error)}</p>` : ''}
    </div>` : '';
  return `
    ${delivery}
    <div class="stats">
      <div class="stat"><span>Spolu</span><b>${o.totalQty} ks</b><small>${o.rows.length} ľudí</small></div>
      <div class="stat"><span>Balení po ${o.packSize} ks</span><b>${fmtPacks(o.packs)}</b><small>${whole ? 'celé balenia' : `do celého chýba ${missing} ks`}</small></div>
      <div class="stat"><span>Celková suma</span><b>${eur(o.totalCents)}</b><small>${eur(o.packPriceCents)} / ${o.packSize} ks</small></div>
      <div class="stat ${o.unpaidCount ? 'stat--pozor' : ''}"><span>Nezaplatené</span><b>${eur(o.unpaidCents)}</b><small>${o.unpaidCount ? `${o.unpaidCount} z ${o.rows.length} ľudí` : 'všetci zaplatili'}</small></div>
    </div>
    <div class="card">
      <table class="tbl">
        <thead><tr><th>Meno</th><th class="num">Ks</th><th class="num">Suma</th><th class="num">Zaplatené</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr><td>Spolu</td><td class="num">${o.totalQty}${o.orderedQty !== o.totalQty ? `<small class="muted" style="display:block">z ${o.orderedQty}</small>` : ''}</td><td class="num">${eur(o.totalCents)}</td><td></td></tr></tfoot>
      </table>
      <p class="small muted" style="margin:14px 0 0">${!interactive || !o.editablePayments ? 'Len na čítanie.'
        : sup ? 'Si zabezpečovateľ – platbu môžeš označiť za hocikoho.' : `Platbu si označ pri svojom mene. Platí sa: ${esc(supplierName())}.`}</p>
    </div>
    ${teams ? `<div style="margin-top:20px">${teams}</div>` : ''}`;
}

function bindSummary(o) {
  main.querySelectorAll('.tbl input[type=checkbox]').forEach((cb) => cb.onchange = async () => {
    try { await markPaid(o.id, cb.dataset.pid, cb.checked); } catch (e) { alert(e.message); }
    go('summary', { keepScroll: true });
  });
  const db = $('#deliveryBtn');
  if (db) db.onclick = () => { state.deliveryId = o.id; state.alloc = null; state.deliveredDraft = null; go('delivery'); };
  main.querySelectorAll('[data-refund]').forEach((b) => b.onclick = async () => {
    if (!confirm('Peniaze sú vrátené?')) return;
    try { await markPaid(o.id, b.dataset.refund, true); } catch (e) { alert(e.message); }
    go('summary', { keepScroll: true });
  });
  const tb = $('#teamsBtn');
  if (tb) tb.onclick = async () => {
    if (!state.boot.teamsConfigured && !confirm('TEAMS_WEBHOOK_URL nie je nastavená. Skúsiť aj tak?')) return;
    tb.disabled = true; tb.textContent = 'Posielam…';
    try { await api('POST', `/api/orders/${o.id}/teams`); } catch { /* chyba sa zobrazí v súhrne */ }
    go('summary', { keepScroll: true });
  };
}

function markPaid(orderId, pid, paid) {
  return api('PUT', `/api/orders/${orderId}/entries/${pid}/paid`, { paid, actorId: state.me });
}
function bindPaidLast(lastClosed) {
  const cb = $('#paidLast');
  if (cb) cb.onchange = () => markPaid(lastClosed.id, state.me, cb.checked)
    .catch((e) => alert(e.message)).then(() => go('order', { keepScroll: true }));
}

// ---------- množstvo ----------

function eggsHtml(n) {
  const step = state.boot.config.packSize;
  const full = Math.min(30, Math.floor(n / step));
  const part = n % step && full < 30 ? '<i class="half"></i>' : '';
  return '<i></i>'.repeat(full) + part;
}
function saveStateHtml() {
  return { saving: 'Ukladám…', saved: '<span class="save--ok">Uložené</span>', error: `<span class="alert">${esc(state.saveError || 'Chyba')}</span>` }[state.saveState] || '&nbsp;';
}
// množstvo len v násobkoch balenia
function setQty(n) {
  const step = state.boot.config.packSize;
  n = Math.max(0, Math.min(1000, Math.round(n / step) * step));
  const min = paidQty(state.order?.rows.find((r) => r.personId === state.me));
  if (n < min) {
    state.saveState = 'error'; state.saveError = `Zaplatené vajíčka (${min} ks) sa nedajú odobrať.`;
    $('#saveState').innerHTML = saveStateHtml();
    return;
  }
  if (n === state.draft) return;
  state.draft = n;
  $('#sum').textContent = eur(cents(n));
  $('#eggs').innerHTML = eggsHtml(n);
  $('#qtyInput').textContent = n;
  main.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', String(+c.dataset.q === n && n > 0)));
  updateLimits();
  state.saveState = 'saving'; $('#saveState').innerHTML = saveStateHtml();
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(saveQty, 600);
}
async function saveQty() {
  try {
    state.order = await api('PUT', `/api/orders/${state.order.id}/entries/${state.me}`, { qty: state.draft });
    state.saveState = 'saved';
    // po navýšení zaplatenej objednávky ukáž doplatok
    const card = $('#payCard');
    if (card) { card.innerHTML = payCardHtml(state.order.rows.find((r) => r.personId === state.me)); bindPayCard(); }
  } catch (e) {
    state.saveState = 'error'; state.saveError = e.message;
    if (e.status === 409) { await refreshBoot(); state.saveTimer = null; return go('order'); }
  }
  state.saveTimer = null;
  const el = $('#saveState'); if (el) el.innerHTML = saveStateHtml();
}

// ---------- štart ----------

// Obrazovka na zadanie kódu skupiny (pri prvej návšteve alebo po zmene kódu)
function showCode() {
  state.boot = null;
  updateChrome();
  main.innerHTML = `${hero('Spoločná objednávka', 'vajíčok', 'Zadaj kód skupiny. Nájdeš ho v Teams chate „vajká na stredu“.')}
    <form class="card" id="codef" style="max-width:420px">
      <label class="kicker" for="code">Kód skupiny</label>
      <div class="btn-row"><input class="kros-vstup" id="code" autocomplete="off" autocapitalize="characters" style="flex:1" value="${esc(state.code)}">
      <button class="kros-btn">Pokračovať</button></div>
      ${state.code ? '<p class="alert" style="margin:12px 0 0">Tento kód nesedí, skús to znova.</p>' : ''}
    </form>`;
  $('#code').focus();
  $('#codef').onsubmit = async (ev) => {
    ev.preventDefault();
    state.code = $('#code').value.trim();
    store.set(LS_CODE, state.code);
    start();
  };
}

let refreshTimer = null;
async function start() {
  try { await refreshBoot(); }
  catch (e) {
    if (e.status === 401) return showCode();
    main.innerHTML = `<div class="card"><h2>Databáza nie je dostupná</h2><p class="alert">${esc(e.message)}</p></div>`;
    return;
  }
  if (state.me && !me()) { state.me = null; store.set(LS_ME, null); }
  go(me() ? 'order' : 'who');

  if (refreshTimer) return;
  refreshTimer = setInterval(async () => {
    if (!state.boot) return;
    const cd = $('#cd');
    if (cd && state.order) cd.textContent = countdown(state.order.deadline);
    const prevOpen = state.boot.openOrderId;
    try { await refreshBoot(); } catch { return; }
    const busy = document.activeElement && document.activeElement.matches('input');
    if (state.boot.openOrderId !== prevOpen && !state.saveTimer) { state.order = null; go(state.view, { keepScroll: true }); }
    else if (state.view === 'summary' && !busy) go('summary', { keepScroll: true });
  }, 30_000);
}
start();
