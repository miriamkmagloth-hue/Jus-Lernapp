// KI-Kosten: Verbrauch messen, schätzen, Tages- und Monatslimit
import { store } from './store.js';

// Preise in US-Dollar pro 1 Million Tokens (Claude, Stand November 2026)
export const PRICES = {
  sonnet: { in: 2, out: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  haiku: { in: 0.1, out: 0.5, cacheRead: 0.01, cacheWrite: 0.125, longIn: 0.5, longOut: 2.5 },
  opus: { in: 4, out: 20, cacheRead: 0.2, cacheWrite: 5 }
};
export function priceFor(model = '') {
  const m = String(model).toLowerCase();
  if (m.includes('haiku')) return PRICES.haiku;
  if (m.includes('opus')) return PRICES.opus;
  return PRICES.sonnet;
}

// Kosten einer Anfrage aus den Token-Angaben von Claude
export function costOf(model, u = {}, { batch = false } = {}) {
  const p = priceFor(model);
  const input = (u.input_tokens || 0), cr = (u.cache_read_input_tokens || 0), cw = (u.cache_creation_input_tokens || 0), out = (u.output_tokens || 0);
  const long = p.longIn && input + cr + cw > 100000;
  const pin = long ? p.longIn : p.in, pout = long ? p.longOut : p.out;
  const usd = (input * pin + cr * p.cacheRead + cw * p.cacheWrite + out * pout) / 1e6;
  return batch ? usd / 2 : usd;
}

// grobe Schätzung vorab: deutscher Text ≈ 3,5 Zeichen pro Token
export const tokensOf = chars => Math.ceil(chars / 3.5);
export function estimate(model, inChars, outTokens, { batch = false } = {}) {
  return costOf(model, { input_tokens: tokensOf(inChars), output_tokens: outTokens }, { batch });
}

const day = () => new Date().toISOString().slice(0, 10);
function usage() {
  const s = store.state;
  if (!s.usage) s.usage = { days: {} };
  return s.usage;
}
export function recordUsage(usd, purpose = 'sonstiges') {
  if (!usd) return;
  store.update(s => {
    if (!s.usage) s.usage = { days: {} };
    const d = s.usage.days[day()] || (s.usage.days[day()] = { usd: 0, calls: 0, by: {} });
    d.usd += usd; d.calls++;
    d.by[purpose] = (d.by[purpose] || 0) + usd;
    // nur die letzten 120 Tage behalten
    const keys = Object.keys(s.usage.days).sort();
    while (keys.length > 120) delete s.usage.days[keys.shift()];
  }, { silent: true });
}
export function spentToday() { return usage().days[day()]?.usd || 0; }
export function spentMonth() {
  const m = day().slice(0, 7);
  return Object.entries(usage().days).filter(([d]) => d.startsWith(m)).reduce((a, [, v]) => a + v.usd, 0);
}
export function limits() {
  const b = store.state.settings.budget || {};
  return { daily: b.daily ?? 1, monthly: b.monthly ?? 15 };
}
export const usd = x => (x < 0.01 && x > 0 ? '< 0,01' : x.toLocaleString('de-AT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })) + ' $';

// Vor einer Anfrage prüfen: Ist das Limit erreicht, wird gefragt
let extraToday = { day: '', usd: 0 };
export async function checkBudget(estUsd, purpose) {
  const l = limits();
  if (extraToday.day !== day()) extraToday = { day: day(), usd: 0 };
  const today = spentToday(), month = spentMonth();
  const dailyLimit = l.daily + extraToday.usd;
  if (today + estUsd <= dailyLimit && month + estUsd <= l.monthly) return;
  const { openModal, closeModal, esc } = await import('./ui.js');
  const overMonth = month + estUsd > l.monthly;
  const ok = await new Promise(resolve => {
    openModal(`<h3 style="margin-top:0">💶 ${overMonth ? 'Monatslimit' : 'Tageslimit'} erreicht</h3>
      <p>${overMonth ? `Diesen Monat wurden schon <strong>${usd(month)}</strong> für die KI verbraucht (Limit ${usd(l.monthly)}).` : `Heute wurden schon <strong>${usd(today)}</strong> für die KI verbraucht (Limit ${usd(dailyLimit)}).`}</p>
      <p class="small">Diese Anfrage (${esc(purpose)}) kostet ungefähr <strong>${usd(estUsd)}</strong>.</p>
      <div class="row" style="justify-content:flex-end;flex-wrap:wrap"><button class="btn secondary" data-b="no">Abbrechen</button><button class="btn" data-b="once">Diese Anfrage erlauben</button>${overMonth ? '' : '<button class="btn secondary" data-b="plus">Heute +1 $ erlauben</button>'}</div>
      <p class="tiny muted">Die Limits stellst du unter Einstellungen → KI-Kosten ein.</p>`, c => {
      c.querySelector('[data-b=no]').onclick = () => { closeModal(); resolve(false); };
      c.querySelector('[data-b=once]').onclick = () => { closeModal(); extraToday.usd += estUsd; resolve(true); };
      c.querySelector('[data-b=plus]')?.addEventListener('click', () => { closeModal(); extraToday.usd += 1; resolve(true); });
    });
  });
  if (!ok) { const e = new Error('Abgebrochen – das KI-Limit ist erreicht. Du kannst es unter Einstellungen → KI-Kosten anpassen.'); e.budget = true; throw e; }
}
