/*
 * Essensplaner – kleiner Server für „Link importieren“ und „Foto auslesen“
 * (Cloudflare Worker, kostenloser Tarif reicht)
 *
 * Einrichten (einmalig, ca. 10 Minuten):
 * 1. Kostenloses Konto auf dash.cloudflare.com anlegen.
 * 2. „Workers & Pages“ → „Worker erstellen“ → Namen vergeben (z. B. essensplaner) → Deploy.
 * 3. „Code bearbeiten“, den gesamten Inhalt dieser Datei einfügen, speichern, deployen.
 * 4. Unter „Einstellungen → Variablen und Geheimnisse“ anlegen (Typ „Secret“):
 *      APP_TOKEN       = ein selbst gewähltes Zugangswort (das tragt ihr in der App ein)
 *      GEMINI_API_KEY  = kostenloser Key von aistudio.google.com (nur für Foto und als Fallback beim Link)
 *    Optional (Text):
 *      GEMINI_MODEL    = Modellname, falls der Standard nicht klappt (Standard: gemini-3.5-flash-lite)
 *      ALLOWED_ORIGIN  = Adresse eurer Seite, z. B. https://dein-name.github.io
 * 5. Die Worker-Adresse (https://essensplaner.<name>.workers.dev) und das Zugangswort
 *    in der App unter „Neu → Verbindung“ eintragen.
 *
 * Link-Import liest zuerst die strukturierten Rezeptdaten (schema.org) der Seite – ohne KI.
 * Nur wenn die Seite keine hat und ein Gemini-Key hinterlegt ist, liest die KI den Seitentext.
 */

const cors = (o) => ({
  'Access-Control-Allow-Origin': o,
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,X-App-Token',
});
const out = (obj, status, h) => new Response(JSON.stringify(obj), { status, headers: h });

export default {
  async fetch(req, env) {
    const h = { ...cors(env.ALLOWED_ORIGIN || '*'), 'Content-Type': 'application/json' };
    if (req.method === 'OPTIONS') return new Response(null, { headers: h });
    if (req.method !== 'POST') return out({ error: 'POST erwartet' }, 405, h);
    if (!env.APP_TOKEN || req.headers.get('X-App-Token') !== env.APP_TOKEN)
      return out({ error: 'Zugangswort stimmt nicht' }, 401, h);
    let body;
    try { body = await req.json(); } catch { return out({ error: 'Ungültige Anfrage' }, 400, h); }
    const path = new URL(req.url).pathname;
    if (body && typeof body.model === 'string' && /^[a-z0-9.\-]+$/.test(body.model)) env = { ...env, GEMINI_MODEL: body.model };
    try {
      if (path === '/diag') {
        const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=100', {
          headers: { 'x-goog-api-key': env.GEMINI_API_KEY || '' },
          signal: AbortSignal.timeout(10000),
        });
        const j = await r.json().catch(() => ({}));
        return out({
          status: r.status,
          modell: env.GEMINI_MODEL || 'gemini-3.5-flash-lite (Standard)',
          flash: (j.models || []).map((m) => m.name.replace('models/', '')).filter((n) => /flash/.test(n)),
          fehler: j.error && j.error.message,
        }, 200, h);
      }
      if (path === '/idea') return out(await ideas(body, env), 200, h);
      if (path === '/nutri') return out(await nutri(body, env), 200, h);
      if (path === '/recipe') return out(await fromUrl(body.url, env), 200, h);
      if (path === '/photo') return out(await fromPhoto(body.image, body.mime || 'image/jpeg', env), 200, h);
      return out({ error: 'Unbekannter Pfad' }, 404, h);
    } catch (e) {
      const m = e && e.name === 'TimeoutError' ? 'Zeitüberschreitung – der Dienst hat nicht rechtzeitig geantwortet' : e.message;
      return out({ error: m }, 502, h);
    }
  },
};

/* ---------- Link ---------- */
export async function fromUrl(url, env) {
  let u;
  try { u = new URL(url); } catch { throw new Error('Ungültiger Link'); }
  if (!/^https?:$/.test(u.protocol) || /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(u.hostname))
    throw new Error('Dieser Link ist nicht erlaubt');
  const r = await fetch(u.toString(), {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
      'Accept-Language': 'de-DE,de;q=0.9',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error('Seite nicht abrufbar (' + r.status + ')');
  const html = await r.text();
  const ld = extractRecipe(html);
  if (ld && ld.ings.length) return ld;
  if (!env.GEMINI_API_KEY) throw new Error('Auf der Seite wurden keine Rezeptdaten gefunden.');
  const text = html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<nav[\s\S]*?<\/nav>|<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, 20000);
  return normalize(await gemini([{ text: PROMPT + '\n\nSeitentext:\n' + decode(text) }], env));
}

export function extractRecipe(html) {
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    let data;
    try { data = JSON.parse(m[1].trim()); } catch { continue; }
    const node = findRecipe(data);
    if (node) return fromLd(node);
  }
  return null;
}
function findRecipe(d) {
  if (!d) return null;
  if (Array.isArray(d)) { for (const x of d) { const r = findRecipe(x); if (r) return r; } return null; }
  if (typeof d !== 'object') return null;
  const t = [].concat(d['@type'] || []);
  if (t.includes('Recipe')) return d;
  if (d['@graph']) return findRecipe(d['@graph']);
  return null;
}
function fromLd(n) {
  return {
    title: decode(String(n.name || '')),
    serv: yieldNum(n.recipeYield),
    min: minutes(n.totalTime) || (minutes(n.prepTime) + minutes(n.cookTime)) || 30,
    ings: [].concat(n.recipeIngredient || []).map((s) => decode(String(s)).trim()).filter(Boolean),
    steps: steps(n.recipeInstructions),
  };
}
function yieldNum(y) {
  const s = [].concat(y || [])[0];
  const m = String(s || '').match(/\d+/);
  return m ? +m[0] : 2;
}
function minutes(iso) {
  const m = String(iso || '').match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/i);
  return m ? (+m[1] || 0) * 1440 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0;
}
function steps(i) {
  if (!i) return [];
  if (typeof i === 'string') return decode(i).split(/\n+/).map((s) => s.trim()).filter(Boolean);
  return [].concat(i).flatMap((x) => {
    if (typeof x === 'string') return [decode(x).trim()];
    if (x.itemListElement) return steps(x.itemListElement);
    return x.text ? [decode(String(x.text)).trim()] : [];
  }).filter(Boolean);
}
export function decode(s) {
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, c) => String.fromCharCode(+c))
    .replace(/&#x([0-9a-f]+);/gi, (_, c) => String.fromCharCode(parseInt(c, 16)))
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ');
}

/* ---------- Foto / KI ---------- */
const PROMPT =
  'Lies das Rezept aus und antworte NUR mit JSON in diesem Format: ' +
  '{"title":"...","serv":Zahl Portionen,"min":Gesamtminuten als Zahl,"ings":["200 g Mehl","2 Stk Ei"],"steps":["Schritt 1","Schritt 2"]}. ' +
  'Regeln: Deutsch; Mengen als Zahl + Einheit (g, ml, Stk, EL, TL), ohne Brüche mit Text; eine Zutat pro Eintrag; ' +
  'nichts erfinden – was nicht erkennbar ist, weglassen; wenn keine Portionen genannt sind, 2.';

export async function fromPhoto(b64, mime, env) {
  if (!b64) throw new Error('Kein Bild empfangen');
  if (!env.GEMINI_API_KEY) throw new Error('Auf dem Server fehlt der GEMINI_API_KEY');
  return normalize(await gemini([{ text: PROMPT }, { inline_data: { mime_type: mime, data: b64 } }], env));
}
async function gemini(parts, env, temp = 0.1) {
  const model = env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
    body: JSON.stringify({ contents: [{ parts }], generationConfig: { responseMimeType: 'application/json', temperature: temp } }),
    signal: AbortSignal.timeout(40000),
  });
  if (!r.ok) throw new Error('KI-Dienst: Fehler ' + r.status + ' ' + (await r.text()).slice(0, 160));
  const d = await r.json();
  const t = (d.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
  try { return JSON.parse(t); } catch { throw new Error('KI-Antwort nicht lesbar'); }
}
function normalize(j) {
  const arr = (a) => (Array.isArray(a) ? a.map(String).filter(Boolean) : []);
  return { title: String(j.title || ''), serv: +j.serv || 2, min: +j.min || 30, ings: arr(j.ings), steps: arr(j.steps) };
}

/* ---------- Rezeptideen aus Vorräten / Wünschen ---------- */
export async function ideas(b, env) {
  if (!env.GEMINI_API_KEY) throw new Error('Auf dem Server fehlt der GEMINI_API_KEY');
  const clip = (s, n) => String(s || '').slice(0, n);
  const who = (Array.isArray(b.groups) ? b.groups : []).slice(0, 6)
    .map((g) => `- ${clip(g.who, 40)}: ${clip(g.diet, 20)}${g.exclude ? '; isst nicht: ' + clip(g.exclude, 80) : ''}`).join('\n');
  const prompt =
    'Schlage ein einfaches, alltagstaugliches Abendessen vor. ' +
    `Zutaten zuhause: ${clip(b.have, 300) || 'keine Angabe'}. Lust auf: ${clip(b.wish, 200) || 'keine Angabe'}.\n` +
    `Es essen mit:\n${who || '- 2 Personen: alles'}\n` +
    'Alle sitzen am selben Tisch. Gib pro unterschiedlicher Ernährungsform (alles/vegetarisch/vegan) EIN Rezept zurück, ' +
    'möglichst mit gleicher Basis, damit man zusammen kocht; wenn alle gleich essen, nur ein Rezept. ' +
    'Antworte NUR mit JSON: {"recipes":[{"who":"Namen der Personen","diet":"fleisch|vegetarisch|vegan","title":"...","serv":Portionen für diese Personen,"min":Gesamtminuten,"ings":["200 g Mehl","2 Stk Ei"],"steps":["..."]}]}. ' +
    'Regeln: Deutsch; Mengen als Zahl + Einheit (g, ml, Stk, EL, TL); Zutaten möglichst aus der Liste, Grundzutaten wie Öl, Salz, Gewürze dürfen ergänzt werden; ' +
    'nichts verwenden, was jemand nicht isst; „fleisch“ nur, wenn Fleisch oder Fisch enthalten ist.';
  const j = await gemini([{ text: prompt }], env, 0.7);
  let arr = Array.isArray(j) ? j : Array.isArray(j.recipes) ? j.recipes : Object.values(j || {}).find(Array.isArray) || [];
  if (!arr.length && j && j.title) arr = [j];
  arr = arr.filter((r) => r && typeof r === 'object' && r.title);
  if (!arr.length) throw new Error('Die KI hat kein Rezept geliefert (' + Object.keys(j || {}).join(', ').slice(0, 80) + ')');
  return {
    recipes: arr.slice(0, 4).map((r) => ({
      ...normalize(r),
      who: clip(r.who, 80),
      diet: ['vegan', 'vegetarisch', 'fleisch'].includes(r.diet) ? r.diet : 'vegetarisch',
    })),
  };
}

/* ---------- Nährwerte unbekannter Zutaten schätzen ---------- */
export async function nutri(b, env) {
  if (!env.GEMINI_API_KEY) throw new Error('Auf dem Server fehlt der GEMINI_API_KEY');
  const names = (Array.isArray(b.names) ? b.names : []).map((n) => String(n).slice(0, 60)).filter(Boolean).slice(0, 15);
  if (!names.length) throw new Error('Keine Zutaten übergeben');
  const prompt =
    'Gib typische Nährwerte für diese Zutaten an, jeweils pro 100 g (bei Flüssigkeiten pro 100 ml). ' +
    'Rohe bzw. unverarbeitete Ware; bei trockenen Produkten (Nudeln, Reis, Linsen, Mehl) das Trockengewicht. Zutaten:\n' +
    names.map((n, i) => `${i + 1}. ${n}`).join('\n') +
    '\nAntworte NUR mit JSON: {"items":[{"name":"<genau wie oben>","k":kcal,"p":Eiweiß g,"c":Kohlenhydrate g,"f":Fett g,' +
    '"aisle":"Obst & Gemüse|Kühlregal|Fleisch|Trockenwaren & Konserven|Brot & Backwaren|Vorrat & Gewürze",' +
    '"stk":Gramm pro Stück, falls man die Zutat stückweise kauft, sonst 0,"ml":true wenn Flüssigkeit sonst false}]}. ' +
    'Gewürze und getrocknete Kräuter: aisle "Vorrat & Gewürze".';
  const j = await gemini([{ text: prompt }], env);
  const arr = Array.isArray(j) ? j : Array.isArray(j && j.items) ? j.items : [];
  const num = (v, max) => { const x = Number(v); return isFinite(x) ? Math.min(Math.max(x, 0), max) : 0; };
  const AIS = ['Obst & Gemüse', 'Kühlregal', 'Fleisch', 'Trockenwaren & Konserven', 'Brot & Backwaren', 'Vorrat & Gewürze'];
  return {
    items: names.map((n, i) => {
      const r = arr.find((x) => x && String(x.name).toLowerCase() === n.toLowerCase()) || arr[i] || {};
      return {
        name: n,
        k: Math.round(num(r.k, 900)),
        p: Math.round(num(r.p, 100) * 10) / 10,
        c: Math.round(num(r.c, 100) * 10) / 10,
        f: Math.round(num(r.f, 100) * 10) / 10,
        aisle: AIS.includes(r.aisle) ? r.aisle : 'Sonstiges',
        stk: Math.round(num(r.stk, 2000)),
        ml: !!r.ml,
      };
    }),
  };
}
