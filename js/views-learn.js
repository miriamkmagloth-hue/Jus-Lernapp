// Lernfunktionen: Multiple Choice, freie Fragen, Karteikarten, Falltraining, mündliche Simulation, Einstufungstest
import { store, uid, allChapters, findChapter } from './store.js';
import { esc, md, enrich, toast, busy, errorBox, fmtDate, ampel } from './ui.js';
import { setTitle, render } from './app.js';
import { completeJson, complete, clip } from './ai.js';
import { chapterText, recordResult, recordLevelResult, combineLevels, addMistake, getFileText, setBaseline } from './processing.js';
import { mountChat, speak } from './chat.js';
import { activeExams } from './planner.js';

const shuffle = a => { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };
const noRerender = el => el.setAttribute('data-no-rerender', '');
const lvlOf = q => (String(q.ebene || '').toLowerCase().startsWith('vert') ? 'vertiefung' : 'basis');
export const lvlPill = q => lvlOf(q) === 'vertiefung' ? '<span class="pill gold">Vertiefung</span>' : '<span class="pill blue">Basis</span>';
const LEVEL_PROMPT = { basis: 'NUR Basiswissen (ebene "basis")', gemischt: 'etwa zwei Drittel Basiswissen und ein Drittel Vertiefung', vertiefung: 'NUR Vertiefungs-/Spezialwissen (ebene "vertiefung") mit hohem Schwierigkeitsgrad' };
function addLevel(acc, cid, q, ok) {
  const l = lvlOf(q);
  acc[cid] = acc[cid] || { basis: [0, 0], vertiefung: [0, 0] };
  acc[cid][l][1]++; if (ok) acc[cid][l][0]++;
}

function summaryDigest(c) {
  const s = c.summary;
  if (!s) return `## ${c.title}\n(keine Zusammenfassung)`;
  return `## ${c.title} [ID ${c.id}]\n${s.kurzfassung}\n${(s.themen || []).map(t => `### ${t.titel}\n${t.inhalt}`).join('\n')}\nDefinitionen: ${(s.definitionen || []).map(d => d.begriff + ': ' + d.definition).join(' | ')}\nStolperfallen: ${(s.stolperfallen || []).map(x => x.text || x).join(' | ')}`;
}

// ======================= Multiple Choice =======================
export function mountQuiz(el, sub, chapterIds, { title = '', count = 8 } = {}) {
  const start = () => {
    el.innerHTML = `<div class="card"><h3>Multiple-Choice-Test</h3><p class="small muted">${count} Fragen aus dem Lehrbuchtext${title ? ' zu „' + esc(title) + '“' : ''}. Jede Antwort mit Erklärung und Seitenangabe.</p>
      <label class="field"><span>Was möchtest du üben?</span><select id="lvl"><option value="gemischt">Gemischt (vor allem Basis, etwas Vertiefung)</option><option value="basis">Basiswissen (muss sitzen)</option><option value="vertiefung">Vertiefung / Spezialwissen (schwer)</option></select></label>
      <button class="btn" data-a="go">Test erstellen</button></div>`;
    el.querySelector('[data-a=go]').onclick = () => generate(el.querySelector('#lvl').value);
  };
  const generate = async level => {
    noRerender(el);
    el.innerHTML = busy('Erstelle Fragen aus dem Lehrbuch …');
    try {
      let material = '';
      for (const id of chapterIds.slice(0, 4)) material += `\n\n# Kapitel ${findChapter(sub, id)?.chapter.title} [ID ${id}]\n` + clip(await chapterText(sub, id), chapterIds.length > 1 ? 80000 : 250000);
      const r = await completeJson({
        model: 'smart', maxTokens: 8000,
        system: 'Du erstellst Multiple-Choice-Prüfungsfragen ausschließlich aus dem gegebenen Lehrbuchtext.',
        messages: [{ role: 'user', content: `Erstelle ${count} Multiple-Choice-Fragen: ${LEVEL_PROMPT[level] || LEVEL_PROMPT.gemischt}. Kennzeichne jede Frage mit "ebene". Je 4 Antwortoptionen, genau eine richtig. Falsche Optionen sollen plausibel sein (typische Verwechslungen). Mische Wissens-, Verständnis- und Anwendungsfragen (Mini-Fälle).\nJSON: {"fragen":[{"frage":"…","optionen":["…","…","…","…"],"richtig":Index 0-3,"erklaerung":"warum richtig, warum die anderen falsch","seite":"S. …","kapitelId":"…","ebene":"basis|vertiefung"}]}\n\nLEHRBUCHTEXT:${material}` }]
      });
      const qs = normalizeQuestions(r, chapterIds.map(id => ({ id, title: findChapter(sub, id)?.chapter.title || '' })), { basis: count, vert: 0 });
      if (!qs.length) throw new Error('Keine Fragen erhalten – bitte nochmal versuchen.');
      run(qs);
    } catch (e) { el.innerHTML = errorBox(e) + '<button class="btn secondary small" data-a="retry">Nochmal</button>'; el.querySelector('[data-a=retry]').onclick = start; }
  };
  const run = qs => {
    let i = 0, right = 0;
    const perChapter = {};
    const show = () => {
      const q = qs[i];
      el.innerHTML = `<div class="card"><div class="row between small muted"><span>Frage ${i + 1} von ${qs.length} ${lvlPill(q)}</span><span>${right} richtig</span></div>
        <div class="progress" style="margin:8px 0 14px"><div style="width:${(i / qs.length) * 100}%"></div></div>
        <div class="item-title" style="font-size:1.05rem">${enrich(esc(q.frage))}</div>
        <div style="margin-top:10px">${q.opts.map((o, k) => `<button class="mc-option" data-k="${k}">${enrich(esc(o.text))}</button>`).join('')}</div><div id="fb"></div></div>`;
      el.querySelectorAll('.mc-option').forEach(b => b.onclick = () => answer(+b.dataset.k));
    };
    const answer = k => {
      const q = qs[i];
      const ok = q.opts[k].ok;
      if (ok) right++;
      const cid = q.kapitelId && findChapter(sub, q.kapitelId) ? q.kapitelId : chapterIds[0];
      addLevel(perChapter, cid, q, ok);
      if (!ok) addMistake({ subId: sub.id, chapterId: cid, chapterTitle: findChapter(sub, cid)?.chapter.title, question: q.frage, yourAnswer: q.opts[k].text, correct: q.opts.find(o => o.ok)?.text, explanation: q.erklaerung });
      el.querySelectorAll('.mc-option').forEach((b, j) => { b.disabled = true; if (q.opts[j].ok) b.classList.add('correct'); else if (j === k) b.classList.add('wrong'); });
      el.querySelector('#fb').innerHTML = `<div class="notice ${ok ? 'ok' : 'err'}" style="margin-top:10px"><strong>${ok ? 'Richtig!' : 'Leider falsch.'}</strong> ${q.seite ? `<span class="cite">[${esc(String(q.seite).replace(/^\[|\]$/g, ''))}]</span>` : ''}${md(q.erklaerung)}</div>
        <button class="btn block" data-a="next">${i + 1 < qs.length ? 'Weiter' : 'Ergebnis'}</button>`;
      el.querySelector('[data-a=next]').onclick = () => { i++; i < qs.length ? show() : finish(); };
    };
    const finish = () => {
      const frac = right / qs.length;
      for (const [cid, lv] of Object.entries(perChapter)) recordLevelResult(cid, lv, 'mc');
      const sum = k => Object.values(perChapter).reduce((a, x) => [a[0] + x[k][0], a[1] + x[k][1]], [0, 0]);
      const sb = sum('basis'), sv = sum('vertiefung');
      store.update(s => { s.progress.quizzes.push({ at: Date.now(), subId: sub.id, chapterIds, score: frac, n: qs.length }); if (s.progress.quizzes.length > 1000) s.progress.quizzes = s.progress.quizzes.slice(-1000); }, { silent: true });
      el.innerHTML = `<div class="card" style="text-align:center"><div style="font-size:2.4rem;font-weight:700">${right}/${qs.length}</div><div class="small muted">${sb[1] ? `Basis ${sb[0]}/${sb[1]}` : ''}${sb[1] && sv[1] ? ' · ' : ''}${sv[1] ? `Vertiefung ${sv[0]}/${sv[1]}` : ''}</div><p>${frac >= 0.85 ? 'Sehr gut – das sitzt!' : frac >= 0.6 ? 'Gut, ein paar Lücken. Falsche Antworten sind im Fehlerbuch.' : 'Hier lohnt sich nochmal die Zusammenfassung. Falsche Antworten sind im Fehlerbuch.'}</p>
        <div class="row" style="justify-content:center"><button class="btn" data-a="again">Neuer Test</button><a class="btn secondary" href="#/fehlerbuch">Fehlerbuch</a></div></div>`;
      el.querySelector('[data-a=again]').onclick = start;
    };
    show();
  };
  start();
}

// ======================= Freie Fragen =======================
export function mountFreeQuestion(el, sub, ch) {
  const start = async () => {
    noRerender(el);
    el.innerHTML = busy('Überlege mir eine Frage …');
    try {
      const text = await chapterText(sub, ch.id);
      const q = await completeJson({
        model: 'smart', maxTokens: 2500,
        system: 'Du bist Prüferin und stellst offene Fragen ausschließlich zum gegebenen Lehrbuchtext.',
        messages: [{ role: 'user', content: `Stelle EINE offene Prüfungsfrage zu diesem Kapitel (wie in einer mündlichen Prüfung oder als Kurzfrage in einer Klausur), Ebene: ${level === 'basis' ? 'Basiswissen' : level === 'vertiefung' ? 'Vertiefung / Spezialwissen' : 'meist Basis, gelegentlich Vertiefung'}. Variiere: Definition, Abgrenzung, Voraussetzungen, Rechtsfolgen, Mini-Fall.\nBereits gestellt (nicht wiederholen): ${(ch._asked || []).join(' | ') || '–'}\nJSON: {"frage":"…","ebene":"basis|vertiefung","musterantwort":"Markdown, mit Seitenangaben","kernpunkte":["was eine gute Antwort enthalten muss"]}\n\nKAPITELTEXT:\n${clip(text, 250000)}` }]
      });
      ch._asked = [...(ch._asked || []), q.frage].slice(-10);
      el.innerHTML = `<div class="card"><div style="margin-bottom:6px">${lvlPill(q)}</div><div class="item-title" style="font-size:1.05rem">${enrich(esc(q.frage))}</div>
        <textarea id="ans" placeholder="Deine Antwort (auch stichwortartig) …" style="margin-top:12px"></textarea>
        <div class="row" style="margin-top:8px"><button class="btn" data-a="check">Bewerten lassen</button><button class="btn ghost small" data-a="skip">Andere Frage</button><button class="btn ghost small" data-a="show">Lösung zeigen</button></div><div id="res"></div></div>`;
      el.querySelector('[data-a=skip]').onclick = start;
      el.querySelector('[data-a=show]').onclick = () => { el.querySelector('#res').innerHTML = `<hr><h4>Musterantwort</h4>${md(q.musterantwort)}`; };
      el.querySelector('[data-a=check]').onclick = async () => {
        const ans = el.querySelector('#ans').value.trim();
        if (!ans) { toast('Bitte zuerst antworten'); return; }
        const res = el.querySelector('#res');
        res.innerHTML = busy('Bewerte …');
        try {
          const g = await completeJson({
            model: 'smart', maxTokens: 2500,
            system: 'Du bewertest eine Prüfungsantwort fair, aber genau, ausschließlich anhand der Musterantwort und Kernpunkte aus dem Lehrbuch.',
            messages: [{ role: 'user', content: `FRAGE: ${q.frage}\nMUSTERANTWORT: ${q.musterantwort}\nKERNPUNKTE: ${(q.kernpunkte || []).join(' | ')}\nANTWORT DER STUDENTIN: ${ans}\n\nJSON: {"punkte": 0-10, "richtig": ["was gut war"], "fehlt": ["was gefehlt hat oder falsch war"], "feedback": "kurzes Feedback in Markdown"}` }]
          });
          const frac = Math.max(0, Math.min(10, Number(g.punkte) || 0)) / 10;
          recordLevelResult(ch.id, { [lvlOf(q)]: [frac, 1] }, 'frei');
          if (frac < 0.6) addMistake({ subId: sub.id, chapterId: ch.id, chapterTitle: ch.title, question: q.frage, yourAnswer: ans, correct: (q.kernpunkte || []).join('; '), explanation: q.musterantwort });
          res.innerHTML = `<hr><div class="row between"><h4 style="margin:0">Bewertung</h4><span class="pill ${frac >= 0.75 ? 'green' : frac >= 0.45 ? 'yellow' : 'red'}">${g.punkte}/10</span></div>
            ${g.richtig?.length ? `<div class="small"><strong>Gut:</strong><ul>${g.richtig.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
            ${g.fehlt?.length ? `<div class="small"><strong>Fehlt / ungenau:</strong><ul>${g.fehlt.map(x => `<li>${enrich(esc(x))}</li>`).join('')}</ul></div>` : ''}
            ${md(g.feedback)}<details><summary>Musterantwort</summary>${md(q.musterantwort)}</details>
            <button class="btn block" data-a="next">Nächste Frage</button>`;
          res.querySelector('[data-a=next]').onclick = start;
        } catch (e) { res.innerHTML = errorBox(e); }
      };
    } catch (e) { el.innerHTML = errorBox(e) + '<button class="btn secondary small" data-a="r">Nochmal</button>'; el.querySelector('[data-a=r]').onclick = start; }
  };
  let level = 'gemischt';
  el.innerHTML = `<div class="card"><h3>Freie Fragen</h3><p class="small muted">Die KI stellt dir offene Fragen wie eine Prüferin und bewertet deine Antwort.</p>
    <label class="field"><span>Was möchtest du üben?</span><select id="flvl"><option value="gemischt">Gemischt</option><option value="basis">Basiswissen</option><option value="vertiefung">Vertiefung / Spezialwissen</option></select></label><button class="btn" data-a="go">Los geht's</button></div>`;
  el.querySelector('[data-a=go]').onclick = () => { level = el.querySelector('#flvl').value; start(); };
}

// ======================= Karteikarten =======================
const INTERVALS = [0, 1, 3, 7, 16, 35, 80];

export function dueCards(subId = null) {
  const out = [];
  const st = store.state;
  const now = Date.now();
  for (const sub of st.subjects) {
    if (subId && sub.id !== subId) continue;
    for (const c of allChapters(sub)) for (const card of st.cards[c.id] || []) {
      const r = st.srs[card.id];
      if (!r || r.due <= now) out.push({ subId: sub.id, chId: c.id, chTitle: c.title, card, isNew: !r });
    }
  }
  return out;
}

export function mountChapterCards(el, sub, ch) {
  const cards = store.state.cards[ch.id] || [];
  const due = dueCards(sub.id).filter(d => d.chId === ch.id);
  el.innerHTML = `<div class="card"><h3>Karteikarten</h3>
    ${cards.length ? `<p class="small">${cards.length} Karten · ${due.length} jetzt fällig</p><div class="row"><button class="btn" data-a="learn" ${due.length ? '' : 'disabled'}>Fällige lernen</button><button class="btn secondary" data-a="all">Alle durchgehen</button><button class="btn ghost small" data-a="gen">Weitere erstellen</button></div>
      <details style="margin-top:10px"><summary class="small">Alle Karten ansehen</summary><ul class="list">${cards.map(c => `<li class="small">${c.ebene ? lvlPill(c) + ' ' : ''}<strong>${enrich(esc(c.front))}</strong><br>${enrich(esc(c.back))}</li>`).join('')}</ul></details>`
      : `<p class="small muted">Noch keine Karten. Die KI erstellt sie aus dem Lehrbuchtext: Definitionen, Voraussetzungen, Abgrenzungen. Gelernt wird mit Wiederholungssystem – was du gut kannst, kommt seltener.</p><button class="btn" data-a="gen">Karten erstellen</button>`}</div><div id="session"></div>`;
  el.onclick = async e => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'gen') {
      noRerender(el);
      const s = el.querySelector('#session'); s.innerHTML = busy('Erstelle Karteikarten …');
      try {
        const text = await chapterText(sub, ch.id);
        const r = await completeJson({
          model: 'smart', maxTokens: 6000,
          system: 'Du erstellst Lernkarteikarten ausschließlich aus dem gegebenen Lehrbuchtext.',
          messages: [{ role: 'user', content: `Erstelle 15–25 Karteikarten zu den prüfungsrelevanten Inhalten (Definitionen, Voraussetzungen, Rechtsfolgen, Abgrenzungen, Normen). Vorderseite: präzise Frage. Rückseite: knappe, vollständige Antwort mit Seitenangabe.\nBereits vorhanden (nicht doppeln): ${cards.map(c => c.front).join(' | ').slice(0, 4000) || '–'}\nKennzeichne jede Karte mit "ebene" (basis oder vertiefung).\nJSON: {"karten":[{"vorne":"…","hinten":"…","ebene":"basis|vertiefung"}]}\n\nKAPITELTEXT:\n${clip(text, 250000)}` }]
        });
        store.update(st => { st.cards[ch.id] = [...(st.cards[ch.id] || []), ...(r.karten || []).map(k => ({ id: uid('c_'), front: k.vorne, back: k.hinten, ebene: lvlOf(k) }))]; });
        el.removeAttribute('data-no-rerender');
        mountChapterCards(el, sub, ch);
      } catch (err) { s.innerHTML = errorBox(err); }
    }
    if (a === 'learn' || a === 'all') {
      const list = a === 'learn' ? due : (store.state.cards[ch.id] || []).map(card => ({ subId: sub.id, chId: ch.id, chTitle: ch.title, card }));
      reviewSession(el.querySelector('#session'), shuffle(list), () => mountChapterCards(el, sub, ch));
    }
  };
}

function reviewSession(el, items, onDone) {
  noRerender(el);
  let i = 0, known = 0;
  const show = () => {
    if (i >= items.length) {
      el.innerHTML = `<div class="card" style="text-align:center"><h3>Fertig!</h3><p>${known} von ${items.length} gewusst.</p><button class="btn" data-a="done">OK</button></div>`;
      el.querySelector('[data-a=done]').onclick = () => { el.removeAttribute('data-no-rerender'); onDone && onDone(); };
      // Kenntnisstand pro Kapitel leicht anpassen
      const per = {};
      items.forEach(it => addLevel(per, it.chId, it.card, it._ok));
      for (const [cid, lv] of Object.entries(per)) if (lv.basis[1] + lv.vertiefung[1] >= 3) recordLevelResult(cid, lv, 'karten');
      return;
    }
    const it = items[i];
    el.innerHTML = `<div class="small muted" style="margin:10px 0">${i + 1} / ${items.length} · ${esc(it.chTitle)} ${it.card.ebene ? lvlPill(it.card) : ''}</div>
      <div class="card flashcard" data-a="flip"><div>${enrich(esc(it.card.front))}<div class="tiny muted" style="margin-top:14px">Antippen zum Umdrehen</div></div></div><div id="btns"></div>`;
    el.querySelector('[data-a=flip]').onclick = () => {
      el.querySelector('.flashcard').innerHTML = `<div><div class="small muted">${enrich(esc(it.card.front))}</div><hr><div>${enrich(esc(it.card.back))}</div></div>`;
      el.querySelector('#btns').innerHTML = `<div class="grid3"><button class="btn danger" data-r="0">Nicht gewusst</button><button class="btn secondary" data-r="1">Teilweise</button><button class="btn" data-r="2">Gewusst</button></div>`;
      el.querySelectorAll('[data-r]').forEach(b => b.onclick = () => rate(+b.dataset.r));
    };
  };
  const rate = r => {
    const it = items[i];
    store.update(st => {
      const s = st.srs[it.card.id] || { box: 0, due: 0 };
      if (r === 0) { s.box = 0; s.due = Date.now() + 10 * 60000; }
      else if (r === 1) { s.box = Math.max(1, s.box); s.due = Date.now() + 86400000; }
      else { s.box = Math.min(INTERVALS.length - 1, s.box + 1); s.due = Date.now() + INTERVALS[s.box] * 86400000; }
      st.srs[it.card.id] = s;
    }, { silent: true });
    it._ok = r === 2; if (r === 2) known++;
    i++; show();
  };
  show();
}

export function cardsView(el, subId) {
  setTitle('Karteikarten');
  const subs = store.state.subjects;
  if (subId) {
    const sub = store.subject(subId);
    const due = shuffle(dueCards(subId)).slice(0, 40);
    if (!due.length) { el.innerHTML = '<div class="card empty">Keine fälligen Karten. 🎉</div>'; return; }
    el.innerHTML = `<h2>${esc(sub.name)}</h2><div id="s"></div>`;
    reviewSession(el.querySelector('#s'), due, () => { location.hash = '#/karten'; });
    return;
  }
  el.innerHTML = `<p class="small muted">Karteikarten erstellst du pro Kapitel (Lehrbuch → Kapitel → Karteikarten). Hier lernst du alle fälligen Karten eines Fachs.</p>` + (subs.map(s => {
    const due = dueCards(s.id);
    const total = allChapters(s).reduce((a, c) => a + (store.state.cards[c.id]?.length || 0), 0);
    return `<div class="card"><div class="row between"><div><div class="item-title">${esc(s.name)}</div><div class="small muted">${total} Karten · ${due.length} fällig</div></div><a class="btn ${due.length ? '' : 'secondary'}" href="#/karten/${s.id}" ${due.length ? '' : 'style="pointer-events:none;opacity:.5"'}>Lernen</a></div></div>`;
  }).join('') || '<div class="card empty">Noch keine Fächer.</div>');
}

// ======================= Falltraining =======================
export function caseView(el, subId, preset) {
  const sub = store.subject(subId);
  if (!sub) { el.innerHTML = 'Fach nicht gefunden'; return; }
  setTitle('Falltraining');
  noRerender(el);
  const saved = sessionStorage.getItem('case:' + subId);
  if (preset && preset.startsWith('alt:')) return startFromAlt(preset);
  if (preset && preset.startsWith('fs:')) return startFromCollection(preset);
  if (saved && !preset) {
    try { const c = JSON.parse(saved); if (c && !c.graded) return solve(c); } catch {}
  }
  setup();

  function setup() {
    const exam = activeExams(sub).find(e => e.type === 'schriftlich') || activeExams(sub)[0];
    const chs = allChapters(sub, { exam }).filter(c => c.summary);
    if (!chs.length) { el.innerHTML = '<div class="card">Zuerst müssen die Lehrbücher verarbeitet sein.</div>'; return; }
    const inScope = c => !exam?.scopeMap || exam.scopeMap[c.id] !== 'raus';
    el.innerHTML = `<div class="card"><h3>Neuen Fall erstellen</h3>
      <label class="field"><span>Modus</span><select id="mode"><option value="ansprueche">Anspruchstraining – nur die richtigen Anspruchsgrundlagen finden</option><option value="voll">Volle Falllösung – mit Korrektur</option></select></label>
      <label class="field"><span>Schwierigkeit</span><select id="lvl"><option value="einfach">Einstieg</option><option value="klausur" selected>Klausurniveau</option><option value="schwer">Schwer (mehrere Personen, Querverbindungen)</option></select></label>
      <label class="field"><span>Zeitlimit</span><select id="time"><option value="0">ohne</option><option value="20">20 Min</option><option value="45">45 Min</option><option value="90">90 Min</option><option value="180">180 Min (ganze Klausur)</option></select></label>
      <div class="small muted">Stoffgebiete (leer lassen = Zufall aus dem Prüfungsstoff, Schwächen bevorzugt)</div>
      <div style="max-height:260px;overflow:auto;border:1px solid var(--line);border-radius:10px;padding:6px 10px;margin:6px 0 12px">${chs.map(c => `<label class="checkline small"><input type="checkbox" value="${c.id}" ${inScope(c) ? '' : 'disabled'}> ${esc(c.title)}</label>`).join('')}</div>
      <button class="btn" data-a="gen">Fall erstellen</button></div>`;
    el.querySelector('[data-a=gen]').onclick = () => {
      let ids = [...el.querySelectorAll('input[type=checkbox]:checked')].map(i => i.value);
      if (!ids.length) {
        const prog = store.state.progress.chapters;
        const pool = chs.filter(inScope).map(c => ({ id: c.id, w: 1.2 - (prog[c.id]?.mastery || 0) + Math.random() * 0.8 })).sort((a, b) => b.w - a.w);
        ids = pool.slice(0, 2 + Math.floor(Math.random() * 2)).map(x => x.id);
      }
      generate({ ids, mode: el.querySelector('#mode').value, level: el.querySelector('#lvl').value, minutes: +el.querySelector('#time').value });
    };
  }

  async function generate(cfg) {
    el.innerHTML = busy('Erstelle einen Fall aus deinen Lehrbüchern … (ca. 1 Minute)');
    try {
      let material = '';
      for (const id of cfg.ids.slice(0, 4)) material += `\n\n# Kapitel „${findChapter(sub, id).chapter.title}“ [ID ${id}]\n` + clip(await chapterText(sub, id), 90000);
      const r = await completeJson({
        model: 'smart', maxTokens: 8000,
        system: 'Du erstellst juristische Übungsfälle nach österreichischem Recht im Stil österreichischer Uni-Klausuren. Der Fall darf nur Probleme enthalten, die mit dem gegebenen Lehrbuchstoff lösbar sind. Die Lösung muss sich auf diesen Stoff stützen (mit Seitenangaben).',
        messages: [{ role: 'user', content: `Erstelle einen Fall (Schwierigkeit: ${cfg.level}) zu den folgenden Stoffgebieten. Typische Fallfrage: „Welche Ansprüche hat A gegen B?“ o. ä. Baue 1–3 typische Stolperfallen ein.\nJSON: {\n "titel": "kurzer Titel",\n "sachverhalt": "der Sachverhalt (Personen mit Buchstaben/Namen, realistisch, präzise)",\n "fallfrage": "…",\n "kapitelIds": ["…"],\n "loesung": {\n   "ansprueche": [{"wer": "…", "gegen": "…", "was": "…", "grundlage": "Anspruchsgrundlage mit Norm", "ergebnis": "besteht / besteht nicht / teilweise, kurz warum"}],\n   "skizze": "vollständige Lösungsskizze im Gutachtenstil (Markdown) mit Seitenangaben",\n   "stolperfallen": ["…"]\n }\n}\n\nSTOFF:${material}` }]
      });
      const c = { ...r, cfg, startedAt: Date.now(), answer: '', rows: [] };
      sessionStorage.setItem('case:' + subId, JSON.stringify(c));
      solve(c);
    } catch (e) { el.innerHTML = errorBox(e) + '<button class="btn secondary small" data-a="b">Zurück</button>'; el.querySelector('[data-a=b]').onclick = setup; }
  }

  function startFromCollection(p) {
    const [, fileId, chId, idx] = p.split(':');
    const b = sub.books.find(x => x.fileId === fileId);
    const f = b?.chapters.find(c => c.id === chId)?.cases?.[+idx];
    if (!f) { el.innerHTML = '<div class="card">Fall nicht gefunden.</div>'; return; }
    const c = { titel: `${f.titel || 'Fall'} (${b.title})`, sachverhalt: f.sachverhalt || '', fallfrage: (f.fragen || []).join('\n'), kapitelIds: f.kapitelIds || [], loesung: { ansprueche: f.ansprueche || [], skizze: f.loesung, stolperfallen: f.stolperfallen || [] }, cfg: { mode: 'voll', minutes: 0, level: 'Fallsammlung' }, startedAt: Date.now(), answer: '', rows: [] };
    showStart(c);
  }

  function showStart(c) {
    el.innerHTML = `<div class="card"><h3>${esc(c.titel)}</h3><label class="field"><span>Modus</span><select id="mode"><option value="ansprueche">Anspruchstraining</option><option value="voll" selected>Volle Falllösung</option></select></label>
      <label class="field"><span>Zeitlimit</span><select id="time"><option value="0">ohne</option><option value="20">20 Min</option><option value="45">45 Min</option><option value="90">90 Min</option></select></label><button class="btn" data-a="go">Starten</button></div>`;
    el.querySelector('[data-a=go]').onclick = () => { c.cfg.mode = el.querySelector('#mode').value; c.cfg.minutes = +el.querySelector('#time').value; c.startedAt = Date.now(); sessionStorage.setItem('case:' + subId, JSON.stringify(c)); solve(c); };
  }

  async function startFromAlt(p) {
    const [, fileId, idx] = p.split(':');
    const k = sub.altklausuren.find(x => x.fileId === fileId);
    const f = k?.analysis?.faelle?.[+idx];
    if (!f) { el.innerHTML = '<div class="card">Fall nicht gefunden.</div>'; return; }
    const c = { titel: `${k.title}: ${f.kurz}`, sachverhalt: f.sachverhalt, fallfrage: (f.fragen || []).join('\n'), kapitelIds: f.kapitelIds || [], loesung: { ansprueche: (f.ansprueche || []).map(a => ({ ...a, ergebnis: '' })), skizze: f.loesung, stolperfallen: f.stolperfallen }, cfg: { mode: 'voll', minutes: 0, level: 'Altklausur' }, startedAt: Date.now(), answer: '', rows: [] };
    el.innerHTML = `<div class="card"><h3>${esc(c.titel)}</h3><label class="field"><span>Modus</span><select id="mode"><option value="ansprueche">Anspruchstraining</option><option value="voll" selected>Volle Falllösung</option></select></label>
      <label class="field"><span>Zeitlimit</span><select id="time"><option value="0">ohne</option><option value="20">20 Min</option><option value="45">45 Min</option><option value="90">90 Min</option></select></label><button class="btn" data-a="go">Starten</button></div>`;
    el.querySelector('[data-a=go]').onclick = () => { c.cfg.mode = el.querySelector('#mode').value; c.cfg.minutes = +el.querySelector('#time').value; c.startedAt = Date.now(); sessionStorage.setItem('case:' + subId, JSON.stringify(c)); solve(c); };
  }

  function solve(c) {
    const ans = c.cfg.mode === 'ansprueche';
    if (ans && !c.rows.length) c.rows = [{ wer: '', gegen: '', was: '', grundlage: '' }];
    const persist = () => sessionStorage.setItem('case:' + subId, JSON.stringify(c));
    const draw = () => {
      el.innerHTML = `<div class="card"><div class="row between"><h3 style="margin:0">${esc(c.titel)}</h3>${c.cfg.minutes ? '<span class="timer pill blue" id="timer"></span>' : ''}</div>
        <div class="sachverhalt" style="margin-top:10px">${esc(c.sachverhalt)}</div>
        <p><strong>${esc(c.fallfrage)}</strong></p></div>
        <div class="card">${ans ? `<h3>Welche Ansprüche prüfst du?</h3><p class="small muted">Wer will was von wem woraus? In der Reihenfolge, in der du prüfen würdest.</p>
          <div id="rows">${c.rows.map((r, i) => `<div class="grid2" style="grid-template-columns:repeat(auto-fit,minmax(130px,1fr));margin-bottom:8px" data-row="${i}">
            <input type="text" data-k="wer" placeholder="Wer" value="${esc(r.wer)}"><input type="text" data-k="gegen" placeholder="gegen wen" value="${esc(r.gegen)}"><input type="text" data-k="was" placeholder="was (z. B. Schadenersatz)" value="${esc(r.was)}"><input type="text" data-k="grundlage" placeholder="woraus (Norm)" value="${esc(r.grundlage)}"></div>`).join('')}</div>
          <button class="btn secondary small" data-a="addrow">+ Anspruch</button>`
          : `<h3>Deine Lösung</h3><textarea id="answer" style="min-height:340px" placeholder="Gutachten / Lösungsskizze …">${esc(c.answer)}</textarea>`}
          <div class="row" style="margin-top:12px"><button class="btn" data-a="grade">Abgeben und korrigieren</button><button class="btn ghost small" data-a="discard">Fall verwerfen</button></div></div><div id="result"></div>`;
      el.querySelectorAll('[data-row] input').forEach(inp => inp.oninput = () => { c.rows[+inp.closest('[data-row]').dataset.row][inp.dataset.k] = inp.value; persist(); });
      const ta = el.querySelector('#answer'); if (ta) ta.oninput = () => { c.answer = ta.value; persist(); };
    };
    draw();
    let timerInt = null;
    if (c.cfg.minutes) {
      timerInt = setInterval(() => {
        const t = document.getElementById('timer');
        if (!t) { clearInterval(timerInt); return; }
        const left = c.startedAt + c.cfg.minutes * 60000 - Date.now();
        t.textContent = left > 0 ? `${Math.floor(left / 60000)}:${String(Math.floor(left / 1000) % 60).padStart(2, '0')}` : 'Zeit um!';
        if (left <= 0) t.className = 'timer pill red';
      }, 1000);
    }
    el.onclick = async e => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a === 'addrow') { c.rows.push({ wer: '', gegen: '', was: '', grundlage: '' }); persist(); draw(); }
      if (a === 'discard') { sessionStorage.removeItem('case:' + subId); clearInterval(timerInt); setup(); }
      if (a === 'grade') {
        const userAns = ans ? c.rows.filter(r => r.grundlage || r.was).map((r, i) => `${i + 1}. ${r.wer} gegen ${r.gegen}: ${r.was} – ${r.grundlage}`).join('\n') : c.answer;
        if (!userAns.trim()) { toast('Bitte zuerst eine Lösung eingeben'); return; }
        clearInterval(timerInt);
        const res = el.querySelector('#result');
        res.innerHTML = busy('Korrigiere …');
        e.target.closest('[data-a]').disabled = true;
        try {
          const g = await completeJson({
            model: 'smart', maxTokens: 5000,
            system: 'Du korrigierst eine Falllösung nach österreichischem Recht wie eine faire, genaue Korrektorin an der Uni. Maßstab ist die Musterlösung (gestützt auf das Lehrbuch). Vertretbare andere Lösungswege anerkennen.',
            messages: [{ role: 'user', content: `SACHVERHALT:\n${c.sachverhalt}\nFALLFRAGE: ${c.fallfrage}\n\nMUSTERLÖSUNG:\nAnsprüche: ${JSON.stringify(c.loesung?.ansprueche || [])}\n${c.loesung?.skizze || ''}\nStolperfallen: ${(c.loesung?.stolperfallen || []).join(' | ')}\n\n${ans ? 'ANSPRÜCHE DER STUDENTIN (nur Anspruchsgrundlagen, keine Prüfung):' : 'LÖSUNG DER STUDENTIN:'}\n${userAns}\n\nJSON: {\n "punkte": 0-100,\n "gefunden": ["richtig erkannt"],\n "fehlend": ["übersehen"],\n "ueberfluessig": ["unnötig/falsch geprüft"],\n ${ans ? '"reihenfolge": "Kommentar zur Prüfungsreihenfolge",' : '"aufbau": "Kommentar zu Aufbau, Gutachtenstil, Subsumtion",'}\n "feedback": "Gesamtfeedback in Markdown",\n "tipps": ["konkrete Verbesserung"]\n}` }]
          });
          const frac = Math.max(0, Math.min(100, Number(g.punkte) || 0)) / 100;
          c.graded = true; c.grade = g; persist();
          sessionStorage.removeItem('case:' + subId);
          if (c.kapitelIds?.length) recordResult(c.kapitelIds.filter(id => findChapter(sub, id)), frac, 'fall');
          store.update(s => { s.progress.cases.push({ at: Date.now(), subId, title: c.titel, mode: c.cfg.mode, score: frac }); }, { silent: true });
          (g.fehlend || []).forEach(m => addMistake({ subId, chapterTitle: 'Fall: ' + c.titel, question: 'Übersehen im Fall „' + c.titel + '“', correct: m, explanation: '' }));
          res.innerHTML = `<div class="card"><div class="row between"><h3 style="margin:0">Korrektur</h3><span class="pill ${frac >= 0.75 ? 'green' : frac >= 0.45 ? 'yellow' : 'red'}">${g.punkte}/100</span></div>
            ${g.gefunden?.length ? `<h4>✓ Erkannt</h4><ul>${g.gefunden.map(x => `<li>${enrich(esc(x))}</li>`).join('')}</ul>` : ''}
            ${g.fehlend?.length ? `<h4>✗ Übersehen</h4><ul>${g.fehlend.map(x => `<li>${enrich(esc(x))}</li>`).join('')}</ul>` : ''}
            ${g.ueberfluessig?.length ? `<h4>– Überflüssig / falsch</h4><ul>${g.ueberfluessig.map(x => `<li>${enrich(esc(x))}</li>`).join('')}</ul>` : ''}
            ${g.reihenfolge || g.aufbau ? `<h4>${ans ? 'Reihenfolge' : 'Aufbau'}</h4>${md(g.reihenfolge || g.aufbau)}` : ''}
            ${md(g.feedback)}${g.tipps?.length ? `<h4>Tipps</h4><ul>${g.tipps.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}</div>
            <div class="card"><h3>Musterlösung</h3><ul>${(c.loesung?.ansprueche || []).map(x => `<li><strong>${esc(x.wer)} gegen ${esc(x.gegen)}</strong>: ${esc(x.was)} – ${enrich(esc(x.grundlage))}${x.ergebnis ? ` → ${esc(x.ergebnis)}` : ''}</li>`).join('')}</ul>${md(c.loesung?.skizze)}
            ${c.loesung?.stolperfallen?.length ? `<h4>⚠ Stolperfallen</h4><ul>${c.loesung.stolperfallen.map(x => `<li>${enrich(esc(x))}</li>`).join('')}</ul>` : ''}</div>
            <div class="card"><h3>Rückfragen zum Fall</h3><div id="caseChat"></div></div>
            <button class="btn block" data-a="new">Neuer Fall</button>`;
          const hist = [];
          mountChat(res.querySelector('#caseChat'), { history: hist, system: `Du besprichst mit der Studentin ihren gerade korrigierten Übungsfall.\nSACHVERHALT: ${c.sachverhalt}\nFALLFRAGE: ${c.fallfrage}\nMUSTERLÖSUNG: ${JSON.stringify(c.loesung)}\nIHRE LÖSUNG: ${userAns}\nKORREKTUR: ${JSON.stringify(g)}`, placeholder: 'Warum ist … ?', emptyText: 'Unklar, warum etwas falsch war? Frag nach.' });
          res.querySelector('[data-a=new]').onclick = () => setup();
        } catch (err) { res.innerHTML = errorBox(err); e.target.closest('[data-a]') && (e.target.closest('[data-a]').disabled = false); }
      }
    };
  }
}

// ======================= Mündliche Prüfungssimulation =======================
export function oralView(el, subId, examId) {
  const sub = store.subject(subId);
  if (!sub) return;
  const exam = sub.exams.find(e => e.id === examId);
  setTitle('Mündliche Simulation');
  noRerender(el);
  const chs = allChapters(sub, { exam }).filter(c => c.summary && (!exam?.scopeMap || exam.scopeMap[c.id] !== 'raus'));
  if (!chs.length) { el.innerHTML = '<div class="card">Zuerst müssen die Lehrbücher verarbeitet sein.</div>'; return; }
  el.innerHTML = `<div class="card"><h3>${esc(sub.name)}${exam ? ' · ' + esc(exam.name) : ''}</h3>
    <label class="field"><span>Dauer</span><select id="dur"><option value="10">ca. 10 Minuten</option><option value="15" selected>ca. 15 Minuten</option><option value="25">ca. 25 Minuten</option></select></label>
    <label class="field"><span>Prüferstil</span><select id="style"><option value="sachlich">sachlich, fair</option><option value="streng">streng, viel Nachhaken</option><option value="freundlich">freundlich, hilft weiter</option></select></label>
    <label class="field"><span>Schwerpunkt</span><select id="focus"><option value="alle">gesamter Prüfungsstoff</option><option value="schwach">meine Schwachstellen</option>${chs.map(c => `<option value="${c.id}">${esc(c.title)}</option>`).join('')}</select></label>
    <label class="checkline"><input type="checkbox" id="speak" ${store.state.settings.speakQuestions ? 'checked' : ''}> Fragen vorlesen</label>
    <button class="btn" data-a="start" style="margin-top:10px">Prüfung beginnen</button></div>`;
  el.querySelector('[data-a=start]').onclick = async () => {
    const dur = +el.querySelector('#dur').value, style = el.querySelector('#style').value, focus = el.querySelector('#focus').value;
    store.update(s => { s.settings.speakQuestions = el.querySelector('#speak').checked; }, { silent: true });
    el.innerHTML = busy('Prüferin bereitet sich vor …');
    const prog = store.state.progress.chapters;
    let pool = chs;
    if (focus === 'schwach') pool = [...chs].sort((a, b) => (prog[a.id]?.mastery || 0) - (prog[b.id]?.mastery || 0)).slice(0, 6);
    else if (focus !== 'alle') pool = chs.filter(c => c.id === focus);
    let protocols = '';
    for (const f of Object.values(sub.files).filter(f => f.category === 'protocols').slice(0, 8)) {
      try { protocols += `\n--- ${f.name} ---\n` + (await getFileText(sub, f.id)).text.slice(0, 15000); } catch {}
    }
    const material = clip(pool.map(summaryDigest).join('\n\n'), 160000);
    const system = `Du bist Prüferin bei einer mündlichen Prüfung im Fach ${sub.name} an einer österreichischen Universität. Stil: ${style}. Dauer: ca. ${dur} Minuten, also etwa ${Math.round(dur / 2)} Fragen.\nREGELN:\n- Stelle immer nur EINE Frage und warte auf die Antwort.\n- Hake nach, wenn die Antwort unvollständig oder ungenau ist ("Und was gilt, wenn …?", "Woraus ergibt sich das?").\n- Wechsle zwischen Themen, mische Definitionen, Abgrenzungen, kleine Fälle.\n- Erkläre während der Prüfung NICHT ausführlich, gib höchstens kurze Hinweise wie eine echte Prüferin.\n- Frage nur Stoff aus dem Material unten.${protocols ? '\n- Orientiere dich an den Prüferprotokollen: Was dort oft gefragt wird, fragst du bevorzugt.' : ''}\n- Wenn die Zeit um ist, sag "Danke, das war's." und nichts weiter.\n\nPRÜFUNGSSTOFF (Zusammenfassungen der Lehrbuchkapitel):\n${material}${protocols ? '\n\nPRÜFERPROTOKOLLE:\n' + protocols : ''}`;
    const history = [{ role: 'user', content: 'Guten Tag, ich bin bereit. Bitte beginnen Sie mit der Prüfung.', hidden: true }];
    const started = Date.now();
    el.innerHTML = `<div class="notice small">Antworte wie in der echten Prüfung – am besten per 🎤. Mit „Prüfung beenden“ bekommst du Note und Feedback.</div><div id="chat"></div><button class="btn danger block" data-a="end" style="margin-top:10px">Prüfung beenden & bewerten</button>`;
    const chat = mountChat(el.querySelector('#chat'), { history, system, speak: true, placeholder: 'Deine Antwort …', emptyText: '' });
    // erste Frage holen
    try {
      const first = await complete({ system, messages: [{ role: 'user', content: history[0].content }], model: 'smart', maxTokens: 800 });
      history.push({ role: 'assistant', content: first }); chat.render();
      if (store.state.settings.speakQuestions) speak(first);
    } catch (e) { toast(e.message, 6000); }
    el.querySelector('[data-a=end]').onclick = async () => {
      if (history.filter(m => m.role === 'user' && !m.hidden).length < 2) { toast('Beantworte zuerst ein paar Fragen'); return; }
      window.speechSynthesis?.cancel();
      const transcript = history.filter(m => !m.hidden).map(m => (m.role === 'user' ? 'KANDIDATIN: ' : 'PRÜFERIN: ') + m.content).join('\n\n');
      el.innerHTML = busy('Bewerte die Prüfung …');
      try {
        const g = await completeJson({
          model: 'smart', maxTokens: 4000,
          system: 'Du bewertest eine mündliche Prüfung nach österreichischem Notensystem (1 = Sehr gut bis 5 = Nicht genügend), fair und konkret.',
          messages: [{ role: 'user', content: `KAPITEL (ID | Titel):\n${pool.map(c => c.id + ' | ' + c.title).join('\n')}\n\nPRÜFUNGSPROTOKOLL:\n${transcript}\n\nJSON: {"note": 1-5, "zusammenfassung": "ein Satz", "staerken": ["…"], "schwaechen": ["…"], "themen": [{"kapitelId": "…", "bewertung": 0.0-1.0}], "fachsprache": "Kommentar zu Ausdruck und Struktur", "tipps": ["…"]}` }]
        });
        for (const t of g.themen || []) if (findChapter(sub, t.kapitelId)) recordResult([t.kapitelId], Math.max(0, Math.min(1, Number(t.bewertung) || 0)), 'muendlich');
        store.update(s => { s.progress.orals.push({ at: Date.now(), subId, examId, note: g.note, summary: g.zusammenfassung, minutes: Math.round((Date.now() - started) / 60000) }); }, { silent: true });
        el.innerHTML = `<div class="card" style="text-align:center"><div class="small muted">Note</div><div style="font-size:3rem;font-weight:700">${esc(g.note)}</div><p>${esc(g.zusammenfassung)}</p></div>
          <div class="card">${g.staerken?.length ? `<h4>Stärken</h4><ul>${g.staerken.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}${g.schwaechen?.length ? `<h4>Schwächen</h4><ul>${g.schwaechen.map(x => `<li>${enrich(esc(x))}</li>`).join('')}</ul>` : ''}
          ${g.fachsprache ? `<h4>Ausdruck & Struktur</h4>${md(g.fachsprache)}` : ''}${g.tipps?.length ? `<h4>Tipps</h4><ul>${g.tipps.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}</div>
          <details class="card"><summary>Prüfungsverlauf</summary>${md(transcript)}</details>
          <a class="btn block" href="#/fach/${subId}/muendlich">Fertig</a>`;
      } catch (e) { el.innerHTML = errorBox(e); }
    };
  };
}

// ======================= Einstufungstest =======================
// Vorsichtige Schätzung: wenige Fragen dürfen nicht zu extremen Werten führen (Glück/Pech ausgleichen)
const PRIOR = { basis: 0.35, vertiefung: 0.2 }, PRIOR_WEIGHT = 2;
export function smoothed(correct, total, level) {
  return (correct + PRIOR[level] * PRIOR_WEIGHT) / (total + PRIOR_WEIGHT);
}

const DEPTH = {
  normal: { label: 'Gründlich – 6 Fragen pro Kapitel (4 Basis, 2 Vertiefung), bei unklarem Ergebnis 3 Nachfragen', basis: 4, vert: 2, extra: 3 },
  genau: { label: 'Sehr genau – 9 Fragen pro Kapitel (6 Basis, 3 Vertiefung), bei unklarem Ergebnis 3 Nachfragen', basis: 6, vert: 3, extra: 3 },
  kurz: { label: 'Kurz – 4 Fragen pro Kapitel (3 Basis, 1 Vertiefung), nur als grobe Orientierung', basis: 3, vert: 1, extra: 2 }
};

const PRECISION = `Anforderungen an jede Frage:
- Sie prüft VERSTÄNDNIS eines prüfungsrelevanten Punkts des Kapitels, nicht Auswendiglernen von Formulierungen.
- Jede Frage deckt einen ANDEREN Teilaspekt des Kapitels ab (keine zwei Fragen zum selben Punkt).
- Genau eine Antwort ist eindeutig richtig; die drei falschen Antworten sind typische, plausible Fehlvorstellungen – keine offensichtlich absurden Optionen, keine „alle/keine der genannten“, keine Fangfragen über Wortlaut.
- Antwortoptionen sind ungefähr gleich lang, damit die richtige nicht an der Länge erkennbar ist.
- Anwendungsfragen nutzen einen kurzen, klaren Mini-Sachverhalt.
- Die Erklärung begründet die richtige Antwort mit Seitenangabe aus dem Lehrbuchtext.`;

async function makeQuestions(sub, chapters, per) {
  let material = '';
  for (const c of chapters) {
    let t = '';
    try { t = await chapterText(sub, c.id); } catch {}
    material += `\n\n# KAPITEL [ID ${c.id}] „${c.title}“\n` + (t ? clip(t, Math.floor(180000 / chapters.length)) : summaryDigest(c));
  }
  const r = await completeJson({
    model: 'smart', maxTokens: 12000,
    system: 'Du erstellst präzise Diagnosefragen, um den Kenntnisstand pro Kapitel zuverlässig einzuschätzen. Grundlage ist ausschließlich der Lehrbuchtext.',
    messages: [{ role: 'user', content: `Erstelle für JEDES Kapitel unten Multiple-Choice-Fragen mit je 4 Optionen: ${per.basis} Fragen zum BASISWISSEN (davon mind. eine Anwendung auf einen Mini-Fall bzw. ein Prüfungsschema) und ${per.vert} Frage(n) zur VERTIEFUNG.\n${PRECISION}\nJSON: {"fragen":[{"kapitelId":"…","frage":"…","optionen":["…","…","…","…"],"richtig":0-3,"erklaerung":"…","seite":"S. …","ebene":"basis|vertiefung"}]}\n${material}` }]
  });
  return normalizeQuestions(r, chapters, per);
}

// KI-Antworten robust auswerten: verschiedene Feldnamen, Kapitelzuordnung notfalls über Titel oder Reihenfolge
export function normalizeQuestions(r, chapters, per = { basis: 4, vert: 2 }) {
  const raw = Array.isArray(r) ? r : (r.fragen || r.questions || r.items || Object.values(r).find(Array.isArray) || []);
  const norm = x => String(x || '').toLowerCase().replace(/[^a-z0-9äöüß]+/g, '');
  const perCh = (per.basis || 0) + (per.vert || 0) || 6;
  const out = [];
  raw.forEach((q, idx) => {
    const optionen = q.optionen || q.antworten || q.options || q.answers;
    if (!Array.isArray(optionen) || optionen.length < 2) return;
    let richtig = q.richtig ?? q.correct ?? q.loesung ?? q.answer;
    if (typeof richtig === 'string') { const n = parseInt(richtig, 10); richtig = !isNaN(n) ? n : optionen.findIndex(o => norm(o) === norm(richtig)); if (richtig < 0) richtig = 'ABCD'.indexOf(String(q.richtig).trim().toUpperCase()[0]); }
    if (typeof richtig !== 'number' || richtig < 0 || richtig >= optionen.length) return;
    let id = String(q.kapitelId || q.kapitel || q.chapterId || '').replace(/^ID\s*/i, '').trim();
    let ch = chapters.find(c => c.id === id) || chapters.find(c => id && (id.includes(c.id) || c.id.includes(id))) || chapters.find(c => id && norm(c.title) === norm(id));
    if (!ch) ch = chapters.length === 1 ? chapters[0] : chapters[Math.min(chapters.length - 1, Math.floor(idx / perCh))];
    out.push({ ...q, frage: q.frage || q.question || q.text, optionen, richtig, kapitelId: ch.id, erklaerung: q.erklaerung || q.explanation || '', opts: shuffle(optionen.map((o, i) => ({ text: o, ok: i === richtig }))) });
  });
  return out.filter(q => q.frage);
}

export function assessmentView(el, subId, examId, onlyChapter) {
  const sub = store.subject(subId);
  const exam = sub?.exams.find(e => e.id === examId);
  if (!exam) return;
  setTitle('Einstufung');
  noRerender(el);
  const chs = allChapters(sub, { exam }).filter(c => c.summary && (!exam.scopeMap || exam.scopeMap[c.id] !== 'raus'));
  const prog = store.state.progress.chapters;
  if (!chs.length) { el.innerHTML = '<div class="card">Zuerst müssen die Lehrbücher verarbeitet sein (Zusammenfassungen).</div>'; return; }
  let per = DEPTH[sessionStorage.getItem('assessDepth')] || DEPTH.normal;
  if (onlyChapter) {
    const c = chs.find(x => x.id === onlyChapter) || allChapters(sub).find(x => x.id === onlyChapter);
    if (c) { run([c], per, { title: c.title }); return; }
  }

  // Aufteilung: pro Lehrbuch, darin Teile mit höchstens 8 Kapiteln
  const parts = [];
  const byBook = new Map();
  chs.forEach(c => { if (!byBook.has(c.bookId)) byBook.set(c.bookId, { title: c.bookTitle, chapters: [] }); byBook.get(c.bookId).chapters.push(c); });
  for (const [bookId, b] of byBook) {
    const n = Math.ceil(b.chapters.length / 8);
    const size = Math.ceil(b.chapters.length / n);
    for (let i = 0; i < n; i++) {
      const list = b.chapters.slice(i * size, (i + 1) * size);
      parts.push({ key: bookId + ':' + i, book: b.title, label: n > 1 ? `Teil ${i + 1} von ${n}` : 'Alle Kapitel', list, first: list[0]?.title, last: list[list.length - 1]?.title });
    }
  }
  const doneCount = p => p.list.filter(c => prog[c.id]?.assessed).length;
  const nextPart = parts.find(p => doneCount(p) < p.list.length);
  const totalDone = chs.filter(c => prog[c.id]?.assessed).length;
  const minutes = p => Math.round(p.list.length * (per.basis + per.vert) * 0.6);

  el.innerHTML = `<div class="card"><h3>Einstufungstest: ${esc(exam.name)}</h3>
    <p class="small">Aufgeteilt nach Lehrbüchern in überschaubare Teile. Mach einen Teil, wann es dir passt – der Lernplan rechnet sofort mit jedem fertigen Teil.</p>
    <div class="progress green" style="margin:8px 0 4px"><div style="width:${Math.round(100 * totalDone / chs.length)}%"></div></div>
    <div class="tiny muted">${totalDone} von ${chs.length} Kapiteln eingestuft</div>
    <label class="field" style="margin-top:12px"><span>Genauigkeit</span><select id="depth">${Object.entries(DEPTH).map(([k, d]) => `<option value="${k}" ${DEPTH[k] === per ? 'selected' : ''}>${esc(d.label)}</option>`).join('')}</select></label>
    ${nextPart ? `<button class="btn block" data-part="${nextPart.key}">▶ Als Nächstes: ${esc(nextPart.book)} – ${esc(nextPart.label)} <span class="tiny" style="opacity:.8">(ca. ${minutes(nextPart)} Min)</span></button>` : '<div class="notice ok small">Alles eingestuft. Du kannst einzelne Teile jederzeit wiederholen.</div>'}
    <p class="small muted" style="margin-top:10px">Wenn du etwas nicht weißt, wähle „Weiß ich nicht“. Hast du nur geraten, tippe vorher auf „🎲 Ich rate“ – geratene Treffer zählen nur halb.</p></div>
    ${[...byBook.values()].map(b => `<div class="card"><h3>📘 ${esc(b.title)}</h3><ul class="list">${parts.filter(p => p.book === b.title).map(p => {
      const d = doneCount(p);
      const avg = d ? p.list.filter(c => prog[c.id]?.assessed).reduce((a, c) => a + prog[c.id].mastery, 0) / d : 0;
      return `<li><div class="row between"><div style="flex:1;min-width:0"><div class="item-title">${esc(p.label)} ${d === p.list.length ? `<span class="dot ${ampel(avg, true)}"></span>` : ''}</div>
        <div class="tiny muted">${p.list.length} Kapitel: ${esc(p.first)}${p.list.length > 1 ? ' … ' + esc(p.last) : ''} · ${d}/${p.list.length} eingestuft · ca. ${minutes(p)} Min</div></div>
        <button class="btn ${d === p.list.length ? 'secondary' : ''} small" data-part="${p.key}">${d === 0 ? 'Starten' : d < p.list.length ? 'Weiter' : 'Wiederholen'}</button></div></li>`;
    }).join('')}</ul></div>`).join('')}`;
  el.querySelector('#depth').onchange = e => { sessionStorage.setItem('assessDepth', e.target.value); per = DEPTH[e.target.value]; assessmentView(el, subId, examId); };
  el.querySelectorAll('[data-part]').forEach(b => b.onclick = () => {
    const p = parts.find(x => x.key === b.dataset.part);
    const open = p.list.filter(c => !prog[c.id]?.assessed);
    run(open.length ? open : p.list, per, { title: `${p.book} – ${p.label}` });
  });

  async function run(list, per, info = {}) {
    const batches = [];
    for (let i = 0; i < list.length; i += 3) batches.push(list.slice(i, i + 3));
    let b = 0;

    // Fragen eines Blocks stellen; liefert score[kapitelId] = { basis:[r,n], vertiefung:[r,n] }
    const ask = (qs, score, label) => new Promise(resolve => {
      let i = 0, guess = false;
      const show = () => {
        if (i >= qs.length) { resolve(); return; }
        const q = qs[i];
        const ch = list.find(c => c.id === q.kapitelId);
        guess = false;
        el.innerHTML = `<div class="card"><div class="small muted">${esc(label)} · Frage ${i + 1}/${qs.length} · ${esc(ch?.title || '')} ${lvlPill(q)}</div>
          <div class="progress" style="margin:8px 0 12px"><div style="width:${(i / qs.length) * 100}%"></div></div>
          <div class="item-title" style="margin:10px 0;font-size:1.05rem">${enrich(esc(q.frage))}</div>
          ${q.opts.map((o, k) => `<button class="mc-option" data-k="${k}">${enrich(esc(o.text))}</button>`).join('')}
          <div class="row" style="margin-top:6px"><button class="btn ghost small" data-guess>🎲 Ich rate</button><button class="mc-option" data-k="-1" style="color:var(--muted);flex:1;margin:0">Weiß ich nicht</button></div><div id="fb"></div></div>`;
        el.querySelector('[data-guess]').onclick = e => { guess = !guess; e.target.closest('button').classList.toggle('on', guess); e.target.closest('button').textContent = guess ? '🎲 geraten ✓' : '🎲 Ich rate'; };
        el.querySelectorAll('.mc-option').forEach(btn => btn.onclick = () => {
          const k = +btn.dataset.k;
          const ok = k >= 0 && q.opts[k].ok;
          const l = lvlOf(q);
          score[q.kapitelId] = score[q.kapitelId] || { basis: [0, 0], vertiefung: [0, 0] };
          score[q.kapitelId][l][1]++;
          if (ok) score[q.kapitelId][l][0] += guess ? 0.5 : 1;
          el.querySelectorAll('.mc-option').forEach((bb, j) => { bb.disabled = true; if (j < q.opts.length && q.opts[j].ok) bb.classList.add('correct'); else if (+bb.dataset.k === k) bb.classList.add('wrong'); });
          el.querySelector('#fb').innerHTML = `<div class="small" style="margin:10px 0">${q.seite ? `<span class="cite">[${esc(String(q.seite).replace(/^\[|\]$/g, ''))}]</span> ` : ''}${enrich(esc(q.erklaerung || ''))}</div><button class="btn block" data-a="n">Weiter</button>`;
          el.querySelector('[data-a=n]').onclick = () => { i++; show(); };
        });
      };
      show();
    });

    // Fragen für den nächsten Block schon im Hintergrund erstellen
    const pending = {};
    const prepare = i => { if (i < batches.length && !pending[i]) { pending[i] = makeQuestions(sub, batches[i], per); pending[i].catch(() => {}); } return pending[i]; };
    const next = async () => {
      if (b >= batches.length) {
        const allDone = allChapters(sub, { exam }).filter(c => c.summary).every(c => store.state.progress.chapters[c.id]?.assessed);
        store.update(s => { const ex = s.subjects.find(x => x.id === subId).exams.find(x => x.id === examId); if (allDone || !ex.assessment) ex.assessment = { at: Date.now(), partial: !allDone }; });
        el.innerHTML = `<div class="card" style="text-align:center"><h3>${esc(info.title || 'Teil')} geschafft 🎉</h3><p>Der Lernplan rechnet ab sofort mit diesen Ergebnissen. Die Werte werden mit jedem weiteren Test, jeder Karteikarte und jedem Fall genauer.</p>
          <div class="row" style="justify-content:center"><a class="btn" href="#/fach/${subId}/einstufung/${examId}">Zur Übersicht der Teile</a><a class="btn secondary" href="#/fach/${subId}/pruefung/${examId}">Zum Lernplan</a></div></div>`;
        el.removeAttribute('data-no-rerender');
        return;
      }
      const batch = batches[b];
      el.innerHTML = busy(`Erstelle Fragen aus dem Lehrbuchtext (Block ${b + 1} von ${batches.length}) …`);
      const score = {};
      try {
        let qs = await prepare(b);
        if (!qs.length) {
          // zweiter Versuch: jedes Kapitel einzeln (kürzere, sicherere Anfragen)
          el.innerHTML = busy('Erstelle die Fragen nochmal, diesmal Kapitel für Kapitel …');
          qs = [];
          for (const c of batch) { try { qs.push(...await makeQuestions(sub, [c], per)); } catch (e) { console.warn(e); } }
        }
        prepare(b + 1);
        if (!qs.length) throw new Error('Die KI hat keine verwertbaren Fragen geliefert. Bitte nochmal versuchen – falls es wieder passiert, schick mir einen Screenshot.');
        await ask(qs, score, `Block ${b + 1}/${batches.length}`);
        // Unklare Kapitel: gezielte Nachfragen
        const unclear = batch.filter(c => { const sc = score[c.id]; if (!sc || !sc.basis[1]) return false; const f = sc.basis[0] / sc.basis[1]; return f > 0.2 && f < 0.85; });
        if (unclear.length && per.extra) {
          el.innerHTML = busy(`Ein paar Nachfragen zu ${unclear.length} Kapitel(n), damit die Einstufung sicher ist …`);
          const qs2 = await makeQuestions(sub, unclear, { basis: per.extra, vert: 0 });
          if (qs2.length) await ask(qs2, score, 'Nachfragen');
        }
      } catch (e) { delete pending[b]; el.innerHTML = errorBox(e) + '<button class="btn small" data-a="r">Nochmal</button>'; el.querySelector('[data-a=r]').onclick = next; return; }

      store.update(s => {
        for (const c of batch) {
          const sc = score[c.id]; if (!sc) continue;
          const p = s.progress.chapters[c.id] || (s.progress.chapters[c.id] = { mastery: 0, assessed: false, quizzes: [], studied: 0, lastStudied: 0 });
          p.levels = {
            basis: sc.basis[1] ? smoothed(sc.basis[0], sc.basis[1], 'basis') : null,
            vertiefung: sc.vertiefung[1] ? smoothed(sc.vertiefung[0], sc.vertiefung[1], 'vertiefung') : null
          };
          p.assessN = sc.basis[1] + sc.vertiefung[1];
          p.mastery = combineLevels(p.levels); p.assessed = true; p.assessedAt = Date.now();
          setBaseline(p);
        }
      });
      b++;
      el.innerHTML = `<div class="card" style="text-align:center"><p>${esc(info.title || '')}<br>Block ${b} von ${batches.length} geschafft.</p>${batch.map(c => { const sc = score[c.id]; if (!sc) return ''; const p = store.state.progress.chapters[c.id]; return `<div class="row" style="justify-content:center"><span class="dot ${ampel(p.mastery, true)}"></span><span class="small">${esc(c.title)}: Basis ${sc.basis[0]}/${sc.basis[1]} · Vertiefung ${sc.vertiefung[0]}/${sc.vertiefung[1]}</span></div>`; }).join('')}
        <p class="tiny muted">Die Einstufung ist bewusst vorsichtig: Einzelne Treffer oder Fehler verschieben das Ergebnis nur begrenzt.</p>
        <div class="row" style="justify-content:center;margin-top:12px"><button class="btn" data-a="go">${b < batches.length ? 'Weiter' : 'Abschließen'}</button><a class="btn secondary" href="#/fach/${subId}/einstufung/${examId}">Pause</a></div></div>`;
      el.querySelector('[data-a=go]').onclick = next;
    };
    next();
  }
}
