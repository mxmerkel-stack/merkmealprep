# MerkMealPrep

Essensplaner für zwei: Profile, Wochenplan, Rezepte, Einkaufsliste, Historie, Favoriten.

- `index.html` – die App (statische Seite, läuft auf GitHub Pages)
- `worker/worker.js` – optionaler Server für Link- und Foto-Import (Cloudflare Worker, Anleitung in der Datei)

Gemeinsame Daten: Supabase (Konto + Haushalt mit Einladungscode, Zugriff per Row Level Security).
Der im Code stehende Schlüssel ist der öffentliche „anon“-Key und für Browser-Apps vorgesehen.
