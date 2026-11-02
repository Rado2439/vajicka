# Vajíčka – spoločné objednávanie vajíčok

Webová aplikácia vo firemnom vizuále KROS (korporátny režim: KROS modrá, belasá, Poppins). Písmo a logo sú súčasťou projektu, nič sa neťahá z internetu. Node.js 20+, **žiadne závislosti** (netreba `npm install`).

## Spustenie

```bash
TEAMS_WEBHOOK_URL="https://…" APP_URL="https://vajicka.firma.sk" node server.js
# http://localhost:3000
```

| Premenná | Význam |
|---|---|
| `TEAMS_WEBHOOK_URL` | URL webhooku Teams (Workflows alebo Incoming Webhook) |
| `APP_URL` | verejná adresa aplikácie – v Teams správe bude tlačidlo „Otvoriť aplikáciu“ (nepovinné) |
| `ADMIN_PIN` | ak je nastavený, záložka Ľudia vyžaduje PIN |
| `PORT` | port (predvolene 3000) |
| `DATA_DIR` | priečinok s dátami (predvolene `./data`, súbor `db.json`) |
| `CONFIG_PATH` | cesta ku konfigurácii (predvolene `./config.json`) |

## Konfigurácia (`config.json`)

- `packSize`, `packPrice` – veľkosť a cena balenia (10 ks za 3 €). Cena sa pri vytvorení objednávky
  uloží do nej, takže zmena ceny neprepíše históriu.
- `deliveryWeekday` – deň dodania (0 = nedeľa … 3 = streda).
- `deadlineDaysBefore`, `deadlineTime` – uzávierka (1 deň pred dodaním o 20:00 = utorok 20:00).
- `timezone` – `Europe/Bratislava` (letný/zimný čas sa rieši automaticky).
- `openNextOn` – `"deadline"` = nová objednávka sa otvorí hneď po uzávierke, `"delivery"` = až v deň dodania.
- `reminderEnabled`, `reminderDaysBefore`, `reminderTime` – pondelková pripomienka (pozri nižšie).
- `defaultQty` – rýchla voľba „Chcem 10 ks“.
- `autoSendWithinDays` – automatické odoslanie do Teams sa skúša len pri uzávierkach z posledných N dní.
- `people` – **len počiatočný zoznam** pri prvom spustení, ak neexistuje súbor `people.json` (ten má prednosť; je v `.gitignore`, aby skutočné mená a e-maily neboli v gite – formát `[{"name": "…", "email": "…", "supplier": true}]`, cesta sa dá zmeniť cez `PEOPLE_PATH`). Potom sa ľudia spravujú na obrazovke
  v záložke Ľudia: pridať, odobrať, premenovať, e-mail, výber zabezpečovateľa (🥚).
  Odobratá osoba ostáva v histórii.

## Ovládanie

- Záložky: Objednávka / Súhrn / História / Ľudia (na mobile ako spodná lišta); vpravo hore meno – klik = zmena mena.
- Množstvo len po celých baleniach (`packSize`, 10 ks): tlačidlá −10 / +10 alebo rýchla voľba 10–60 ks; ukladá sa automaticky. Server iný počet odmietne.
- „Zaplatil som“ – pri vlastnom riadku; zabezpečovateľ môže označiť platbu za hocikoho.
  Platby sa dajú meniť v otvorenej a poslednej uzavretej objednávke, staršie týždne sú len na čítanie.

## Pondelková pripomienka

Každý pondelok o 8:00 (`reminderDaysBefore: 2`, `reminderTime: "08:00"` – 2 dni pred stredou) príde do toho istého
Teams kanála (napr. „Vajka na stredu“) správa „Vajíčka na stredu …?“ s tlačidlom **Objednať**. Označí (@mention)
všetkých, ktorí ešte nemajú objednané a pripomienky si nevypli (ľudia bez e-mailu sú len vypísaní tučne).
Každý si to vypne prepínačom „Pripomínať mi v pondelok“ na obrazovke objednávky. Vypnúť pre všetkých:
`reminderEnabled: false`. Na skúšku sa dá poslať hneď tlačidlom „Poslať teraz“ v záložke Ľudia.
Pripomienka ide len raz za týždeň; ak server o 8:00 nebeží, pošle sa po štarte, najneskôr do 14:00.

## Teams a označenie (@mention) zabezpečovateľa

Po uzávierke server (kontrola každú minútu) pošle na `TEAMS_WEBHOOK_URL` **Adaptive Card** so súhrnom
(kto, koľko ks, spolu ks / balení / suma, nezaplatené). Pri neúspechu to skúsi znova (max. 5×);
chyba sa zobrazí v súhrne a dá sa použiť tlačidlo **„Poslať súhrn do Teams znova“**.

Označenie rieši karta cez `msteams.entities` typu `mention` s `<at>Meno</at>` a
`mentioned.id = e-mail (UPN)` zabezpečovateľa – preto vyplň v záložke Ľudia jeho e-mail
(presne ten, ktorým sa prihlasuje do Teams). Bez e-mailu sa meno len zvýrazní tučným písmom.

Odporúčaný webhook: skupina „vajká na stredu“ je **skupinový chat**, takže v Teams → Workflows použi šablónu **„Post to a chat when a webhook request is received“** a vyber tento chat (pre kanál by to bola „Post to a channel …“)
(staré O365 Incoming Webhooky Microsoft ruší). Workflow akceptuje presne tento formát
(`{"type":"message","attachments":[{adaptive card}]}`) a mention vykreslí ako skutočné označenie s notifikáciou.
Ak by chcel zabezpečovateľ správu dostávať osobne, stačí vo Workflow zvoliť „post in a chat with Flow bot“.

## Poznámky

- Identifikácia je bez hesla (dôvera v skupine) – server kontroluje len to, že platbu za iného
  mení zabezpečovateľ, ale meno si v prehliadači môže vybrať ktokoľvek.
- Dáta sú v `data/db.json` (atomický zápis) – stačí ho zálohovať.
- Testy: `npm test` (spúšťajú sa aj automaticky na GitHube).
- Demo bez servera: `python3 demo/build.py` vytvorí `demo/vajicka-demo.html` (simulované dáta).

## Nasadenie (aby to kolegovia mali na webovej adrese)

Appka potrebuje stále bežiaci server s **trvalým diskom** pre `db.json`.

**A) Render.com (dá sa aj z mobilu)**
1. Nahraj projekt do GitHub repozitára.
2. render.com → prihlásenie cez GitHub → **New → Blueprint** → vyber repozitár (použije `render.yaml`).
3. Vyplň `TEAMS_WEBHOOK_URL`, voliteľne `ADMIN_PIN` a `APP_URL` (adresa, ktorú Render pridelí, napr. `https://vajicka.onrender.com`).
4. Cena: plán Starter + 1 GB disk ≈ 7–8 USD mesačne. Free plán nemá trvalý disk – dáta by sa pri reštarte stratili.

**B) Firemný server / Azure (cez IT)** – priložený `Dockerfile`:
```bash
docker build -t vajicka .
docker run -d -p 3000:3000 -v vajicka-data:/data -e TEAMS_WEBHOOK_URL=... vajicka
```

**Prvé spustenie:** ak je vedľa servera `people.json`, ľudia sa načítajú z neho. Inak je zoznam prázdny – v záložke Ľudia je „Hromadne pridať viac ľudí“ (riadky `Meno; email`), alebo Otvor adresu → „Pridať ľudí“, alebo pošli odkaz kolegom
a každý sa pridá sám („Nie si v zozname? Pridaj sa“). Potom v záložke Ľudia označ zabezpečovateľa a vyplň mu e-mail
kvôli @označeniu v Teams. Ak nastavíš `ADMIN_PIN`, pridávať ľudí môže len ten, kto pozná PIN.
