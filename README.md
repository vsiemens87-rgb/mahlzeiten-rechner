# Mahlzeiten-Rechner

Touch-first, dunkles Web-MVP zum Tracken der Tagesmakros (kcal, Protein, KH, Fett).  
Live: **https://vsiemens87-rgb.github.io/mahlzeiten-rechner/**

Daten bleiben nur lokal im Browser (`localStorage`). Kein Backend, keine API-Keys.

## Ziele setzen

1. Unten **Ziele** öffnen.
2. kcal, Protein (g), Kohlenhydrate (g) und Fett (g) eintragen.
3. **Ziele speichern** – Werte bleiben auf dem Gerät.

## Produkt erfassen

Über **+** / **Hinzufügen**:

1. **Barcode scannen** – Kamera auf den Code richten. Daten kommen von Open Food Facts (Nährwerte pro 100 g). Fehlen Daten → manuell oder OCR.
2. **Nährwerttabelle fotografieren** – Foto der Tabelle; OCR (Tesseract.js) versucht kcal / Protein / KH / Fett zu lesen.
3. **Manuell** – Name und Werte selbst eingeben.

## Korrektur vor dem Speichern

Nach Scan/OCR erscheint immer ein **Vorschau-Sheet**. Werte und Gramm-Menge prüfen/korrigieren, dann speichern. Es wird nie blind gespeichert.

## Tages-Summe

Unter **Heute** siehst du Summe vs. Ziele und Rest bzw. Überschuss. Einträge des heutigen Tages lassen sich löschen. Optional: die letzten paar Tage im Verlauf.

## Grenzen

- **OCR** ist fehleranfällig – Label-Layout, Blur, Spiegelungen. Immer im Vorschau-Sheet korrigieren.
- **Kamera** braucht HTTPS und die Kamera-Berechtigung im Browser.
- **Open Food Facts** deckt nicht jedes Produkt ab; EU/DE-Daten werden bevorzugt, falls vorhanden.
- Alles lokal – Browser-Daten löschen = Einträge weg.

## Technik

Statisches Multi-File-Projekt für GitHub Pages. CDN: html5-qrcode, Tesseract.js. OFF: `world.openfoodfacts.org/api/v2/product/{code}.json`.
