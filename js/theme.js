// Personalisierung wie in „Meine Notizen“: Vorlagen, Schriftart, Hell/Dunkel, Akzentfarbe, eigene Farben, App-Hintergrund
import { store } from './store.js';

export const PRESETS = [
  { id: 'creme', name: 'Creme', mode: 'light', accent: '#d2693a', colors: { bg: '#f7f4ef', side: '#efeae2', card: '#ffffff', ink: '#26221e' } },
  { id: 'weiss', name: 'Weiß', mode: 'light', accent: '#3e63dd', colors: { bg: '#f5f6f8', side: '#ffffff', card: '#ffffff', ink: '#1f2328' } },
  { id: 'rose', name: 'Rosé', mode: 'light', accent: '#d6409f', colors: { bg: '#fcf3f3', side: '#f8e4e7', card: '#ffffff', ink: '#3a2a2e' } },
  { id: 'salbei', name: 'Salbei', mode: 'light', accent: '#3d8b5f', colors: { bg: '#f2f6f0', side: '#e3ecdf', card: '#ffffff', ink: '#23302a' } },
  { id: 'lavendel', name: 'Lavendel', mode: 'light', accent: '#8e4ec6', colors: { bg: '#f6f3fb', side: '#ebe4f7', card: '#ffffff', ink: '#2c2538' } },
  { id: 'himmel', name: 'Himmel', mode: 'light', accent: '#0a84d6', colors: { bg: '#f0f6fb', side: '#e0ecf7', card: '#ffffff', ink: '#1d2b38' } },
  { id: 'sand', name: 'Sand', mode: 'light', accent: '#9c6b30', colors: { bg: '#f6f0e7', side: '#ece2d2', card: '#fffbf5', ink: '#33291e' } },
  { id: 'dunkel', name: 'Dunkel', mode: 'dark', accent: '#ee8a58', colors: null }
];

export const COLOR_FIELDS = [
  { key: 'side', label: 'Kopfzeile & Navigation' },
  { key: 'bg', label: 'Hintergrund' },
  { key: 'card', label: 'Karten' },
  { key: 'ink', label: 'Schrift' }
];
export const UI_COLORS = ['#ffffff', '#fffdf9', '#f7f4ef', '#efeae2', '#f6efe3', '#fff4c7', '#ffe9dc', '#fbe4e8', '#f0e6fb', '#e3e9fb', '#e1effa', '#e2f3ea', '#eef3e2', '#eeeeee', '#d9d4cc'];
export const INK_COLORS = ['#26221e', '#1f2328', '#3a2a2e', '#23302a', '#2c2538', '#1d2b38', '#4a3b2a', '#555555'];
export const BG_COLORS = ['#fffdf9', '#f6efe3', '#fff4c7', '#ffe3d3', '#ffd9e4', '#f0dcff', '#dfe4ff', '#d6ecff', '#d5f3e6', '#e6f4d0', '#eeeeee', '#3a3633', '#1f2a37', '#22312a', '#3b2433', '#111111'];
export const ACCENTS = ['#d2693a', '#e5484d', '#d6409f', '#c2185b', '#8e4ec6', '#5b5bd6', '#3e63dd', '#0091ff', '#12a594', '#30a46c', '#9c7a3c', '#6f6e77'];

export const FONTS = [
  { id: 'huebsch', name: 'Hübsch', hint: 'weich & rund', body: '"Nunito", system-ui, sans-serif', display: '"Fraunces", Georgia, serif' },
  { id: 'elegant', name: 'Elegant', hint: 'fein & klassisch', body: '"Lora", Georgia, serif', display: '"Playfair Display", Georgia, serif' },
  { id: 'leicht', name: 'Leicht', hint: 'luftig & modern', body: '"Quicksand", system-ui, sans-serif', display: '"Fraunces", Georgia, serif' },
  { id: 'klar', name: 'Klar', hint: 'sachlich', body: '"DM Sans", system-ui, sans-serif', display: '"DM Sans", system-ui, sans-serif' },
  { id: 'system', name: 'Gerät', hint: 'Schrift des Geräts', body: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif', display: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' }
];

export const GLASS_DEFAULTS = { bars: 70, cards: 88 };

export function hexToRgb(hex) {
  let h = String(hex || '').replace('#', '').trim();
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  const n = parseInt(h, 16);
  if (Number.isNaN(n) || h.length !== 6) return { r: 255, g: 255, b: 255 };
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
export function rgbToHex({ r, g, b }) {
  return '#' + [r, g, b].map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
}
export function luminance(hex) {
  const { r, g, b } = hexToRgb(hex);
  const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
export function mix(a, b, t) {
  const x = hexToRgb(a), y = hexToRgb(b);
  return rgbToHex({ r: x.r + (y.r - x.r) * t, g: x.g + (y.g - x.g) * t, b: x.b + (y.b - x.b) * t });
}
export function overlayCss(dim) {
  const d = Number(dim || 0);
  return d >= 0 ? `rgba(255,255,255,${d})` : `rgba(0,0,0,${-d})`;
}

export function design() {
  return store.state.settings.design || {};
}
export function saveDesign(changes) {
  store.update(s => { s.settings.design = { ...(s.settings.design || {}), ...changes }; }, { silent: true });
  applyTheme();
}

export function isDark() {
  const m = design().themeMode || 'light';
  return m === 'dark' || (m === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
}

const VARS = ['--bg', '--side', '--card', '--ink', '--muted', '--line'];

export function applyTheme() {
  const p = design();
  const root = document.documentElement;
  const dark = isDark();
  root.classList.toggle('is-dark', dark);
  VARS.forEach(v => root.style.removeProperty(v));
  const preset = PRESETS.find(x => x.id === p.preset) || PRESETS[0];
  const colors = dark ? null : { ...(preset.colors || PRESETS[0].colors), ...(p.colors || {}) };
  if (colors) {
    root.style.setProperty('--bg', colors.bg);
    root.style.setProperty('--side', colors.side);
    root.style.setProperty('--card', colors.card);
    root.style.setProperty('--ink', colors.ink);
    root.style.setProperty('--muted', mix(colors.ink, colors.card, 0.42));
    root.style.setProperty('--line', mix(colors.bg, colors.ink, 0.1));
  }
  const accent = p.accent || (dark ? '#ee8a58' : preset.accent);
  root.style.setProperty('--accent', accent);
  root.style.setProperty('--accent-ink', luminance(accent) > 0.45 ? '#1d1410' : '#ffffff');

  const font = FONTS.find(f => f.id === p.font) || FONTS[0];
  root.style.setProperty('--font', font.body);
  root.style.setProperty('--font-display', font.display);

  const bg = p.appBg || { type: 'none' };
  const hasBg = bg.type === 'color' || (bg.type === 'image' && !!bg.image);
  document.body.classList.toggle('has-app-bg', hasBg);
  root.style.removeProperty('--app-bg-color'); root.style.removeProperty('--app-bg-img'); root.style.removeProperty('--app-bg-op');
  if (bg.type === 'color') root.style.setProperty('--app-bg-color', bg.color);
  if (bg.type === 'image' && bg.image) setAppBgImage(bg);
  setGlass(glassValues());
  const bar = getComputedStyle(root).getPropertyValue('--side').trim() || '#efeae2';
  document.querySelectorAll('meta[name="theme-color"]').forEach(m => m.setAttribute('content', bar));
}

export function glassValues() {
  const g = design().glass || {};
  return { bars: typeof g.bars === 'number' ? g.bars : GLASS_DEFAULTS.bars, cards: typeof g.cards === 'number' ? g.cards : GLASS_DEFAULTS.cards };
}
export function setGlass({ bars, cards }) {
  const root = document.documentElement;
  root.style.setProperty('--bars-pct', bars + '%');
  root.style.setProperty('--cards-pct', cards + '%');
  root.style.setProperty('--glass-blur', Math.round(4 + Math.max(bars, cards) * 0.12) + 'px');
}
export function setAppBgImage(bg) {
  const root = document.documentElement;
  root.style.setProperty('--app-bg-img', `linear-gradient(${overlayCss(bg.dim)}, ${overlayCss(bg.dim)}), url("${bg.image}") center / cover no-repeat`);
  root.style.setProperty('--app-bg-op', String(typeof bg.opacity === 'number' ? bg.opacity : 1));
}

// Foto verkleinern (damit es schnell synchronisiert)
export async function imageFileToDataUrl(file, max = 1600) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const scale = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.82);
  } finally { URL.revokeObjectURL(url); }
}

if (typeof window !== 'undefined' && window.matchMedia) {
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => { if ((design().themeMode || 'light') === 'auto') applyTheme(); });
}
