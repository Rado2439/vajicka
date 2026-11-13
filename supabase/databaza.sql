-- =====================================================================
-- Vajíčka – databáza pre Supabase (PostgreSQL)
--
-- Spusti celý súbor v Supabase → SQL Editor → Run. Dá sa spustiť aj
-- opakovane (napr. po aktualizácii) – dáta ostanú zachované.
--
-- Bezpečnosť: tabuľky sú v schéme „vajicka“, ktorú Supabase API
-- nesprístupňuje. Stránka volá len funkcie vj_* a každá overí kód skupiny.
-- Adresa Teams webhooku ostáva v databáze, stránka ju nikdy nevidí.
-- =====================================================================

-- Rozšírenia: pg_net (HTTP volania do Teams) a pg_cron (plánovač).
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_net;
  end if;
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
  end if;
end $$;

create schema if not exists vajicka;
revoke all on schema vajicka from public;

-- ---------- Tabuľky ----------

create table if not exists vajicka.settings (
  id                    int primary key default 1 check (id = 1),
  group_code            text not null,                    -- kód skupiny (zdieľa sa v Teams chate)
  admin_pin             text,                             -- prázdne = správa ľudí bez PIN-u
  pack_size             int  not null default 10,
  pack_price_cents      int  not null default 300,        -- 3,00 € za balenie
  currency              text not null default '€',
  timezone              text not null default 'Europe/Bratislava',
  delivery_weekday      int  not null default 3,          -- 0 = nedeľa … 3 = streda
  deadline_days_before  int  not null default 1,          -- utorok
  deadline_time         time not null default '20:00',
  open_next_on          text not null default 'deadline' check (open_next_on in ('deadline', 'delivery')),
  reminder_enabled      bool not null default true,
  reminder_days_before  int  not null default 2,          -- pondelok
  reminder_time         time not null default '08:00',
  default_qty           int  not null default 10,
  auto_send_within_days int  not null default 3,
  supplier_id           uuid,
  teams_webhook_url     text,                             -- Teams Workflows webhook
  app_url               text                              -- adresa appky (tlačidlo v Teams správe)
);

insert into vajicka.settings (id, group_code)
values (1, upper(substr(md5(random()::text || clock_timestamp()::text), 1, 6)))
on conflict (id) do nothing;

create table if not exists vajicka.people (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  email      text not null default '',
  active     bool not null default true,
  remind     bool not null default true,
  created_at timestamptz not null default now()
);

create table if not exists vajicka.orders (
  delivery_date       date primary key,
  deadline            timestamptz not null,
  pack_size           int not null,
  pack_price_cents    int not null,                       -- cena v čase objednávky (história sa nemení)
  teams_sent_at       timestamptz,
  teams_request_id    bigint,
  teams_error         text,
  teams_attempts      int not null default 0,
  reminder_sent_at    timestamptz,
  reminder_request_id bigint,
  reminder_error      text,
  reminder_attempts   int not null default 0
);

create table if not exists vajicka.entries (
  delivery_date date not null references vajicka.orders on delete cascade,
  person_id     uuid not null references vajicka.people,
  qty           int  not null check (qty between 0 and 1000),
  paid          bool not null default false,
  paid_at       timestamptz,
  paid_by       uuid references vajicka.people,
  updated_at    timestamptz not null default now(),
  primary key (delivery_date, person_id)
);

-- koľko kto zaplatil (pri navýšení po zaplatení sa dopočíta rozdiel)
alter table vajicka.entries add column if not exists paid_cents int not null default 0;
update vajicka.entries e set paid_cents = round(e.qty * o.pack_price_cents::numeric / o.pack_size)
from vajicka.orders o where o.delivery_date = e.delivery_date and e.paid and e.paid_cents = 0;

-- úprava podľa skutočnej dodávky: pôvodná objednávka a poradie objednania
alter table vajicka.entries add column if not exists qty_ordered int;      -- null = neupravené
alter table vajicka.entries add column if not exists created_at timestamptz;
update vajicka.entries set created_at = updated_at where created_at is null;
alter table vajicka.entries alter column created_at set default now();
alter table vajicka.orders add column if not exists delivered_qty int;
alter table vajicka.orders add column if not exists delivery_adjusted_at timestamptz;
alter table vajicka.orders add column if not exists delivery_request_id bigint;
alter table vajicka.orders add column if not exists delivery_error text;

alter table vajicka.settings enable row level security;
alter table vajicka.people   enable row level security;
alter table vajicka.orders   enable row level security;
alter table vajicka.entries  enable row level security;

-- ---------- Pomocné funkcie ----------

-- Aktuálny čas; testy ho posúvajú cez set_config('vajicka.now', …)
create or replace function vajicka.cas() returns timestamptz
language sql stable as $$
  select coalesce(nullif(current_setting('vajicka.now', true), '')::timestamptz, now())
$$;

create or replace function vajicka.cfg() returns vajicka.settings
language sql stable as $$ select * from vajicka.settings where id = 1 $$;

-- Chyba s HTTP stavom v „hint“ (stránka podľa neho rozlišuje 401/403/409…)
create or replace function vajicka.fail(p_status int, p_msg text) returns void
language plpgsql as $$
begin
  raise exception using message = p_msg, hint = p_status::text;
end $$;

create or replace function vajicka.auth(p_code text) returns void
language plpgsql stable as $$
begin
  if p_code is null or upper(trim(p_code)) <> upper((vajicka.cfg()).group_code) then
    perform vajicka.fail(401, 'Nesprávny kód skupiny');
  end if;
end $$;

create or replace function vajicka.admin(p_pin text) returns void
language plpgsql stable as $$
declare pin text := coalesce((vajicka.cfg()).admin_pin, '');
begin
  if pin <> '' and coalesce(p_pin, '') <> pin then
    perform vajicka.fail(403, 'Nesprávny PIN');
  end if;
end $$;

-- ---------- Čas: uzávierka, otvorenie, pripomienka ----------

create or replace function vajicka.deadline_for(d date) returns timestamptz
language sql stable as $$
  select ((d - s.deadline_days_before) + s.deadline_time) at time zone s.timezone from vajicka.settings s where id = 1
$$;

create or replace function vajicka.opens_at(d date) returns timestamptz
language sql stable as $$
  select case when s.open_next_on = 'delivery'
              then (d - 7)::timestamp at time zone s.timezone
              else vajicka.deadline_for(d - 7) end
  from vajicka.settings s where id = 1
$$;

create or replace function vajicka.reminder_at(d date) returns timestamptz
language sql stable as $$
  select ((d - s.reminder_days_before) + s.reminder_time) at time zone s.timezone from vajicka.settings s where id = 1
$$;

-- Najbližšie dni dodania od minulého týždňa
create or replace function vajicka.candidates(p_now timestamptz) returns setof date
language sql stable as $$
  with t as (select (p_now at time zone s.timezone)::date as d, s.delivery_weekday as wd from vajicka.settings s where id = 1)
  select t.d + ((t.wd - extract(dow from t.d)::int + 7) % 7) - 7 + 7 * i from t, generate_series(0, 3) i
$$;

-- Dodanie, na ktoré je práve otvorená objednávka (alebo null)
create or replace function vajicka.open_delivery(p_now timestamptz default vajicka.cas()) returns date
language sql stable as $$
  select k from vajicka.candidates(p_now) k
  where p_now < vajicka.deadline_for(k) and p_now >= vajicka.opens_at(k)
  order by k limit 1
$$;

create or replace function vajicka.ensure_order(k date) returns void
language sql as $$
  insert into vajicka.orders (delivery_date, deadline, pack_size, pack_price_cents)
  select k, vajicka.deadline_for(k), s.pack_size, s.pack_price_cents from vajicka.settings s where id = 1
  on conflict (delivery_date) do nothing
$$;

create or replace function vajicka.is_open(k date) returns bool
language sql stable as $$
  select exists (select 1 from vajicka.orders where delivery_date = k and vajicka.cas() < deadline)
$$;

create or replace function vajicka.last_closed() returns date
language sql stable as $$
  select max(o.delivery_date) from vajicka.orders o
  where vajicka.cas() >= o.deadline
    and exists (select 1 from vajicka.entries e where e.delivery_date = o.delivery_date and e.qty > 0)
$$;

-- ---------- Formátovanie ----------

create or replace function vajicka.eur(c bigint) returns text
language sql stable as $$
  select replace(to_char(c / 100.0, 'FM9999990.00'), '.', ',') || ' ' || (vajicka.cfg()).currency
$$;

create or replace function vajicka.fdate(d date) returns text
language sql immutable as $$
  select extract(day from d)::int || '. ' || extract(month from d)::int || '. ' || extract(year from d)::int
$$;

create or replace function vajicka.fdeadline(ts timestamptz) returns text
language sql stable as $$
  with l as (select ts at time zone (vajicka.cfg()).timezone as t)
  select (array['nedeľa','pondelok','utorok','streda','štvrtok','piatok','sobota'])[extract(dow from t)::int + 1]
         || ' ' || extract(day from t)::int || '. ' || extract(month from t)::int || '. o ' || to_char(t, 'HH24:MI')
  from l
$$;

-- ---------- Súhrn objednávky ----------

create or replace function vajicka.summary(k date) returns jsonb
language plpgsql stable as $$
declare
  o vajicka.orders;
  rows jsonb;
  tq int; tc bigint; uc int; ucents bigint; n int; oq int; rc bigint;
  lc date := vajicka.last_closed();
begin
  select * into o from vajicka.orders where delivery_date = k;
  if not found then return null; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'personId', x.person_id, 'name', x.name, 'qty', x.qty, 'cents', x.cents,
           'paid', x.due = 0 and x.qty > 0, 'paidCents', x.paid_cents, 'dueCents', x.due,
           'orderedQty', x.ordered, 'refundCents', x.refund,
           'paidAt', x.paid_at, 'paidByName', coalesce(x.paid_by_name, ''))
           order by x.name collate "und-x-icu"), '[]'::jsonb),
         coalesce(sum(x.qty), 0), coalesce(sum(x.cents), 0),
         count(*) filter (where x.due > 0), coalesce(sum(x.due), 0), count(*) filter (where x.qty > 0),
         coalesce(sum(x.ordered), 0), coalesce(sum(x.refund), 0)
    into rows, tq, tc, uc, ucents, n, oq, rc
  from (
    select y.*, greatest(y.cents - y.paid_cents, 0) as due, greatest(y.paid_cents - y.cents, 0) as refund from (
    select e.person_id, p.name, e.qty, coalesce(e.qty_ordered, e.qty) as ordered,
           e.paid_cents, e.paid_at, pb.name as paid_by_name,
           round(e.qty * o.pack_price_cents::numeric / o.pack_size)::bigint as cents
    from vajicka.entries e
    join vajicka.people p on p.id = e.person_id
    left join vajicka.people pb on pb.id = e.paid_by
    where e.delivery_date = k and coalesce(e.qty_ordered, e.qty) > 0
  ) y) x;

  return jsonb_build_object(
    'id', k, 'deliveryDate', k, 'deadline', o.deadline,
    'status', case when vajicka.cas() < o.deadline then 'open' else 'closed' end,
    'editablePayments', vajicka.cas() < o.deadline or k = lc,
    'packSize', o.pack_size, 'packPriceCents', o.pack_price_cents,
    'rows', rows, 'totalQty', tq, 'totalCents', tc,
    'packs', round(tq::numeric / o.pack_size, 2),
    'unpaidCount', uc, 'unpaidCents', ucents, 'peopleCount', n,
    'orderedQty', oq, 'refundCents', rc,
    'delivery', case when o.delivery_adjusted_at is not null then jsonb_build_object(
      'deliveredQty', o.delivered_qty, 'adjustedAt', o.delivery_adjusted_at, 'error', o.delivery_error) end,
    'teams', jsonb_build_object('sentAt', o.teams_sent_at, 'error', o.teams_error)
  );
end $$;

-- ---------- Teams ----------

create or replace function vajicka.wrap_card(body jsonb, entities jsonb, action_title text) returns jsonb
language plpgsql stable as $$
declare
  s vajicka.settings := vajicka.cfg();
  card jsonb;
begin
  card := jsonb_build_object(
    '$schema', 'http://adaptivecards.io/schemas/adaptive-card.json',
    'type', 'AdaptiveCard', 'version', '1.4', 'body', body,
    'msteams', jsonb_build_object('width', 'Full')
      || case when jsonb_array_length(entities) > 0 then jsonb_build_object('entities', entities) else '{}'::jsonb end);
  if coalesce(s.app_url, '') <> '' then
    card := card || jsonb_build_object('actions', jsonb_build_array(jsonb_build_object(
      'type', 'Action.OpenUrl', 'title', action_title,
      'url', s.app_url || '#kod=' || s.group_code)));
  end if;
  return jsonb_build_object('type', 'message', 'attachments', jsonb_build_array(jsonb_build_object(
    'contentType', 'application/vnd.microsoft.card.adaptive', 'contentUrl', null, 'content', card)));
end $$;

-- Súhrn po uzávierke pre zabezpečovateľa
create or replace function vajicka.summary_payload(k date) returns jsonb
language plpgsql stable as $$
declare
  s vajicka.settings := vajicka.cfg();
  sm jsonb := vajicka.summary(k);
  sup vajicka.people;
  entities jsonb := '[]'::jsonb;
  greeting text;
  facts jsonb;
  body jsonb;
  tq int := (sm->>'totalQty')::int;
  ps int := (sm->>'packSize')::int;
  packs text;
begin
  select * into sup from vajicka.people where id = s.supplier_id;
  if sup.id is not null and sup.email <> '' then
    greeting := '<at>' || sup.name || '</at>, tu je objednávka vajíčok na stredu ' || vajicka.fdate(k) || ':';
    entities := jsonb_build_array(jsonb_build_object('type', 'mention', 'text', '<at>' || sup.name || '</at>',
      'mentioned', jsonb_build_object('id', sup.email, 'name', sup.name)));
  elsif sup.id is not null then
    greeting := '**' || sup.name || '**, tu je objednávka vajíčok na stredu ' || vajicka.fdate(k) || ':';
  else
    greeting := 'Tu je objednávka vajíčok na stredu ' || vajicka.fdate(k) || ':';
  end if;

  body := jsonb_build_array(
    jsonb_build_object('type', 'TextBlock', 'size', 'Large', 'weight', 'Bolder', 'text', '🥚 Objednávka vajíčok – ' || vajicka.fdate(k)),
    jsonb_build_object('type', 'TextBlock', 'wrap', true, 'text', greeting));

  if jsonb_array_length(sm->'rows') > 0 then
    select jsonb_agg(jsonb_build_object('title', r->>'name',
             'value', (r->>'qty') || ' ks'
                      || case when (r->>'orderedQty')::int <> (r->>'qty')::int then ' (objednané ' || (r->>'orderedQty') || ')' else '' end
                      || ' – ' || vajicka.eur((r->>'cents')::bigint)
                      || case when (r->>'paid')::bool then ' ✅'
                              when (r->>'paidCents')::int > 0 then ' (doplatiť ' || vajicka.eur((r->>'dueCents')::bigint) || ')'
                              else '' end))
      into facts from jsonb_array_elements(sm->'rows') r;
    body := body || jsonb_build_array(jsonb_build_object('type', 'FactSet', 'facts', facts));
  else
    body := body || jsonb_build_array(jsonb_build_object('type', 'TextBlock', 'wrap', true, 'text', 'Tento týždeň si nikto nič neobjednal.'));
  end if;

  packs := case when tq % ps = 0 then (tq / ps)::text
                else replace(round(tq::numeric / ps, 1)::text, '.', ',') || ' (do celého balenia chýba ' || (ps - tq % ps) || ' ks)' end;
  body := body || jsonb_build_array(jsonb_build_object('type', 'FactSet', 'separator', true, 'facts', jsonb_build_array(
    jsonb_build_object('title', 'Spolu kusov', 'value', tq || ' ks'),
    jsonb_build_object('title', 'Balení po ' || ps || ' ks', 'value', packs),
    jsonb_build_object('title', 'Celková suma', 'value', vajicka.eur((sm->>'totalCents')::bigint)),
    jsonb_build_object('title', 'Nezaplatené', 'value', (sm->>'unpaidCount') || ' os. / ' || vajicka.eur((sm->>'unpaidCents')::bigint)))));

  return vajicka.wrap_card(body, entities, 'Otvoriť aplikáciu');
end $$;

-- Pondelková pripomienka: označí tých, čo ešte nemajú objednané a nevypli si ju
create or replace function vajicka.reminder_payload(k date) returns jsonb
language plpgsql stable as $$
declare
  o vajicka.orders;
  sm jsonb := vajicka.summary(k);
  who text;
  entities jsonb;
  n int := (sm->>'peopleCount')::int;
  body jsonb;
begin
  select * into o from vajicka.orders where delivery_date = k;
  select string_agg(case when p.email <> '' then '<at>' || p.name || '</at>' else '**' || p.name || '**' end, ', ' order by p.name collate "und-x-icu"),
         coalesce(jsonb_agg(jsonb_build_object('type', 'mention', 'text', '<at>' || p.name || '</at>',
           'mentioned', jsonb_build_object('id', p.email, 'name', p.name)) order by p.name collate "und-x-icu") filter (where p.email <> ''), '[]'::jsonb)
    into who, entities
  from vajicka.people p
  where p.active and p.remind
    and not exists (select 1 from vajicka.entries e where e.delivery_date = k and e.person_id = p.id and e.qty > 0);

  body := jsonb_build_array(
    jsonb_build_object('type', 'TextBlock', 'size', 'Large', 'weight', 'Bolder', 'wrap', true, 'text', '🥚 Vajíčka na stredu ' || vajicka.fdate(k) || '?'),
    jsonb_build_object('type', 'TextBlock', 'wrap', true, 'text',
      'Uzávierka: ' || vajicka.fdeadline(o.deadline) || '. Cena ' || vajicka.eur(o.pack_price_cents) || ' za ' || o.pack_size || ' ks.'));
  if who is not null then
    body := body || jsonb_build_array(jsonb_build_object('type', 'TextBlock', 'wrap', true, 'text', 'Ešte si neobjednali: ' || who));
  end if;
  body := body || jsonb_build_array(jsonb_build_object('type', 'TextBlock', 'wrap', true, 'isSubtle', true, 'spacing', 'Small',
    'text', case when n > 0 then 'Zatiaľ objednané: ' || (sm->>'totalQty') || ' ks od ' || n || case when n = 1 then ' človeka.' else ' ľudí.' end
                 else 'Zatiaľ si nikto neobjednal.' end));
  return vajicka.wrap_card(body, entities, 'Objednať');
end $$;

-- Odoslanie cez pg_net (asynchrónne). Vráti id požiadavky alebo null bez webhooku.
create or replace function vajicka.http_post(payload jsonb) returns bigint
language plpgsql as $$
declare url text := coalesce((vajicka.cfg()).teams_webhook_url, '');
begin
  if url = '' then return null; end if;
  return net.http_post(url := url, body := payload,
    headers := '{"Content-Type": "application/json"}'::jsonb, timeout_milliseconds := 10000);
end $$;

-- Prečíta odpovede Teams: pri chybe zapíše dôvod a zruší „odoslané“ (plánovač to skúsi znova)
create or replace function vajicka.sync_http() returns void
language plpgsql as $$
begin
  update vajicka.orders o set
    teams_error = coalesce(r.error_msg, 'Teams odpovedal ' || r.status_code || ': ' || left(coalesce(r.content, ''), 200)),
    teams_sent_at = null, teams_request_id = null
  from net._http_response r
  where r.id = o.teams_request_id and (r.error_msg is not null or r.status_code >= 300);
  update vajicka.orders o set teams_request_id = null
  from net._http_response r where r.id = o.teams_request_id;

  update vajicka.orders o set
    reminder_error = coalesce(r.error_msg, 'Teams odpovedal ' || r.status_code || ': ' || left(coalesce(r.content, ''), 200)),
    reminder_sent_at = null, reminder_request_id = null
  from net._http_response r
  where r.id = o.reminder_request_id and (r.error_msg is not null or r.status_code >= 300);
  update vajicka.orders o set reminder_request_id = null
  from net._http_response r where r.id = o.reminder_request_id;

  update vajicka.orders o set
    delivery_error = coalesce(r.error_msg, 'Teams odpovedal ' || r.status_code || ': ' || left(coalesce(r.content, ''), 200)),
    delivery_request_id = null
  from net._http_response r
  where r.id = o.delivery_request_id and (r.error_msg is not null or r.status_code >= 300);
  update vajicka.orders o set delivery_request_id = null
  from net._http_response r where r.id = o.delivery_request_id;
exception when undefined_table or invalid_schema_name then
  null; -- pg_net nie je nainštalovaný
end $$;

create or replace function vajicka.send_summary(k date) returns bool
language plpgsql as $$
declare rid bigint := vajicka.http_post(vajicka.summary_payload(k));
begin
  if rid is null then
    update vajicka.orders set teams_error = 'Nie je nastavená adresa Teams webhooku (teams_webhook_url)' where delivery_date = k;
    return false;
  end if;
  update vajicka.orders set teams_request_id = rid, teams_sent_at = vajicka.cas(), teams_error = null where delivery_date = k;
  return true;
end $$;

create or replace function vajicka.send_reminder(k date) returns bool
language plpgsql as $$
declare rid bigint := vajicka.http_post(vajicka.reminder_payload(k));
begin
  if rid is null then
    update vajicka.orders set reminder_error = 'Nie je nastavená adresa Teams webhooku (teams_webhook_url)' where delivery_date = k;
    return false;
  end if;
  update vajicka.orders set reminder_request_id = rid, reminder_sent_at = vajicka.cas(), reminder_error = null where delivery_date = k;
  return true;
end $$;

create or replace function vajicka.reminder_due(k date) returns bool
language sql stable as $$
  select s.reminder_enabled and vajicka.cas() < o.deadline
     and vajicka.cas() >= vajicka.reminder_at(k)
     and vajicka.cas() - vajicka.reminder_at(k) < interval '6 hours'  -- po výpadku nie neskôr ako 6 h
     and o.reminder_sent_at is null and o.reminder_request_id is null and o.reminder_attempts < 5
  from vajicka.settings s, vajicka.orders o where s.id = 1 and o.delivery_date = k
$$;

-- Plánovač (pg_cron každú minútu): otvorí objednávku, pripomenie, po uzávierke pošle súhrn
create or replace function vajicka.tick() returns void
language plpgsql as $$
declare
  k date := vajicka.open_delivery();
  o record;
begin
  perform vajicka.sync_http();
  if k is not null then
    perform vajicka.ensure_order(k);
    if vajicka.reminder_due(k) then
      update vajicka.orders set reminder_attempts = reminder_attempts + 1 where delivery_date = k;
      perform vajicka.send_reminder(k);
    end if;
  end if;
  for o in
    select delivery_date from vajicka.orders, vajicka.settings s
    where s.id = 1 and vajicka.cas() >= deadline
      and vajicka.cas() - deadline < make_interval(days => s.auto_send_within_days)
      and teams_sent_at is null and teams_request_id is null and teams_attempts < 5
  loop
    update vajicka.orders set teams_attempts = teams_attempts + 1 where delivery_date = o.delivery_date;
    perform vajicka.send_summary(o.delivery_date);
  end loop;
end $$;

-- =====================================================================
-- API pre stránku (volá sa cez Supabase REST: /rest/v1/rpc/vj_…)
-- =====================================================================

create or replace function public.vj_bootstrap(p_code text) returns jsonb
language plpgsql security definer set search_path = vajicka, pg_temp as $$
declare
  s vajicka.settings := vajicka.cfg();
  k date;
  nk date;
begin
  perform vajicka.auth(p_code);
  k := vajicka.open_delivery();
  if k is not null then perform vajicka.ensure_order(k); end if;
  if k is null then
    select c into nk from vajicka.candidates(vajicka.cas()) c where vajicka.cas() < vajicka.deadline_for(c) order by c limit 1;
  end if;
  return jsonb_build_object(
    'config', jsonb_build_object('appTitle', 'Vajíčka', 'packSize', s.pack_size, 'packPriceCents', s.pack_price_cents,
                                 'currency', s.currency, 'defaultQty', s.default_qty, 'timezone', s.timezone),
    'people', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'remind', remind) order by name collate "und-x-icu")
                        from vajicka.people where active), '[]'::jsonb),
    'supplierId', s.supplier_id,
    'openOrderId', k,
    'nextOpensAt', case when nk is not null then vajicka.opens_at(nk) end,
    'lastClosedId', vajicka.last_closed(),
    'teamsConfigured', coalesce(s.teams_webhook_url, '') <> '',
    'adminPinRequired', coalesce(s.admin_pin, '') <> '',
    'serverTime', vajicka.cas());
end $$;

create or replace function public.vj_orders(p_code text) returns jsonb
language plpgsql security definer set search_path = vajicka, pg_temp as $$
begin
  perform vajicka.auth(p_code);
  perform vajicka.sync_http();
  return coalesce((
    select jsonb_agg(vajicka.summary(o.delivery_date) - 'rows' order by o.delivery_date desc)
    from vajicka.orders o
    where vajicka.cas() < o.deadline
       or exists (select 1 from vajicka.entries e where e.delivery_date = o.delivery_date and e.qty > 0)), '[]'::jsonb);
end $$;

create or replace function public.vj_order(p_code text, p_id date) returns jsonb
language plpgsql security definer set search_path = vajicka, pg_temp as $$
begin
  perform vajicka.auth(p_code);
  perform vajicka.sync_http();
  if not exists (select 1 from vajicka.orders where delivery_date = p_id) then
    perform vajicka.fail(404, 'Objednávka neexistuje');
  end if;
  return vajicka.summary(p_id);
end $$;

create or replace function public.vj_set_qty(p_code text, p_id date, p_person uuid, p_qty int) returns jsonb
language plpgsql security definer set search_path = vajicka, pg_temp as $$
declare
  o vajicka.orders;
  v_paid int;
begin
  perform vajicka.auth(p_code);
  select * into o from vajicka.orders where delivery_date = p_id;
  if not found then perform vajicka.fail(404, 'Objednávka neexistuje'); end if;
  if vajicka.cas() >= o.deadline then perform vajicka.fail(409, 'Objednávka je už uzavretá'); end if;
  if not exists (select 1 from vajicka.people where id = p_person and active) then perform vajicka.fail(404, 'Neznáma osoba'); end if;
  if p_qty is null or p_qty < 0 or p_qty > 1000 then perform vajicka.fail(400, 'Neplatný počet kusov'); end if;
  if p_qty % o.pack_size <> 0 then perform vajicka.fail(400, 'Objednať sa dá len po ' || o.pack_size || ' ks'); end if;
  -- zaplatené vajíčka sa už nedajú odobrať (navýšiť áno – rozdiel sa doplatí)
  select paid_cents into v_paid from vajicka.entries where delivery_date = p_id and person_id = p_person;
  if coalesce(v_paid, 0) > round(p_qty * o.pack_price_cents::numeric / o.pack_size) then
    perform vajicka.fail(409, 'Už je zaplatené ' || vajicka.eur(v_paid)
      || ' – objednávku nemožno znížiť pod ' || (v_paid * o.pack_size / o.pack_price_cents) || ' ks');
  end if;

  if p_qty = 0 then
    delete from vajicka.entries where delivery_date = p_id and person_id = p_person;
  else
    insert into vajicka.entries (delivery_date, person_id, qty) values (p_id, p_person, p_qty)
    on conflict (delivery_date, person_id) do update set qty = excluded.qty, updated_at = now();
    update vajicka.entries set paid = paid_cents >= round(qty * o.pack_price_cents::numeric / o.pack_size)
    where delivery_date = p_id and person_id = p_person;
  end if;
  return vajicka.summary(p_id);
end $$;

create or replace function public.vj_set_paid(p_code text, p_id date, p_person uuid, p_actor uuid, p_paid bool) returns jsonb
language plpgsql security definer set search_path = vajicka, pg_temp as $$
begin
  perform vajicka.auth(p_code);
  if not exists (select 1 from vajicka.orders where delivery_date = p_id) then perform vajicka.fail(404, 'Objednávka neexistuje'); end if;
  if not (vajicka.summary(p_id)->>'editablePayments')::bool then perform vajicka.fail(409, 'Staršie týždne sú len na čítanie'); end if;
  if p_actor is distinct from p_person and p_actor is distinct from (vajicka.cfg()).supplier_id then
    perform vajicka.fail(403, 'Platbu za iných môže označiť len zabezpečovateľ');
  end if;
  if not coalesce(p_paid, false) and p_actor is distinct from (vajicka.cfg()).supplier_id
     and exists (select 1 from vajicka.entries where delivery_date = p_id and person_id = p_person and paid_cents > 0) then
    perform vajicka.fail(403, 'Zrušiť zaplatenie môže len zabezpečovateľ');
  end if;
  update vajicka.entries e set paid = coalesce(p_paid, false),
         paid_cents = case when p_paid then round(e.qty * o.pack_price_cents::numeric / o.pack_size) else 0 end,
         paid_at = case when p_paid then now() end, paid_by = case when p_paid then p_actor end
  from vajicka.orders o
  where o.delivery_date = e.delivery_date and e.delivery_date = p_id and e.person_id = p_person;
  if not found then perform vajicka.fail(404, 'Táto osoba nemá objednávku'); end if;
  return vajicka.summary(p_id);
end $$;

create or replace function public.vj_set_remind(p_code text, p_person uuid, p_actor uuid, p_remind bool) returns jsonb
language plpgsql security definer set search_path = vajicka, pg_temp as $$
begin
  perform vajicka.auth(p_code);
  if p_actor is distinct from p_person then perform vajicka.fail(403, 'Pripomienky si môže zmeniť len každý sám'); end if;
  update vajicka.people set remind = coalesce(p_remind, true) where id = p_person and active;
  if not found then perform vajicka.fail(404, 'Neznáma osoba'); end if;
  return jsonb_build_object('remind', coalesce(p_remind, true));
end $$;

create or replace function public.vj_send_summary(p_code text, p_id date) returns jsonb
language plpgsql security definer set search_path = vajicka, pg_temp as $$
begin
  perform vajicka.auth(p_code);
  if not exists (select 1 from vajicka.orders where delivery_date = p_id) then perform vajicka.fail(404, 'Objednávka neexistuje'); end if;
  if not vajicka.send_summary(p_id) then perform vajicka.fail(502, 'Nie je nastavená adresa Teams webhooku (teams_webhook_url)'); end if;
  return vajicka.summary(p_id);
end $$;

create or replace function public.vj_send_reminder(p_code text, p_pin text) returns jsonb
language plpgsql security definer set search_path = vajicka, pg_temp as $$
declare k date;
begin
  perform vajicka.auth(p_code);
  perform vajicka.admin(p_pin);
  k := vajicka.open_delivery();
  if k is null then perform vajicka.fail(409, 'Žiadna otvorená objednávka'); end if;
  perform vajicka.ensure_order(k);
  if not vajicka.send_reminder(k) then perform vajicka.fail(502, 'Nie je nastavená adresa Teams webhooku (teams_webhook_url)'); end if;
  return jsonb_build_object('ok', true, 'sentAt', vajicka.cas());
end $$;

-- ---------- Úprava podľa skutočnej dodávky ----------

-- Rozdelenie dodaných vajíčok „dookola po baleniach“: v každom kole dostane
-- jedno balenie každý, kto ešte chce viac; v poslednom kole má prednosť,
-- kto sa objednal skôr. Vychádza z pôvodnej objednávky (aj pri opakovanej úprave).
create or replace function vajicka.allocate(k date, delivered int) returns jsonb
language plpgsql stable as $$
declare
  o vajicka.orders;
  ids uuid[];
  names text[];
  wanted int[];
  given int[];
  packs int;
  r int := 1;
  i int;
  any_more bool;
begin
  select * into o from vajicka.orders where delivery_date = k;
  packs := delivered / o.pack_size;
  select array_agg(e.person_id order by e.created_at, e.person_id),
         array_agg(p.name order by e.created_at, e.person_id),
         array_agg(coalesce(e.qty_ordered, e.qty) / o.pack_size order by e.created_at, e.person_id)
    into ids, names, wanted
  from vajicka.entries e join vajicka.people p on p.id = e.person_id
  where e.delivery_date = k and coalesce(e.qty_ordered, e.qty) > 0;
  if ids is null then return '[]'::jsonb; end if;
  given := array_fill(0, array[array_length(ids, 1)]);

  while packs > 0 loop
    any_more := false;
    for i in 1 .. array_length(ids, 1) loop
      exit when packs = 0;
      if wanted[i] >= r then
        given[i] := given[i] + 1;
        packs := packs - 1;
        any_more := true;
      end if;
    end loop;
    exit when not any_more;
    r := r + 1;
  end loop;

  return (select jsonb_agg(jsonb_build_object('personId', ids[g.n], 'name', names[g.n],
            'orderedQty', wanted[g.n] * o.pack_size, 'qty', given[g.n] * o.pack_size) order by names[g.n] collate "und-x-icu")
          from generate_series(1, array_length(ids, 1)) g(n));
end $$;

-- Správa do Teams po úprave: označí tých, ktorým sa objednávka zmenila
create or replace function vajicka.delivery_payload(k date) returns jsonb
language plpgsql stable as $$
declare
  o vajicka.orders;
  sm jsonb := vajicka.summary(k);
  lines text;
  entities jsonb;
  body jsonb;
begin
  select * into o from vajicka.orders where delivery_date = k;
  select string_agg(
           case when p.email <> '' then '<at>' || p.name || '</at>' else '**' || p.name || '**' end
           || ': ' || (r->>'orderedQty') || ' → **' || (r->>'qty') || ' ks** (' || vajicka.eur((r->>'cents')::bigint) || ')'
           || case when (r->>'refundCents')::int > 0 then ' – vrátime ' || vajicka.eur((r->>'refundCents')::bigint) else '' end,
           E'\n\n' order by r->>'name' collate "und-x-icu"),
         coalesce(jsonb_agg(jsonb_build_object('type', 'mention', 'text', '<at>' || p.name || '</at>',
           'mentioned', jsonb_build_object('id', p.email, 'name', p.name))) filter (where p.email <> ''), '[]'::jsonb)
    into lines, entities
  from jsonb_array_elements(sm->'rows') r
  join vajicka.people p on p.id = (r->>'personId')::uuid
  where (r->>'qty')::int <> (r->>'orderedQty')::int;

  body := jsonb_build_array(
    jsonb_build_object('type', 'TextBlock', 'size', 'Large', 'weight', 'Bolder', 'wrap', true,
      'text', '🥚 Upravená objednávka – streda ' || vajicka.fdate(k)),
    jsonb_build_object('type', 'TextBlock', 'wrap', true,
      'text', 'Farmár dodal **' || o.delivered_qty || ' ks** z objednaných ' || (sm->>'orderedQty')
              || ' ks. Vajíčka sme rozdelili dookola po baleniach, aby sa ušlo každému.'));
  if lines is not null then
    body := body || jsonb_build_array(
      jsonb_build_object('type', 'TextBlock', 'wrap', true, 'weight', 'Bolder', 'text', 'Upravené objednávky:'),
      jsonb_build_object('type', 'TextBlock', 'wrap', true, 'text', lines),
      jsonb_build_object('type', 'TextBlock', 'wrap', true, 'isSubtle', true, 'text', 'Ostatní dostanú všetko, čo si objednali.'));
  end if;
  return vajicka.wrap_card(body, entities, 'Otvoriť súhrn');
end $$;

-- Návrh rozdelenia (nič neukladá)
create or replace function public.vj_delivery_preview(p_code text, p_pin text, p_id date, p_delivered int) returns jsonb
language plpgsql security definer set search_path = vajicka, pg_temp as $$
declare
  o vajicka.orders;
  ordered int;
begin
  perform vajicka.auth(p_code);
  perform vajicka.admin(p_pin);
  select * into o from vajicka.orders where delivery_date = p_id;
  if not found then perform vajicka.fail(404, 'Objednávka neexistuje'); end if;
  if vajicka.cas() < o.deadline then perform vajicka.fail(409, 'Dodávku možno upraviť až po uzávierke'); end if;
  select coalesce(sum(coalesce(qty_ordered, qty)), 0) into ordered from vajicka.entries where delivery_date = p_id;
  if p_delivered is null or p_delivered < 0 or p_delivered % o.pack_size <> 0 then
    perform vajicka.fail(400, 'Dodané množstvo musí byť po ' || o.pack_size || ' ks');
  end if;
  if p_delivered > ordered then
    perform vajicka.fail(400, 'Dodaných nemôže byť viac, ako sa objednalo (' || ordered || ' ks)');
  end if;
  return jsonb_build_object('deliveredQty', p_delivered, 'orderedQty', ordered, 'packSize', o.pack_size,
    'packPriceCents', o.pack_price_cents, 'rows', vajicka.allocate(p_id, p_delivered));
end $$;

-- Potvrdenie: uloží pridelené množstvá (návrh, prípadne ručne upravený) a pošle správu do Teams
create or replace function public.vj_delivery_confirm(p_code text, p_pin text, p_id date, p_delivered int, p_alloc jsonb) returns jsonb
language plpgsql security definer set search_path = vajicka, pg_temp as $$
declare
  o vajicka.orders;
  a record;
  total int := 0;
  rid bigint;
begin
  perform public.vj_delivery_preview(p_code, p_pin, p_id, p_delivered);   -- rovnaké kontroly
  select * into o from vajicka.orders where delivery_date = p_id;

  for a in
    select (x->>'personId')::uuid as person_id, (x->>'qty')::int as qty, coalesce(e.qty_ordered, e.qty) as ordered
    from jsonb_array_elements(coalesce(p_alloc, '[]'::jsonb)) x
    left join vajicka.entries e on e.delivery_date = p_id and e.person_id = (x->>'personId')::uuid
  loop
    if a.ordered is null then perform vajicka.fail(400, 'Osoba v rozdelení nemá objednávku'); end if;
    if a.qty is null or a.qty < 0 or a.qty % o.pack_size <> 0 or a.qty > a.ordered then
      perform vajicka.fail(400, 'Pridelené množstvo musí byť po ' || o.pack_size || ' ks a najviac toľko, koľko si kto objednal');
    end if;
    total := total + a.qty;
  end loop;
  if total <> p_delivered then
    perform vajicka.fail(400, 'Rozdelených je ' || total || ' ks, dodaných ' || p_delivered || ' ks – súčet musí sedieť');
  end if;
  if (select count(*) from jsonb_array_elements(p_alloc)) <>
     (select count(*) from vajicka.entries where delivery_date = p_id and coalesce(qty_ordered, qty) > 0) then
    perform vajicka.fail(400, 'Rozdelenie musí obsahovať všetkých, ktorí si objednali');
  end if;

  update vajicka.entries e set
    qty_ordered = coalesce(e.qty_ordered, e.qty),
    qty = (x->>'qty')::int,
    paid = e.paid_cents >= round((x->>'qty')::int * o.pack_price_cents::numeric / o.pack_size) and (x->>'qty')::int > 0,
    updated_at = now()
  from jsonb_array_elements(p_alloc) x
  where e.delivery_date = p_id and e.person_id = (x->>'personId')::uuid;
  -- dodané všetko = späť na pôvodné objednávky
  if p_delivered = (select sum(coalesce(qty_ordered, qty)) from vajicka.entries where delivery_date = p_id) then
    update vajicka.entries set qty_ordered = null where delivery_date = p_id;
  end if;

  update vajicka.orders set delivered_qty = p_delivered, delivery_adjusted_at = vajicka.cas(), delivery_error = null
  where delivery_date = p_id;
  rid := vajicka.http_post(vajicka.delivery_payload(p_id));
  update vajicka.orders set delivery_request_id = rid,
    delivery_error = case when rid is null then 'Nie je nastavená adresa Teams webhooku (teams_webhook_url)' end
  where delivery_date = p_id;
  return vajicka.summary(p_id);
end $$;

-- ---------- Správa ľudí ----------

create or replace function public.vj_admin_people(p_code text, p_pin text) returns jsonb
language plpgsql security definer set search_path = vajicka, pg_temp as $$
declare
  s vajicka.settings := vajicka.cfg();
  k date;
  o vajicka.orders;
begin
  perform vajicka.auth(p_code);
  perform vajicka.admin(p_pin);
  perform vajicka.sync_http();
  k := vajicka.open_delivery();
  select * into o from vajicka.orders where delivery_date = k;
  return jsonb_build_object(
    'people', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'email', email, 'remind', remind)
                        order by name collate "und-x-icu") from vajicka.people where active), '[]'::jsonb),
    'supplierId', s.supplier_id,
    'reminder', jsonb_build_object('enabled', s.reminder_enabled,
      'nextAt', case when k is not null then vajicka.reminder_at(k) end,
      'sentAt', o.reminder_sent_at, 'error', o.reminder_error));
end $$;

create or replace function vajicka.add_person(p_name text, p_email text) returns bool
language plpgsql as $$
declare
  n text := trim(coalesce(p_name, ''));
  e text := trim(coalesce(p_email, ''));
  p vajicka.people;
begin
  if n = '' then return false; end if;
  select * into p from vajicka.people where lower(name) = lower(n);
  if found and p.active then return false; end if;
  if found then
    update vajicka.people set active = true, email = case when e <> '' then e else email end where id = p.id;
  else
    insert into vajicka.people (name, email) values (n, e);
  end if;
  return true;
end $$;

create or replace function public.vj_admin_add(p_code text, p_pin text, p_name text, p_email text) returns jsonb
language plpgsql security definer set search_path = vajicka, pg_temp as $$
begin
  perform vajicka.auth(p_code);
  perform vajicka.admin(p_pin);
  if trim(coalesce(p_name, '')) = '' then perform vajicka.fail(400, 'Meno je povinné'); end if;
  if not vajicka.add_person(p_name, p_email) then perform vajicka.fail(409, 'Toto meno už v zozname je'); end if;
  return jsonb_build_object('ok', true);
end $$;

-- Hromadné pridanie: riadky „Meno; email“, „Meno <email>“ alebo len „Meno“
create or replace function public.vj_admin_bulk(p_code text, p_pin text, p_text text) returns jsonb
language plpgsql security definer set search_path = vajicka, pg_temp as $$
declare
  line text;
  m text[];
  added int := 0;
  skipped int := 0;
begin
  perform vajicka.auth(p_code);
  perform vajicka.admin(p_pin);
  foreach line in array regexp_split_to_array(coalesce(p_text, ''), E'\\r?\\n') loop
    line := trim(line);
    continue when line = '';
    m := regexp_match(line, '^(.+?)\s*(?:[;,\t]\s*|<)\s*([^\s<>;,]+@[^\s<>;,]+)>?\s*$');
    if vajicka.add_person(coalesce(m[1], line), coalesce(m[2], '')) then added := added + 1; else skipped := skipped + 1; end if;
  end loop;
  return jsonb_build_object('added', added, 'skipped', skipped);
end $$;

create or replace function public.vj_admin_update(p_code text, p_pin text, p_person uuid,
  p_name text default null, p_email text default null, p_supplier bool default false) returns jsonb
language plpgsql security definer set search_path = vajicka, pg_temp as $$
begin
  perform vajicka.auth(p_code);
  perform vajicka.admin(p_pin);
  if not exists (select 1 from vajicka.people where id = p_person) then perform vajicka.fail(404, 'Neznáma osoba'); end if;
  update vajicka.people set
    name = case when trim(coalesce(p_name, '')) <> '' then trim(p_name) else name end,
    email = case when p_email is not null then trim(p_email) else email end
  where id = p_person;
  if p_supplier then update vajicka.settings set supplier_id = p_person where id = 1; end if;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.vj_admin_remove(p_code text, p_pin text, p_person uuid) returns jsonb
language plpgsql security definer set search_path = vajicka, pg_temp as $$
declare k date;
begin
  perform vajicka.auth(p_code);
  perform vajicka.admin(p_pin);
  if p_person = (vajicka.cfg()).supplier_id then perform vajicka.fail(409, 'Najprv urč iného zabezpečovateľa'); end if;
  update vajicka.people set active = false where id = p_person;   -- ostáva kvôli histórii
  if not found then perform vajicka.fail(404, 'Neznáma osoba'); end if;
  k := vajicka.open_delivery();
  delete from vajicka.entries where delivery_date = k and person_id = p_person and paid_cents = 0;
  return jsonb_build_object('ok', true);
end $$;

-- ---------- Práva ----------

revoke all on all functions in schema vajicka from public;
do $$
declare f text;
begin
  foreach f in array array['vj_bootstrap(text)', 'vj_orders(text)', 'vj_order(text,date)',
    'vj_set_qty(text,date,uuid,int)', 'vj_set_paid(text,date,uuid,uuid,bool)', 'vj_set_remind(text,uuid,uuid,bool)',
    'vj_send_summary(text,date)', 'vj_send_reminder(text,text)', 'vj_admin_people(text,text)',
    'vj_admin_add(text,text,text,text)', 'vj_admin_bulk(text,text,text)',
    'vj_admin_update(text,text,uuid,text,text,bool)', 'vj_admin_remove(text,text,uuid)',
    'vj_delivery_preview(text,text,date,int)', 'vj_delivery_confirm(text,text,date,int,jsonb)'] loop
    execute format('revoke all on function public.%s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('grant execute on function public.%s to anon, authenticated', f);
    end if;
  end loop;
end $$;

-- ---------- Plánovač ----------

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'vajicka-tick';
    perform cron.schedule('vajicka-tick', '* * * * *', 'select vajicka.tick()');
  end if;
end $$;
