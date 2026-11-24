// Farbige Schlagwörter (Pastell) – rein lokal, kostet nichts.
// Markiert Voraussetzungen, Rechtsfolgen, Ausnahmen/Achtung und Rechtsprechung in bereits gerenderten Texten.
const CATS = [
  ['kw-rsp', /\b(OGH|EuGH|VfGH|stRsp|stRspr|Rsp|Rspr|hA|hM|hL|aA|Mindermeinung|Meinungsstreit|strittig|umstritten|\d{1,2}\s?Ob\s?\d+\/\d+[a-z]?|RS\d{7})\b/g],
  ['kw-aus', /\b(Ausnahmen?|ausgenommen|es sei denn|außer wenn|jedoch|Achtung|Abgrenzung|Stolperfalle|im Gegensatz|anders als|nicht aber|gilt nicht|subsidiär)\b/gi],
  ['kw-folge', /\b(Rechtsfolgen?|haftet|haften|Haftung|Schadenersatz(?:anspruch)?|Ersatzanspruch|Anspruch auf|nichtig|Nichtigkeit|unwirksam|anfechtbar|Anfechtung|Rücktritt|Wandlung|Preisminderung|Verbesserung|Austausch|Herausgabe|Rückforderung|Bereicherungsanspruch|Unterlassung)\b/gi],
  ['kw-vor', /\b(Voraussetzungen?|setzt voraus|vorausgesetzt|erforderlich|Erfordernis(?:se)?|Tatbestand(?:smerkmale?)?|kumulativ|alternativ|Rechtswidrigkeit|Verschulden|Kausalität|Adäquanz|Schaden|Zurechnung|Rechtswidrigkeitszusammenhang)\b/gi],
  ['kw-vermut', /\b(iZw|im Zweifel|Vermutung|vermutet|Beweislast|beweispflichtig)\b/gi],
];
const SKIP = new Set(['A', 'BUTTON', 'SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT', 'SELECT', 'CODE']);

export function paintOn() { try { return localStorage.getItem('paint') !== 'aus'; } catch { return true; } }
export function setPaint(on) { try { localStorage.setItem('paint', on ? 'an' : 'aus'); } catch {} }

export function paint(root) {
  if (!root || !paintOn()) return;
  root.classList.add('painted');
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: n => {
      for (let p = n.parentElement; p && p !== root; p = p.parentElement) if (SKIP.has(p.tagName) || p.classList.contains('cite') || p.classList.contains('kw') || p.classList.contains('no-paint')) return NodeFilter.FILTER_REJECT;
      return n.nodeValue.trim().length > 2 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    }
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const text = node.nodeValue;
    const hits = [];
    for (const [cls, re] of CATS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text))) if (!hits.some(h => m.index < h.end && m.index + m[0].length > h.start)) hits.push({ start: m.index, end: m.index + m[0].length, cls });
    }
    if (!hits.length) continue;
    hits.sort((a, b) => a.start - b.start);
    const frag = document.createDocumentFragment();
    let pos = 0;
    for (const h of hits) {
      if (h.start > pos) frag.appendChild(document.createTextNode(text.slice(pos, h.start)));
      const s = document.createElement('span');
      s.className = 'kw ' + h.cls; s.textContent = text.slice(h.start, h.end);
      frag.appendChild(s); pos = h.end;
    }
    if (pos < text.length) frag.appendChild(document.createTextNode(text.slice(pos)));
    node.parentNode.replaceChild(frag, node);
  }
}

export function legend() {
  const on = paintOn();
  return `<div class="paint-legend no-print"><span class="kw kw-vor">Voraussetzung</span><span class="kw kw-folge">Rechtsfolge</span><span class="kw kw-aus">Ausnahme / Achtung</span><span class="kw kw-rsp">Rechtsprechung</span><span class="kw kw-vermut">Vermutung / Beweis</span><strong class="kw-def-demo">Begriff</strong>
    <button class="btn ghost small" data-paint="${on ? 'aus' : 'an'}">${on ? 'Farben aus' : 'Farben an'}</button></div>`;
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-paint]');
  if (!b) return;
  setPaint(b.dataset.paint === 'an');
  window.dispatchEvent(new HashChangeEvent('hashchange'));
});
