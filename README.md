# MerkMealPrep

Wochenplan, Rezepte und Einkaufsliste für zwei. Läuft als Web-App (auch installierbar auf dem Home-Bildschirm, mit Offline-Hülle).

- `index.html` – die App
- `manifest.webmanifest`, `sw.js`, `icon*.svg`, `icons/`, `apple-touch-icon.png` – App-Name, Icon, Offline-Hülle
- `worker/worker.js` – optionaler Server für Link-/Foto-Import, KI-Ideen und Nährwert-Schätzung (Cloudflare Worker, Anleitung in der Datei)

Gemeinsame Daten: Supabase (Konto + Haushalt mit Einladungscode, Zugriff per Row Level Security).
Der im Code stehende Schlüssel ist der öffentliche „anon“-Key und für Browser-Apps vorgesehen.
