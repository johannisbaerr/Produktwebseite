# Amspind

Webbasierter Produktkatalog mit Kategorien, Warenkorb, teilbaren Bestellungen und geschützter Verwaltung.

## Start

```bash
npm install
npm run dev:full
```

Die öffentliche Seite läuft anschließend unter `http://localhost:5173`. Die Verwaltung ist über `Admin-Anmeldung` erreichbar. Der initiale Benutzername ist `admin`; das initiale Passwort wird nur als bcrypt-Hash angelegt und kann über `ADMIN_PASSWORD_HASH` ersetzt werden.

Produktdaten und Produktbilder liegen dauerhaft in Supabase. Lege die Variablen aus `.env.example` in einer lokalen `.env`-Datei oder später als Environment Variables beim Hosting an. Der `SUPABASE_SERVICE_ROLE_KEY` ist geheim und darf niemals ins Frontend oder Repository gelangen.

Die Tabellen `products`, `product_images`, `admins` und `sessions` sowie der Storage-Bucket `product-images` müssen zuvor im Supabase SQL Editor angelegt worden sein. Wende danach die SQL-Migrationen in `supabase/migrations/` der Reihe nach im Supabase SQL Editor an. Sie ergänzen Kategorien, Bestellungen, dynamische Suchbegriffe und das einmalige Abbuchen der Bestellmengen. Die Migrationen müssen vor dem Start der aktualisierten App ausgeführt werden.

Produkte können zusätzliche, kommagetrennte Suchbegriffe in der Verwaltung erhalten. Namen, Beschreibung, Kategorie und diese Suchbegriffe werden gemeinsam für eine fehlertolerante Suche verwendet; neue Produkte werden dadurch ohne Codeänderung suchbar.

Bestelllinks enthalten einen zufälligen Zugriffsschlüssel. Die Produktdaten der Bestellung werden serverseitig als Momentaufnahme gespeichert und sind ausschließlich über eine aktive Admin-Sitzung abrufbar. Der Link allein gewährt keinen Einblick in die Bestellung.

Beim Öffnen eines Bestelllinks fragt die Admin-Ansicht, ob die bestellten Mengen vom Lagerbestand abgezogen werden sollen. Die serverseitige Transaktion verhindert Mehrfachabbuchungen und bucht nur ab, wenn der aktuelle Bestand für alle Artikel ausreicht.

Die Hauptfarben sind als CSS-Variablen am Anfang von `src/App.css` definiert und können zentral angepasst werden.

Für einen Produktionsbuild:

```bash
npm run build
npm run server
```
