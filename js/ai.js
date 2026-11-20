// KI-Schicht: ein Aufruf, drei Anbieter (Claude, Gemini, OpenAI)
import { store } from './store.js';

export const BASE_RULES = `Du bist ein Lernassistent für eine Jusstudentin in Österreich.
Verbindliche Regeln:
- Es gilt ausschließlich ÖSTERREICHISCHES Recht (ABGB, UGB, KSchG, ZPO, StGB, B-VG usw.). Niemals deutsches Recht (BGB, StGB-D, ZPO-D) oder deutsche Terminologie verwenden. Österreichische Fachsprache verwenden (z. B. "Gewährleistung", "Schadenersatz", "Anspruchsgrundlage", "OGH").
- Der Prüfungsstoff ist AUSSCHLIESSLICH der Inhalt der bereitgestellten Lehrbuchtexte. Füge keinen Stoff hinzu, der dort nicht steht, und lass nichts Wesentliches weg. Wenn etwas im Lehrbuch nicht vorkommt, sag das ausdrücklich.
- Belege Aussagen mit Seitenangaben im Format [S. 123] gemäß den Seitenmarkierungen im Text.
- Antworte auf Deutsch, klar, präzise und prüfungsorientiert.
- Wenn du Prüfungsfragen, Karteikarten, Fälle oder Tests erstellst: Frage AUSSCHLIESSLICH juristischen Inhalt ab – Rechtsinstitute, Begriffe und Definitionen, Voraussetzungen, Rechtsfolgen, Abgrenzungen, Ausnahmen, Zusammenhänge, Wertungen und die Anwendung auf konkrete Sachverhalte. Verstehe den Sinn des Kapitels und prüfe, ob die Studentin ihn verstanden hat.
- NIEMALS fragen nach: Aufbau oder Gliederung des Buchs, Inhaltsverzeichnis/Inhaltsübersicht, Kapitel- oder Abschnittsnummern und -titeln, Seitenzahlen, Randziffern, Autorinnen/Autoren, Auflage, Vorwort, Literaturhinweisen oder Abkürzungen. Solche Textteile ignorierst du vollständig.`;

function cfg() {
  const s = store.state.settings;
  const p = s.provider || 'anthropic';
  return { provider: p, key: s.keys[p], models: s.models[p] };
}

export function aiReady() {
  const c = cfg();
  return !!c.key;
}

// messages: [{role:'user'|'assistant', content:string}]
export async function complete({ system = '', messages, model = 'smart', maxTokens = 4000, json = false, cacheSystem = true, signal } = {}) {
  const c = cfg();
  if (!c.key) throw new Error('Kein KI-Schlüssel hinterlegt. Bitte in den Einstellungen eintragen.');
  const sys = system ? BASE_RULES + '\n\n' + system : BASE_RULES;
  const modelName = c.models[model] || c.models.smart;
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (c.provider === 'anthropic') return await anthropic(c.key, modelName, sys, messages, maxTokens, cacheSystem, signal);
      if (c.provider === 'gemini') return await gemini(c.key, modelName, sys, messages, maxTokens, json, signal);
      if (c.provider === 'openai') return await openai(c.key, modelName, sys, messages, maxTokens, json, signal);
      throw new Error('Unbekannter KI-Anbieter');
    } catch (e) {
      lastErr = e;
      if (e.name === 'AbortError' || !e.retry) throw e;
      await new Promise(r => setTimeout(r, 2000 * (attempt + 1) ** 2));
    }
  }
  throw lastErr;
}

async function httpErr(res, label) {
  let msg = `${label}: ${res.status}`;
  try { const j = await res.json(); msg += ' – ' + (j.error?.message || JSON.stringify(j.error || j)); } catch {}
  const e = new Error(msg);
  e.retry = res.status === 429 || res.status >= 500 || res.status === 529;
  return e;
}

async function anthropic(key, model, system, messages, maxTokens, cacheSystem, signal) {
  const body = {
    model, max_tokens: maxTokens,
    system: [{ type: 'text', text: system, ...(cacheSystem && system.length > 4000 ? { cache_control: { type: 'ephemeral' } } : {}) }],
    messages: messages.map(m => ({ role: m.role, content: m.content }))
  };
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw await httpErr(res, 'Claude');
  const j = await res.json();
  return (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
}

async function gemini(key, model, system, messages, maxTokens, json, signal) {
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
    generationConfig: { maxOutputTokens: Math.max(maxTokens, 8000), ...(json ? { responseMimeType: 'application/json' } : {}) }
  };
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`, {
    method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  if (!res.ok) throw await httpErr(res, 'Gemini');
  const j = await res.json();
  return (j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
}

async function openai(key, model, system, messages, maxTokens, json, signal) {
  const body = {
    model,
    messages: [{ role: 'system', content: system }, ...messages],
    max_completion_tokens: Math.max(maxTokens, 6000),
    ...(json ? { response_format: { type: 'json_object' } } : {})
  };
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST', signal, headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + key }, body: JSON.stringify(body)
  });
  if (!res.ok) throw await httpErr(res, 'OpenAI');
  const j = await res.json();
  return j.choices?.[0]?.message?.content || '';
}

// JSON aus einer KI-Antwort herauslösen (robust gegen ```json-Blöcke und Text drumherum)
export function parseJson(text) {
  if (!text) throw new Error('Leere KI-Antwort');
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  try { return JSON.parse(t); } catch {}
  const start = Math.min(...['{', '['].map(c => { const i = t.indexOf(c); return i < 0 ? Infinity : i; }));
  if (start === Infinity) throw new Error('KI-Antwort enthielt kein JSON');
  const open = t[start], close = open === '{' ? '}' : ']';
  const end = t.lastIndexOf(close);
  const slice = t.slice(start, end + 1);
  try { return JSON.parse(slice); } catch (e) {
    // häufige Fehler reparieren: Komma vor schließender Klammer
    return JSON.parse(slice.replace(/,\s*([}\]])/g, '$1'));
  }
}

export async function completeJson(opts) {
  const sysAdd = '\n\nAntworte AUSSCHLIESSLICH mit gültigem JSON ohne erklärenden Text davor oder danach.';
  const text = await complete({ ...opts, system: (opts.system || '') + sysAdd, json: true });
  try { return parseJson(text); }
  catch (e) {
    // zweiter Versuch: KI bitten, das JSON zu reparieren
    const fixed = await complete({ model: 'fast', maxTokens: opts.maxTokens || 4000, json: true, system: 'Repariere das folgende fehlerhafte JSON. Gib nur das korrigierte JSON aus.', messages: [{ role: 'user', content: text.slice(0, 60000) }] });
    return parseJson(fixed);
  }
}

// Text auf eine Zeichenanzahl begrenzen (Anfang und Ende behalten)
export function clip(text, max = 300000) {
  if (!text || text.length <= max) return text || '';
  const head = Math.floor(max * 0.8);
  return text.slice(0, head) + '\n\n[… Text gekürzt …]\n\n' + text.slice(text.length - (max - head));
}
