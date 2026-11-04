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
select pg_temp.eq(jsonb_array_length(vj_admin_people('TEST', '1234')->'people'), 6, 'zoznam ľudí so správnym PIN');
select pg_temp.fails(format($$select vj_admin_remove('TEST', '1234', %L)$$, (select jan from ids)), '409', 'zabezpečovateľa nemožno odobrať');
select pg_temp.eq(jsonb_array_length(vj_orders('TEST')), 2, 'zoznam objednávok');

\echo VŠETKY TESTY PREŠLI
