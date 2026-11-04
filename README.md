# Vajíčka – spoločné objednávanie vajíčok

Webová appka pre skupinu „vajká na stredu“: každý si zapíše, koľko vajíčok chce na stredu, appka ukáže súhrn,
sleduje platby a posiela správy do Teams. Vizuál KROS (korporátny režim), funguje na mobile aj počítači.

**Ako to beží** (rovnako ako Dovolenky):

| Časť | Kde |
|---|---|
| Stránka | GitHub Pages – priečinok `docs/` |
| Dáta, pravidlá, plánovač, správy do Teams | Supabase (PostgreSQL + pg_cron + pg_net) – súbor `supabase/databaza.sql` |

## Funkcie

- **Objednávka** na najbližšiu stredu, len po 10 ks (−10 / +10, rýchla voľba 10–60 ks), cena 3 € / 10 ks.
- **Uzávierka** v utorok o 20:00 (Europe/Bratislava), potom sa už množstvo nedá meniť. Hneď sa otvorí ďalší týždeň.
- **Súhrn**: meno | ks | suma | zaplatené, spolu ks, balenia a suma, nezaplatené (farebne).
- **Platby**: každý si označí „Zaplatil som“, zabezpečovateľ môže označiť za hocikoho.
- **História** predchádzajúcich týždňov (len na čítanie).
- **Teams**: v pondelok o 8:00 pripomienka (označí tých, čo ešte nemajú objednané a nevypli si ju),
  po uzávierke súhrn pre zabezpečovateľa s @označením. Tlačidlá „Poslať súhrn znova“ a „Poslať pripomienku teraz“.
- **Ľudia**: pridať / odobrať / premenovať, e-mail pre @označenie, hromadné pridanie, výber zabezpečovateľa.

## Prihlásenie

Bez hesla: na prvej obrazovke sa zadá **kód skupiny**, potom si každý vyberie svoje meno (prehliadač si ho zapamätá).
Tlačidlo v Teams správe obsahuje kód v odkaze, takže z Teams sa otvorí rovno.
Tabuľky sú v schéme `vajicka`, ktorú Supabase API nesprístupňuje – stránka volá len funkcie `vj_*`
a každá overí kód skupiny. Adresa Teams webhooku je len v databáze.

## Nastavenie (raz)

1. **Supabase** – na [supabase.com](https://supabase.com) vytvor nový projekt (napr. `vajicka`, región Frankfurt).
2. **Databáza** – Supabase → *SQL Editor* → vlož celý `supabase/databaza.sql` → *Run*.
   Zapne aj rozšírenia `pg_cron` a `pg_net` a naplánuje úlohu `vajicka-tick` (každú minútu).
3. **Ľudia** – v appke záložka *Ľudia* → „Hromadne pridať“ (riadky `Meno; email`), alebo SQL skript so zoznamom.
4. **Nastavenia** – Supabase → *Table Editor* → schéma `vajicka` → tabuľka `settings`:
   - `group_code` – kód skupiny (vygeneruje sa sám, môžeš zmeniť),
   - `teams_webhook_url` – webhook z Teams (nižšie),
   - `app_url` – adresa appky, napr. `https://rado2439.github.io/vajicka/`,
   - `admin_pin` – nepovinný PIN pre záložku Ľudia,
   - cena, balenie, uzávierka, pripomienka (`pack_size`, `pack_price_cents`, `deadline_time`, `reminder_time`, …).
5. **Stránka** – do `docs/config.js` doplň *Project URL* a *anon public* kľúč (Supabase → *Project Settings* → *API*).
6. **GitHub Pages** – repozitár → *Settings* → *Pages* → *Deploy from a branch* → `main` / `/docs` → *Save*.
   (GitHub Pages zadarmo funguje len pre verejný repozitár.)

### Teams webhook

Skupina „vajká na stredu“ je skupinový chat: Teams → *Workflows* → šablóna
**„Post to a chat when a webhook request is received“** → vyber chat → skopíruj URL do `teams_webhook_url`.
Označenie (@mention) používa e-mail osoby – musí byť ten, ktorým sa prihlasuje do Teams.

## Vývoj

- Testy databázy (aj na GitHube pri každej zmene):
  `psql -v ON_ERROR_STOP=1 -f test/net-stub.sql -f supabase/databaza.sql -f test/databaza.test.sql`
- Demo bez databázy: `python3 demo/build.py` → `demo/vajicka-demo.html`.
- `supabase/databaza.sql` sa dá spustiť opakovane – funkcie sa aktualizujú, dáta ostanú.
