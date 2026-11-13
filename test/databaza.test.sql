-- Testy databázy:
--   psql -v ON_ERROR_STOP=1 -f test/net-stub.sql -f supabase/databaza.sql -f test/databaza.test.sql
\set QUIET on
create or replace function pg_temp.eq(actual anyelement, expected anyelement, what text) returns void
language plpgsql as $$
begin
  if actual is distinct from expected then
    raise exception 'ZLYHAL: % – očakávané %, je %', what, expected, actual;
  end if;
  raise notice 'ok – %', what;
end $$;

-- očakávaná chyba s HTTP stavom v hinte
create or replace function pg_temp.fails(sql text, status text, what text) returns void
language plpgsql as $$
declare h text;
begin
  begin
    execute sql;
  exception when others then
    get stacked diagnostics h = pg_exception_hint;
    perform pg_temp.eq(h, status, what);
    return;
  end;
  raise exception 'ZLYHAL: % – mala nastať chyba %', what, status;
end $$;

-- príprava
update vajicka.settings set group_code = 'TEST', admin_pin = null, teams_webhook_url = 'https://teams.example/hook',
  app_url = 'https://rado.github.io/vajicka/' where id = 1;
insert into vajicka.people (name, email) values ('Ján Novák', 'jan@firma.sk'), ('Mária Kováčová', 'maria@firma.sk'), ('Peter Horváth', '');
update vajicka.settings set supplier_id = (select id from vajicka.people where name = 'Ján Novák');
create temp table ids as select
  (select id from vajicka.people where name = 'Ján Novák') jan,
  (select id from vajicka.people where name = 'Mária Kováčová') maria,
  (select id from vajicka.people where name = 'Peter Horváth') peter;

-- čas a uzávierka
select pg_temp.eq(vajicka.deadline_for('2026-11-04'), '2026-11-03 19:00+00'::timestamptz, 'uzávierka utorok 20:00 (zimný čas)');
select pg_temp.eq(vajicka.deadline_for('2026-06-10'), '2026-06-09 18:00+00'::timestamptz, 'uzávierka utorok 20:00 (letný čas)');
select pg_temp.eq(vajicka.reminder_at('2026-11-04'), '2026-11-02 07:00+00'::timestamptz, 'pripomienka pondelok 8:00');
select pg_temp.eq(vajicka.open_delivery('2026-10-27 18:59+00'), '2026-10-28'::date, 'pred uzávierkou otvorená streda 28. 10.');
select pg_temp.eq(vajicka.open_delivery('2026-10-27 19:01+00'), '2026-11-04'::date, 'po uzávierke otvorená ďalšia streda');

-- objednávka
select set_config('vajicka.now', '2026-11-02 06:00+00', false);
select pg_temp.fails($$select vj_bootstrap('ZLE')$$, '401', 'nesprávny kód skupiny');
select pg_temp.eq(vj_bootstrap('test')->>'openOrderId', '2026-11-04', 'bootstrap: otvorená objednávka (kód bez ohľadu na veľkosť písmen)');
select pg_temp.fails(format($$select vj_set_qty('TEST', '2026-11-04', %L, 15)$$, (select maria from ids)), '400', 'len po 10 ks');
select pg_temp.eq((vj_set_qty('TEST', '2026-11-04', (select maria from ids), 20)->>'totalQty')::int, 20, 'uloženie 20 ks');
select pg_temp.eq((vj_set_qty('TEST', '2026-11-04', (select jan from ids), 30)->>'totalCents')::int, 1500, 'suma 50 ks = 15 €');

-- platby
select pg_temp.fails(format($$select vj_set_paid('TEST', '2026-11-04', %L, %L, true)$$, (select maria from ids), (select peter from ids)), '403', 'za iného len zabezpečovateľ');
select pg_temp.eq((vj_set_paid('TEST', '2026-11-04', (select maria from ids), (select jan from ids), true)->>'unpaidCents')::int, 900, 'zabezpečovateľ označil Máriu');
select pg_temp.eq((select paid_by from vajicka.entries where person_id = (select maria from ids)), (select jan from ids), 'zapísané, kto označil');

-- navýšenie po zaplatení: dopočíta rozdiel
create temp table s1 as select vj_set_qty('TEST', '2026-11-04', (select maria from ids), 30) as j;
select pg_temp.eq((select (r->>'paid')::bool from s1, jsonb_array_elements(j->'rows') r where r->>'name' like 'Mária%'), false, 'po navýšení už nie je zaplatené');
select pg_temp.eq((select (r->>'dueCents')::int from s1, jsonb_array_elements(j->'rows') r where r->>'name' like 'Mária%'), 300, 'doplatiť 3 € za navýšenie');
select pg_temp.eq((select (j->>'unpaidCents')::int from s1), 1200, 'nezaplatené spolu: 9 € Ján + 3 € doplatok');
select pg_temp.eq(vajicka.summary_payload('2026-11-04')::text like '%doplatiť 3,00 €%', true, 'doplatok aj v Teams súhrne');
-- zníženie pod zaplatené nejde
select pg_temp.fails(format($$select vj_set_qty('TEST', '2026-11-04', %L, 10)$$, (select maria from ids)), '409', 'nemožno znížiť pod zaplatené');
select pg_temp.fails(format($$select vj_set_qty('TEST', '2026-11-04', %L, 0)$$, (select maria from ids)), '409', 'nemožno zrušiť zaplatenú objednávku');
select pg_temp.eq((vj_set_qty('TEST', '2026-11-04', (select maria from ids), 20)->>'unpaidCents')::int, 900, 'späť na zaplatené množstvo ide');
-- zrušiť zaplatenie môže len zabezpečovateľ
select pg_temp.fails(format($$select vj_set_paid('TEST', '2026-11-04', %L, %L, false)$$, (select maria from ids), (select maria from ids)), '403', 'zrušiť platbu nemôže sama');
select vj_set_qty('TEST', '2026-11-04', (select maria from ids), 30);
select pg_temp.eq((vj_set_paid('TEST', '2026-11-04', (select maria from ids), (select maria from ids), true)->>'unpaidCents')::int, 900, 'doplatila – zaplatené celých 9 €');
select pg_temp.eq((select paid_cents from vajicka.entries where person_id = (select maria from ids)), 900, 'zapamätaná zaplatená suma');
select vj_set_paid('TEST', '2026-11-04', (select maria from ids), (select jan from ids), false);
select pg_temp.eq((vj_set_qty('TEST', '2026-11-04', (select maria from ids), 20)->>'totalQty')::int, 50, 'po zrušení platby zabezpečovateľom sa dá znížiť');
select vj_set_paid('TEST', '2026-11-04', (select maria from ids), (select jan from ids), true);

-- pripomienka
select pg_temp.eq(vajicka.reminder_due('2026-11-04'), false, 'pred 8:00 sa nepripomína');
select set_config('vajicka.now', '2026-11-02 07:00:30+00', false);
select vajicka.tick();
select pg_temp.eq((select count(*) from net.calls)::int, 1, 'o 8:00 odišla pripomienka');
select pg_temp.eq((select body::text from net.calls order by id desc limit 1) like '%<at>Mária%', false, 'Mária už objednala – neoznačená');
select pg_temp.eq((select body::text from net.calls order by id desc limit 1) like '%**Peter Horváth**%', true, 'bez e-mailu len tučne');
select pg_temp.eq((select body #>> '{attachments,0,content,actions,0,url}' from net.calls order by id desc limit 1),
  'https://rado.github.io/vajicka/#kod=TEST', 'tlačidlo Objednať s kódom skupiny');
select vajicka.tick();
select pg_temp.eq((select count(*) from net.calls)::int, 1, 'pripomienka len raz');

-- vypnutie pripomienky
select pg_temp.fails(format($$select vj_set_remind('TEST', %L, %L, false)$$, (select peter from ids), (select jan from ids)), '403', 'pripomienky si mení len každý sám');
select vj_set_remind('TEST', (select peter from ids), (select peter from ids), false);
select pg_temp.eq(vajicka.reminder_payload('2026-11-04')::text like '%Peter%', false, 'vypnutá pripomienka – Peter neoznačený');

-- po uzávierke
select set_config('vajicka.now', '2026-11-03 19:01+00', false);
select pg_temp.fails(format($$select vj_set_qty('TEST', '2026-11-04', %L, 10)$$, (select peter from ids)), '409', 'po uzávierke sa nedá meniť');
select vajicka.tick();
select pg_temp.eq((select count(*) from net.calls)::int, 2, 'súhrn odišiel po uzávierke');
select pg_temp.eq((select body #>> '{attachments,0,content,msteams,entities,0,mentioned,id}' from net.calls order by id desc limit 1),
  'jan@firma.sk', 'súhrn označí zabezpečovateľa');
select pg_temp.eq(vj_bootstrap('TEST')->>'openOrderId', '2026-11-11', 'otvorila sa ďalšia streda');
select pg_temp.eq(vj_bootstrap('TEST')->>'lastClosedId', '2026-11-04', 'posledná uzavretá');
select pg_temp.eq((vj_set_paid('TEST', '2026-11-04', (select jan from ids), (select jan from ids), true)->>'unpaidCount')::int, 0, 'platba aj po uzávierke');

-- chyba Teams sa zapíše a súhrn sa pošle znova
insert into net._http_response (id, status_code, content) select max(id), 400, 'Bad payload' from net.calls;
select vajicka.sync_http();
select pg_temp.eq((select teams_error from vajicka.orders where delivery_date = '2026-11-04'), 'Teams odpovedal 400: Bad payload', 'chyba z Teams zapísaná');
select vajicka.tick();
select pg_temp.eq((select count(*) from net.calls)::int, 3, 'po chybe sa súhrn skúsi znova');

-- staršie týždne len na čítanie
select set_config('vajicka.now', '2026-11-09 10:00+00', false);
select vj_set_qty('TEST', '2026-11-11', (select maria from ids), 10) is null;
select set_config('vajicka.now', '2026-11-10 19:02+00', false);
select pg_temp.fails(format($$select vj_set_paid('TEST', '2026-11-04', %L, %L, false)$$, (select jan from ids), (select jan from ids)), '409', 'starší týždeň len na čítanie');

-- správa ľudí
select pg_temp.eq(vj_admin_bulk('TEST', null, E'Eva Nová; eva@firma.sk\nIvo Starý <ivo@firma.sk>\nOto Bez\nJán Novák; x@y.sk\n'),
  '{"added": 3, "skipped": 1}'::jsonb, 'hromadné pridanie');
select pg_temp.eq((select email from vajicka.people where name = 'Ivo Starý'), 'ivo@firma.sk', 'e-mail z „Meno <email>“');
update vajicka.settings set admin_pin = '1234';
select pg_temp.fails($$select vj_admin_people('TEST', '0000')$$, '403', 'nesprávny PIN');
select pg_temp.fails($$select vj_admin_add('TEST', null, 'Cudzí Človek', '')$$, '403', 'bez PIN-u nikto nepridá človeka');
select pg_temp.fails($$select vj_admin_bulk('TEST', '0000', 'Cudzí Človek')$$, '403', 'so zlým PIN-om nikto nepridá hromadne');
select pg_temp.eq((select count(*) from vajicka.people where name = 'Cudzí Človek')::int, 0, 'cudzí človek nepridaný');
select pg_temp.eq(vj_admin_add('TEST', '1234', 'Nová Kolegyňa', ''), '{"ok": true}'::jsonb, 'so správnym PIN-om sa pridá');
select pg_temp.eq(jsonb_array_length(vj_admin_people('TEST', '1234')->'people'), 7, 'zoznam ľudí so správnym PIN');
select pg_temp.fails(format($$select vj_admin_remove('TEST', '1234', %L)$$, (select jan from ids)), '409', 'zabezpečovateľa nemožno odobrať');
select pg_temp.eq(jsonb_array_length(vj_orders('TEST')), 2, 'zoznam objednávok');


-- ---------- úprava podľa dodávky: objednaných 310, dodaných 170 ----------
select vj_admin_bulk('TEST', '1234', E'Osoba A\nOsoba B\nOsoba C\nOsoba D\nOsoba E\nOsoba F\nOsoba G\nOsoba H\nOsoba I');
select set_config('vajicka.now', '2026-11-16 08:00+00', false);
select vj_bootstrap('TEST');
do $$
declare q int[] := array[60, 50, 40, 40, 30, 30, 30, 20, 10]; i int;
begin
  for i in 1..9 loop
    perform vj_set_qty('TEST', '2026-11-18', (select id from vajicka.people where name = 'Osoba ' || chr(64 + i)), q[i]);
    update vajicka.entries set created_at = '2026-11-16 08:00+00'::timestamptz + i * interval '1 minute'
    where person_id = (select id from vajicka.people where name = 'Osoba ' || chr(64 + i));
  end loop;
end $$;
-- A zaplatil celých 60 ks (18 €) ešte pred dodávkou
select vj_set_paid('TEST', '2026-11-18', (select id from vajicka.people where name = 'Osoba A'), (select id from vajicka.people where name = 'Osoba A'), true);
select pg_temp.fails($$select vj_delivery_preview('TEST', '1234', '2026-11-18', 170)$$, '409', 'dodávka sa upravuje až po uzávierke');

select set_config('vajicka.now', '2026-11-18 12:00+00', false);
select pg_temp.fails($$select vj_delivery_preview('TEST', '0000', '2026-11-18', 170)$$, '403', 'dodávku bez PIN-u nikto neupraví');
select pg_temp.fails($$select vj_delivery_preview('TEST', '1234', '2026-11-18', 175)$$, '400', 'dodané len po 10 ks');
select pg_temp.fails($$select vj_delivery_preview('TEST', '1234', '2026-11-18', 320)$$, '400', 'dodané nie viac ako objednané');
create temp table prev as select vj_delivery_preview('TEST', '1234', '2026-11-18', 170) as j;
select pg_temp.eq((select string_agg(r->>'name' || '=' || (r->>'qty'), ' ' order by r->>'name') from prev, jsonb_array_elements(j->'rows') r),
  'Osoba A=20 Osoba B=20 Osoba C=20 Osoba D=20 Osoba E=20 Osoba F=20 Osoba G=20 Osoba H=20 Osoba I=10', 'dookola po baleniach: 310 → 170');
select pg_temp.eq((select string_agg(r->>'name' || '=' || (r->>'qty'), ' ' order by r->>'name')
  from jsonb_array_elements(vj_delivery_preview('TEST', '1234', '2026-11-18', 100)->'rows') r),
  'Osoba A=20 Osoba B=10 Osoba C=10 Osoba D=10 Osoba E=10 Osoba F=10 Osoba G=10 Osoba H=10 Osoba I=10', 'v poslednom kole má prednosť, kto objednal skôr');

-- ručná úprava: súčet musí sedieť
select pg_temp.fails($$select vj_delivery_confirm('TEST', '1234', '2026-11-18', 170,
  (select jsonb_agg(jsonb_build_object('personId', r->>'personId', 'qty', 10)) from prev, jsonb_array_elements(j->'rows') r))$$,
  '400', 'nesedí súčet rozdelenia');
select pg_temp.fails($$select vj_delivery_confirm('TEST', '1234', '2026-11-18', 170,
  (select jsonb_agg(jsonb_build_object('personId', r->>'personId', 'qty', case when r->>'name' = 'Osoba I' then 30 when r->>'name' = 'Osoba H' then 0 else (r->>'qty')::int end)) from prev, jsonb_array_elements(j->'rows') r))$$,
  '400', 'nikto nedostane viac, ako objednal');

-- potvrdenie
create temp table conf as select vj_delivery_confirm('TEST', '1234', '2026-11-18', 170,
  (select jsonb_agg(jsonb_build_object('personId', r->>'personId', 'qty', (r->>'qty')::int)) from prev, jsonb_array_elements(j->'rows') r)) as j;
select pg_temp.eq((select (j->>'totalQty')::int from conf), 170, 'po úprave spolu 170 ks');
select pg_temp.eq((select (j->>'orderedQty')::int from conf), 310, 'pôvodne objednaných 310 ks');
select pg_temp.eq((select (j->>'totalCents')::int from conf), 5100, 'suma 51 € podľa dodávky');
select pg_temp.eq((select (r->>'orderedQty')::int || '→' || (r->>'qty') from conf, jsonb_array_elements(j->'rows') r where r->>'name' = 'Osoba A'), '60→20', 'osoba A: 60 → 20');
select pg_temp.eq((select (r->>'refundCents')::int from conf, jsonb_array_elements(j->'rows') r where r->>'name' = 'Osoba A'), 1200, 'osoba A zaplatila 18 €, vrátiť 12 €');
select pg_temp.eq((select (j->'delivery'->>'deliveredQty')::int from conf), 170, 'uložené dodané množstvo');
select pg_temp.eq((select body::text from net.calls order by id desc limit 1) like '%Farmár dodal **170 ks** z objednaných 310%', true, 'správa do Teams o dodávke');
select pg_temp.eq((select body::text from net.calls order by id desc limit 1) like '%Osoba I%', false, 'v správe len tí, ktorým sa objednávka zmenila');
select pg_temp.eq((select body::text from net.calls order by id desc limit 1) like '%vrátime 12,00 €%', true, 'v správe aj vrátenie peňazí');
-- vrátené: zabezpečovateľ označí zaplatené → vrátiť 0
select pg_temp.eq((select (r->>'refundCents')::int from jsonb_array_elements(
  vj_set_paid('TEST', '2026-11-18', (select id from vajicka.people where name = 'Osoba A'), (select jan from ids), true)->'rows') r where r->>'name' = 'Osoba A'), 0, 'po vrátení peňazí sedí');
-- opätovná úprava vychádza z pôvodnej objednávky
select pg_temp.eq((select r->>'qty' from jsonb_array_elements(vj_delivery_preview('TEST', '1234', '2026-11-18', 310)->'rows') r where r->>'name' = 'Osoba A'), '60', 'opätovná úprava počíta s pôvodnými 60 ks');

\echo VŠETKY TESTY PREŠLI
