# Amspind

Webbasierter Produktkatalog mit Kategorien, Warenkorb, teilbaren Bestellungen und geschützter Verwaltung.

## Start

```bash
npm install
npm run dev:full
```

Die öffentliche Seite läuft anschließend unter `http://localhost:5173`. Die Verwaltung ist über `Admin-Anmeldung` erreichbar. Der initiale Benutzername ist `admin`; das initiale Passwort wird nur als bcrypt-Hash angelegt und kann über `ADMIN_PASSWORD_HASH` ersetzt werden.

Produktdaten und Produktbilder liegen dauerhaft in Supabase. Lege die Variablen aus `.env.example` in einer lokalen `.env`-Datei oder später als Environment Variables beim Hosting an. Der `SUPABASE_SERVICE_ROLE_KEY` ist geheim und darf niemals ins Frontend oder Repository gelangen.

Die Tabellen `products`, `product_images`, `admins` und `sessions` sowie der Storage-Bucket `product-images` müssen zuvor im Supabase SQL Editor angelegt worden sein. Wende danach diese SQL-Migrationen in der angegebenen Reihenfolge im Supabase SQL Editor an:

1. `supabase/migrations/202610190001_amspind_shop_features.sql`
2. `supabase/migrations/202610190002_order_stock_fulfillment.sql`
3. `supabase/migrations/202610200001_category_design_settings.sql`
4. `supabase/migrations/202610200002_category_product_order.sql`
5. `supabase/migrations/202610200003_private_product_originals.sql`
6. `supabase/migrations/202610200004_product_customizations.sql`

Die Migrationen ergänzen Kategorien, Bestellungen, dynamische Suchbegriffe, Kategorie-Designoptionen, individuelle Produktsortierung je Kategorie, das einmalige Abbuchen der Bestellmengen, den privaten Speicher für Produktoriginale und Produkt-Anpassungen mit lagergeführten Extras. Sie müssen vor dem Start der aktualisierten App ausgeführt werden. Fehlt Migration 003, bleiben die Kategorien mit Standarddesign verfügbar. Migration 004 wird benötigt, damit die Produktsortierung je Kategorie gespeichert werden kann. Migration 005 erstellt den privaten Supabase-Storage-Bucket für Originalbilder. Migration 006 richtet Extras, Produktzuordnungen und das Abbuchen der Extra-Bestände ein.

Wenn die öffentliche Seite meldet, dass Kategorien nicht geladen werden können, oder die Verwaltung trotz vorhandener Produkte einen Datenbankfehler anzeigt, öffne in Supabase den **SQL Editor** und führe alle Dateien aus `supabase/migrations/` der Reihe nach aus. Danach müssen die Änderungen am Server und an der Webseite veröffentlicht werden. Solange die Shop-Migration fehlt, kann die öffentliche Seite vorhandene Produkte weiterhin über „Alle Produkte“ anzeigen; die selbst verwalteten Kategorien benötigen die Migration.

Produkte können zusätzliche, kommagetrennte Suchbegriffe in der Verwaltung erhalten. Namen, Beschreibung, Kategorie und diese Suchbegriffe werden gemeinsam für eine fehlertolerante Suche verwendet; neue Produkte werden dadurch ohne Codeänderung suchbar.

Produktbilder werden beim Hinzufügen standardmäßig unverändert übernommen; im Produktformular kann die Freistellung optional eingeschaltet werden. Das Original wird immer zusätzlich im privaten Supabase-Bucket `product-originals` gespeichert; nur angemeldete Admins erhalten zeitlich begrenzte Links. Bei der Freistellung läuft das IS-Net-Modell lokal im Browser in einem Web Worker und lädt das Shop-Bild als WebP mit transparentem Hintergrund hoch. Beim ersten Einsatz lädt der Browser das quantisierte Modell (ca. 46 MB) von [Hugging Face](https://huggingface.co/Ko033/isnet-general-use-onnx); die ausgewählten Originaldateien werden nicht an einen externen Bilddienst geschickt. Im Admin lassen sich unter **Bilder freistellen** Produkte suchen und gezielt auswählen. Bereits freigestellte Bilder werden dabei übersprungen; einzelne Produktbilder können im Produktdialog ausdrücklich anhand ihres gespeicherten Originals aktualisiert oder gelöscht werden. Das Modell und seine IS-Net-Grundlage sind unter Apache-2.0 ausgewiesen. Die Freistellung benötigt eine Internetverbindung für den erstmaligen Modellabruf.

Kategorie-Farbregler sind entfernt. Alle Kategorie-Karten verwenden das Standard-Farbschema von „Alle Produkte“ (heller Hintergrund, dunkle Schrift und dezenter Rahmen).

Für jede Kategorie und „Alle Produkte“ lässt sich im Admin das Kartenlayout anpassen. Alle Karten verwenden dasselbe Farbschema wie „Alle Produkte“. Die Produktsortierung befindet sich innerhalb der jeweiligen Kategorie und wird separat gespeichert.

Extras werden im Admin unter **Extras** angelegt und verwaltet. Sie sind nicht als eigene Produkte im öffentlichen Shop gelistet. In einem Produkt kann **Anpassungen anbieten** eingeschaltet und die gewünschten Extras ausgewählt werden. Im Shop öffnet **Anpassen** die Auswahl, inklusive „Nein danke“. Extra-Preise werden bei der Bestellung serverseitig übernommen; Produkt- und Extra-Lagerbestände werden beim späteren Abbuchen der Bestellung gemeinsam geprüft und reduziert.

Bestelllinks enthalten einen zufälligen Zugriffsschlüssel. Die Produktdaten der Bestellung werden serverseitig als Momentaufnahme gespeichert und sind ausschließlich über eine aktive Admin-Sitzung abrufbar. Der Link allein gewährt keinen Einblick in die Bestellung.

Beim Öffnen eines Bestelllinks fragt die Admin-Ansicht, ob die bestellten Mengen vom Lagerbestand abgezogen werden sollen. Die serverseitige Transaktion verhindert Mehrfachabbuchungen und bucht nur ab, wenn der aktuelle Bestand für alle Artikel ausreicht.

Die Hauptfarben sind als CSS-Variablen am Anfang von `src/App.css` definiert und können zentral angepasst werden.

Für einen Produktionsbuild:

```bash
npm run build
npm run server
```
