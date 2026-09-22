# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some Oxlint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

# atelier. Produktverwaltung

Webbasierte Produktseite mit öffentlicher Katalogansicht und geschützter Verwaltung.

## Start

```bash
npm install
npm run dev:full
```

Die öffentliche Seite läuft anschließend unter `http://localhost:5173`. Die Verwaltung ist über den Link `Admin` erreichbar. Der initiale Benutzername ist `admin`; das initiale Passwort wird nur als bcrypt-Hash angelegt und kann über `ADMIN_PASSWORD_HASH` ersetzt werden.

Produktdaten liegen dauerhaft in `data/catalog.sqlite`, Uploads in `data/uploads`. Beide Pfade gehören zur serverseitigen Datenhaltung und sollten in einer produktiven Umgebung gesichert und regelmäßig backupt werden.

Für einen Produktionsbuild:

```bash
npm run build
npm run server
```
