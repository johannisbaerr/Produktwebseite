# shop Produktverwaltung

Webbasierte Produktseite mit öffentlicher Katalogansicht und geschützter Verwaltung.

## Start

```bash
npm install
npm run dev:full
```

Die öffentliche Seite läuft anschließend unter `http://localhost:5173`. Die Verwaltung ist über den Link `Admin` erreichbar. Der initiale Benutzername ist `admin`; das initiale Passwort wird nur als bcrypt-Hash angelegt und kann über `ADMIN_PASSWORD_HASH` ersetzt werden.

Produktdaten und Produktbilder liegen dauerhaft in Supabase. Lege die Variablen aus `.env.example` in einer lokalen `.env`-Datei oder später als Environment Variables beim Hosting an. Der `SUPABASE_SERVICE_ROLE_KEY` ist geheim und darf niemals ins Frontend oder Repository gelangen.

Die Tabellen `products`, `product_images`, `admins` und `sessions` sowie der Storage-Bucket `product-images` müssen zuvor im Supabase SQL Editor angelegt worden sein.

Für einen Produktionsbuild:

```bash
npm run build
npm run server
```
