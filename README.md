# Mahlzeiten-Rechner

Touch-first, dunkles Web-MVP zum Tracken der Tagesmakros (kcal, Protein, KH, Fett) plus Salz und Phase-A-Mikros.  
Live: **https://vsiemens87-rgb.github.io/mahlzeiten-rechner/**

Daten bleiben nur lokal im Browser (`localStorage` Schema v3, Migration aus v1/v2). Kein Backend, keine API-Keys.

## Ziel-Sync (`targets.json`)

Wochenziele liegen als **`targets.json`** im Pages-Root (gleiche Origin wie die App).

1. App lädt beim Start `targets.json?ts=…` (Cache-Bust).
2. Ist `updatedAt` neuer als zuletzt übernommen (`acceptedUpdatedAt`), erscheint das Banner **„Ziele aktualisiert“** mit **Übernehmen** / **Später** (plus weekLabel/source).
3. **Übernehmen** setzt Makros für den aktuellen Tagestyp (Training/Ruhe), speichert Soft-Mikros, merkt sich die Payload und `acceptedUpdatedAt`.
4. Tagestyp **Training / Ruhe** umschalten → Makros aus der zuletzt übernommenen Payload; manuelle Edits auf dem Ziele-Panel bleiben bis zum nächsten Übernehmen.
5. Fetch fehlgeschlagen → manuelle Ziele bleiben; kurzer Soft-Toast, kein Crash.

PT/CoS kann die Datei wöchentlich ersetzen (gleiche Feldnamen: `macros.training|rest`, `micros.*`, `updatedAt`, `weekLabel`, `dayType`, `source`, `notes`).

## Ziele setzen (manuell)

1. Unten **Ziele** öffnen.
2. kcal, Protein (g), Kohlenhydrate (g) und Fett (g) eintragen.
3. **Ziele speichern** – überschreibt bis zum nächsten Sync-Übernehmen.

Soft-Mikros (Salz-Max, Zucker hart/soft, Ballast-Min, Phase‑B-Caps) kommen nur aus dem Sync; die Tages-UI vergleicht vorhandene Summen – **keine erfundenen Nährwerte**.

## Produkt erfassen

Über **+** / **Hinzufügen**:

1. **Barcode scannen** – empfohlen. Open Food Facts (Nährwerte pro 100 g inkl. Salz/Mikros).
2. **Produkt suchen** – Textsuche in Open Food Facts (ohne Barcode) plus lokale **Grundprodukte** (Gemüse/Obst/Fleisch/Gewürze). DE-Namen + Synonyme; Grundprodukte zuerst mit Badge; Treffer → gleiches Korrektur-Sheet.
3. **Nährwerttabelle fotografieren** – Tabelle zuschneiden, dann OCR (Tesseract.js). Gutes Licht, scharfer Fokus.
4. **Manuell** – Name und Werte selbst eingeben.
5. **Gespeichertes Produkt** – aus lokaler Bibliothek wählen.
6. **Rezepte** – Zutaten + Mengen → Portion berechnen → **Rezept essen**.

## Salz

- OFF: Feld `salt_100g`, falls fehlend und nur Natrium da: **Salz ≈ Natrium × 2.5** (Hinweis im Korrektur-Sheet).
- Salz wird wie andere Makros mit der Gramm-Menge skaliert und in Tages-Summe / Einträgen gezeigt.

## Mikros (ehrlich)

- **Phase A** (tracken + skalieren): Zucker, gesättigte Fettsäuren, Ballaststoffe, Salz – Soft-Ziele nach Sync.
- **Phase B** (nur anzeigen): z. B. Vitamin C, Calcium, Eisen, Magnesium, Kalium – wenn OFF/manuell Werte liefert, sonst **„—“**. Es werden **keine** Zahlen erfunden. Soft-Ziele nur gegen vorhandene Tages-Summen.

## OCR-Tipps

- Rahmen auf die **Nährwerttabelle** ziehen (nicht das ganze Packungsfoto).
- Helles, gleichmäßiges Licht; Spiegelungen vermeiden.
- Wenn nichts erkannt wird: Hinweis **„Nichts erkannt — bitte manuell eingeben“**, Felder bleiben leer/editierbar.
- Barcode bleibt der zuverlässigste Weg.

## Produkte & Rezepte

- Beim Speichern optional **Als Produkt speichern** (Name, optional Barcode, Nährwerte/100 g inkl. Salz + Phase A/B).
- Rezept = mehrere Produkte mit Mengen + Portionszahl → Makros (+ Salz/Mikros) **pro Portion**.
- Alles in derselben localStorage-Struktur (Schema v3); alte Tages-Einträge werden migriert.

## Korrektur vor dem Speichern

Nach Scan/OCR/Rezept erscheint immer ein **Vorschau-Sheet** mit allen Feldern (inkl. Phase A/B). Nie blind speichern.

## Grenzen

- OCR bleibt fehleranfällig trotz Zuschnitt/Kontrast.
- Kamera braucht HTTPS + Berechtigung.
- OFF deckt Frischware oft schlecht ab; deshalb lokale **Grundprodukt**-Seed-Werte (Näherung USDA/BLS-artig, im Sheet korrigierbar).
- OFF-Textsuche: Rate-Limits, Host-Fallback (`world`/`de`), Synonyme, Treffer mit Nährwerten bevorzugt; AbortController + Debounce.
- Browser-Daten löschen = alles weg.
- Sync nur wenn `targets.json` erreichbar; Vitamin D / Zink-Caps werden gespeichert, aber nur angezeigt wenn später getrackt.

## Technik

Statisch für GitHub Pages. CDN (lazy): html5-qrcode, Tesseract.js – weiterhin nur on-demand, kein blockierendes Defer vor `app.js`. Lokale Seed: `grundprodukte.js`. OFF Produkt: `world.openfoodfacts.org/api/v2/product/{code}.json`; Textsuche: `cgi/search.pl?json=1` (cc/lc=de, Host-Fallback de.openfoodfacts.org). Version **v2.2.1**.
