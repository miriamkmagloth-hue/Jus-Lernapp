// KI-Schicht: ein Aufruf, drei Anbieter (Claude, Gemini, OpenAI)
import { store } from './store.js';
import { costOf, recordUsage, checkBudget, estimate } from './costs.js';

export const BASE_RULES = `Du bist ein Lernassistent für eine Jusstudentin in Österreich.
Verbindliche Regeln:
- Es gilt ausschließlich ÖSTERREICHISCHES Recht (ABGB, UGB, KSchG, ZPO, StGB, B-VG usw.). Niemals deutsches Recht (BGB, StGB-D, ZPO-D) oder deutsche Terminologie verwenden. Österreichische Fachsprache verwenden (z. B. "Gewährleistung", "Schadenersatz", "Anspruchsgrundlage", "OGH").
- Der Prüfungsstoff ist AUSSCHLIESSLICH der Inhalt der bereitgestellten Lehrbuchtexte. Füge keinen Stoff hinzu, der dort nicht steht, und lass nichts Wesentliches weg. Wenn etwas im Lehrbuch nicht vorkommt, sag das ausdrücklich.
- Belege Aussagen mit Seitenangaben im Format [S. 123] gemäß den Seitenmarkierungen im Text.
- Antworte auf Deutsch, klar, präzise und prüfungsorientiert.
- Wenn du Prüfungsfragen, Karteikarten, Fälle oder Tests erstellst: Frage AUSSCHLIESSLICH juristischen Inhalt ab – Rechtsinstitute, Begriffe und Definitionen, Voraussetzungen, Rechtsfolgen, Abgrenzungen, Ausnahmen, Zusammenhänge, Wertungen und die Anwendung auf konkrete Sachverhalte. Verstehe den Sinn des Kapitels und prüfe, ob die Studentin ihn verstanden hat.
- NIEMALS Paragraphennummern abfragen (z. B. „In welchem Paragraphen ist … geregelt?“, „Was regelt § 1295 ABGB?“, Antwortoptionen, die sich nur durch Paragraphen unterscheiden). Gefragt wird der Inhalt der Regelung. In Erklärungen und Lösungen darfst und sollst du die einschlägigen Normen nennen.
- NIEMALS fragen nach: Aufbau oder Gliederung des Buchs, Inhaltsverzeichnis/Inhaltsübersicht, Kapitel- oder Abschnittsnummern und -titeln, Seitenzahlen, Randziffern, Autorinnen/Autoren, Auflage, Vorwort, Literaturhinweisen oder Abkürzungen. Solche Textteile ignorierst du vollständig.
- Unterscheide zwei Ebenen des Stoffs:
  • "basis" = Grundwissen, das jede Kandidatin sicher können muss: zentrale Begriffe und Definitionen, Anspruchsgrundlagen, Prüfungs- und Fallprüfungsschemata, Grundvoraussetzungen und Rechtsfolgen, die klassischen Abgrenzungen und Standardfälle.
  • "vertiefung" = Spezial- und Detailwissen mit höherem Schwierigkeitsgrad: Sonderprobleme, Ausnahmen von Ausnahmen, Meinungsstreitigkeiten, Einzelfall-Rechtsprechung und Detailfragen (z. B. wer beim Schockschaden als naher Angehöriger gilt).`;

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
export async function complete({ system = '', messages, model = 'smart', maxTokens = 4000, json = false, cacheSystem = true, signal, purpose = 'KI-Anfrage', budgetExempt = false } = {}) {
  const c = cfg();
  if (!c.key) throw new Error('Kein KI-Schlüssel hinterlegt. Bitte in den Einstellungen eintragen.');
  const sys = system ? BASE_RULES + '\n\n' + system : BASE_RULES;
  const modelName = c.models[model] || (model === 'book' ? c.models.fast : null) || c.models.smart;
  // Kostenbremse: vorab schätzen und bei erreichtem Limit nachfragen
  const inChars = sys.length + messages.reduce((a, m) => a + String(m.content || '').length, 0);
  if (!budgetExempt) await checkBudget(estimate(modelName, inChars, Math.round(maxTokens * 0.4)), purpose);
  const track = u => recordUsage(costOf(modelName, u), purpose);
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (c.provider === 'anthropic') return await anthropic(c.key, modelName, sys, messages, maxTokens, cacheSystem, signal, track);
      if (c.provider === 'gemini') return await gemini(c.key, modelName, sys, messages, maxTokens, json, signal);
      if (c.provider === 'openai') return await openai(c.key, modelName, sys, messages, maxTokens, json, signal);
      throw new Error('Unbekannter KI-Anbieter');
    } catch (e) {
      // Netzwerkabbruch (z. B. Funkloch, Bildschirm aus) → automatisch nochmal versuchen
      if (e instanceof TypeError || /network|fetch|Verbindung unterbrochen/i.test(e.message)) { e.retry = true; e.message = 'Die Internetverbindung ist abgebrochen. Bitte App geöffnet und Bildschirm an lassen und nochmal versuchen.'; }
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

async function anthropic(key, model, system, messages, maxTokens, cacheSystem, signal, track = () => {}) {
  const body = {
    model, max_tokens: maxTokens, stream: true,
    // ohne „Nachdenken“: sonst verbraucht das Modell die Ausgabe-Tokens dafür (kostet und schneidet Antworten ab)
    thinking: { type: 'disabled' },
    system: [{ type: 'text', text: system, ...(cacheSystem && system.length > 4000 ? { cache_control: { type: 'ephemeral' } } : {}) }],
    messages: messages.map(m => ({ role: m.role, content: m.content }))
  };
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw await httpErr(res, 'Claude');
  if ((res.headers.get('content-type') || '').includes('application/json')) {
    const j = await res.json();
    track(j.usage || {});
    return (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  }
  // Antwort Stück für Stück lesen: hält die Verbindung auch bei langen Antworten am Handy offen
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', out = '', stop = '';
  const usage = {};
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      let ev; try { ev = JSON.parse(line.slice(5)); } catch { continue; }
      if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') out += ev.delta.text;
      else if (ev.type === 'message_start') Object.assign(usage, ev.message?.usage || {});
      else if (ev.type === 'message_delta') { if (ev.delta?.stop_reason) stop = ev.delta.stop_reason; if (ev.usage) Object.assign(usage, ev.usage); }
      else if (ev.type === 'error') { const e = new Error('Claude: ' + (ev.error?.message || 'Fehler')); e.retry = /overloaded|rate/i.test(ev.error?.type || ''); throw e; }
    }
  }
  if (usage.input_tokens || usage.output_tokens) track(usage);
  if (!out && !stop) { const e = new Error('Verbindung unterbrochen'); e.retry = true; throw e; }
  return out;
}

async function gemini(key, model, system, messages, maxTokens, json, signal) {
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
    generationConfig: { maxOutputTokens: Math.max(maxTokens, 8000), ...(json ? { responseMimeType: 'application/json' } : {}) }
  };
  let res;
  // kostenloses Kontingent: bei „zu viele Anfragen“ kurz warten und erneut versuchen
  for (let attempt = 0; ; attempt++) {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`, {
      method: 'POST', signal: signal || AbortSignal.timeout(180000), headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    }).catch(e => { if (e.name === 'TimeoutError') throw new Error('Gemini antwortet nicht (Zeitüberschreitung). Bitte später nochmal versuchen.'); throw e; });
    if (res.status !== 429 || attempt >= 4) break;
    const wait = 20 * (attempt + 1);
    try { window.dispatchEvent(new CustomEvent('ai-status', { detail: `Gemini: kostenloses Kontingent gerade ausgeschöpft – warte ${wait} Sekunden und versuche es erneut …` })); } catch {}
    await new Promise(r => setTimeout(r, wait * 1000));
  }
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
  try { return JSON.parse(slice); } catch {}
  // typische KI-Fehler lokal reparieren (kostet nichts): unmaskierte Anführungszeichen, Zeilenumbrüche, abgeschnittenes Ende
  return JSON.parse(repairJson(t.slice(start)));
}

export function repairJson(src) {
  let out = '', inStr = false;
  const stack = [];
  const nextSig = i => { for (let k = i; k < src.length; k++) if (!/\s/.test(src[k])) return src[k]; return ''; };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (c === '\\') { out += c + (src[i + 1] ?? ''); i++; continue; }
      if (c === '"') {
        // echtes Ende eines Strings nur, wenn danach , : } ] oder Ende folgt – sonst ist es ein Zitat im Text
        const n = nextSig(i + 1);
        if (n === '' || ',:}]'.includes(n)) { inStr = false; out += c; } else out += '\\"';
        continue;
      }
      if (c === '\n') { out += '\\n'; continue; }
      if (c === '\r' || c === '\t') { out += ' '; continue; }
      out += c; continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '{' || c === '[') stack.push(c === '{' ? '}' : ']');
    else if (c === '}' || c === ']') { if (stack.length) stack.pop(); }
    out += c;
    if (!stack.length && out.trim()) break; // Ende des JSON erreicht, Rest (Erklärtext) ignorieren
  }
  if (inStr) out += '"';
  out = out.replace(/,\s*$/, '');
  // abgeschnittene Antwort: unvollständiges letztes Element entfernen und Klammern schließen
  while (stack.length) { out = out.replace(/,\s*"[^"]*"\s*:?\s*$/, '').replace(/[,:]\s*$/, ''); out += stack.pop(); }
  return out.replace(/,\s*([}\]])/g, '$1');
}

export async function completeJson(opts) {
  const sysAdd = '\n\nAntworte AUSSCHLIESSLICH mit gültigem JSON ohne erklärenden Text davor oder danach.';
  const text = await complete({ ...opts, system: (opts.system || '') + sysAdd, json: true });
  try { return parseJson(text); }
  catch (e) {
    // zweiter Versuch: KI bitten, das JSON zu reparieren
    const fixed = await complete({ model: 'fast', maxTokens: Math.max(opts.maxTokens || 4000, Math.ceil(text.length / 2.5)), json: true, purpose: opts.purpose, budgetExempt: opts.budgetExempt, system: 'Repariere das folgende fehlerhafte JSON. Gib nur das korrigierte JSON aus.', messages: [{ role: 'user', content: text.slice(0, 60000) }] });
    return parseJson(fixed);
  }
}

// Text auf eine Zeichenanzahl begrenzen (Anfang und Ende behalten)
export function clip(text, max = 300000) {
  if (!text || text.length <= max) return text || '';
  const head = Math.floor(max * 0.8);
  return text.slice(0, head) + '\n\n[… Text gekürzt …]\n\n' + text.slice(text.length - (max - head));
}

// ---------- Hintergrund-Modus (Message Batches, halber Preis) ----------
// Batch-Schnittstelle: über die eigene Vercel-Funktion (der Browser darf sie nicht direkt aufrufen)
function batchUrl(path) {
  const hosted = location.protocol.startsWith('http') && !/^(localhost|127\.)/.test(location.hostname) && !location.hostname.endsWith('.netlify.app');
  return (hosted ? location.origin + '/anthropic-api/' : 'https://api.anthropic.com/v1/') + path;
}
const AH = key => ({ 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' });
export function batchAvailable() {
  const c = cfg();
  return c.provider === 'anthropic' && !!c.key && store.state.settings.useBatch !== false;
}
// reqs: [{ id, system, prompt, maxTokens, model }]
export async function submitBatch(reqs) {
  const c = cfg();
  const requests = reqs.map(r => {
    const sys = BASE_RULES + '\n\n' + (r.system || '') + '\n\nAntworte AUSSCHLIESSLICH mit gültigem JSON ohne erklärenden Text davor oder danach.';
    return { custom_id: r.id, params: { model: c.models[r.model || 'smart'] || (r.model === 'book' ? c.models.fast : null) || c.models.smart, max_tokens: r.maxTokens || 8000, thinking: { type: 'disabled' }, system: [{ type: 'text', text: sys }], messages: [{ role: 'user', content: r.content || r.prompt }] } };
  });
  const res = await fetch(batchUrl('messages/batches'), { method: 'POST', headers: AH(c.key), body: JSON.stringify({ requests }) });
  if (!res.ok) throw await httpErr(res, 'Claude (Hintergrund)');
  const j = await res.json();
  return { id: j.id, model: requests[0]?.params.model };
}
export async function batchStatus(id) {
  const c = cfg();
  const res = await fetch(batchUrl('messages/batches/' + encodeURIComponent(id)), { headers: AH(c.key) });
  if (!res.ok) throw await httpErr(res, 'Claude (Hintergrund)');
  return res.json();
}
// liefert [{ id, ok, text, usage }]
export async function batchResults(id, model) {
  const c = cfg();
  const res = await fetch(batchUrl('messages/batches/' + encodeURIComponent(id) + '/results'), { headers: AH(c.key) });
  if (!res.ok) throw await httpErr(res, 'Claude (Hintergrund)');
  const lines = (await res.text()).split('\n').filter(l => l.trim());
  return lines.map(l => {
    let j; try { j = JSON.parse(l); } catch { return null; }
    const ok = j.result?.type === 'succeeded';
    const msg = j.result?.message;
    if (ok && msg?.usage) recordUsage(costOf(model || msg.model, msg.usage, { batch: true }), 'Lehrbücher (Hintergrund)');
    return { id: j.custom_id, ok, text: ok ? (msg.content || []).filter(b => b.type === 'text').map(b => b.text).join('') : '', error: j.result?.error?.message || j.result?.type };
  }).filter(Boolean);
}
export async function cancelBatch(id) {
  const c = cfg();
  const res = await fetch(batchUrl('messages/batches/' + encodeURIComponent(id) + '/cancel'), { method: 'POST', headers: AH(c.key) });
  if (!res.ok) throw await httpErr(res, 'Claude (Hintergrund)');
  return res.json();
}
