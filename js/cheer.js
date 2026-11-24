// Lob & Motivation – kostenlos, ganz lokal
const KEY = 'cheer';
const today = () => new Date().toISOString().slice(0, 10);
function load() {
  let s; try { s = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { s = {}; }
  if (s.day !== today()) { s.day = today(); s.todayRight = 0; s.todayAll = 0; }
  return s;
}
const save = s => { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch {} };
let streak = 0;

const pick = a => a[Math.floor(Math.random() * a.length)];
const RIGHT = [
  'Richtig! 🎉', 'Genau so! 💪', 'Sehr gut – das sitzt! ✨', 'Top, das hast du drauf! 🌟', 'Richtig – wie im Lehrbuch! 📘',
  'Bravo! 👏', 'Stark! Das war nicht leicht. 💜', 'Perfekt erkannt! 🎯', 'Leiwand – richtig! 😄', 'Ja! Du wirst richtig gut darin. 🌸',
  'Richtig – die Prüferin wäre zufrieden! ⚖️', 'Sauber gelöst! ✅', 'Das war juristisch einwandfrei. 🧠',
];
const PARTIAL = ['Schon gut dabei! Der Rest kommt noch. 🌱', 'Halb richtig ist auch schon was – weiter so! 💛', 'Fast! Du bist auf dem richtigen Weg. 🙂'];
const WRONG = [
  'Kein Problem – genau so lernt man. 🌱', 'Nicht schlimm! Beim nächsten Mal sitzt es. 💛', 'Gut, dass es jetzt passiert und nicht in der Klausur. 😉',
  'Fehler sind Lernmomente – lies kurz die Erklärung. 📖', 'Das ist eine typische Falle – jetzt kennst du sie! 🧩',
];
const STREAK = { 3: '3 richtig in Folge! 🔥', 5: '5 in Folge – du bist im Flow! 🔥🔥', 8: '8 in Folge! Unglaublich! 🚀', 12: '12 in Folge – Klausurniveau! 🏆', 20: '20 in Folge!!! 👑' };
const DAILY = { 10: 'Schon 10 richtige Antworten heute! 🌟', 25: '25 richtige heute – starker Lerntag! 💪', 50: '50 richtige heute – Wahnsinn! 🏆', 100: '100 richtige heute! Du bist eine Maschine! 👑' };

// result: 1 = richtig, 0.5 = teilweise, 0 = falsch
export function cheer(result, { silent = false } = {}) {
  const s = load();
  s.todayAll = (s.todayAll || 0) + 1;
  let first = false;
  if (s.lastActive !== today()) { first = true; s.days = (s.lastActive === new Date(Date.now() - 86400000).toISOString().slice(0, 10) ? (s.days || 0) : 0) + 1; s.lastActive = today(); }
  let msg, big = false;
  if (result >= 1) {
    streak++; s.todayRight = (s.todayRight || 0) + 1; s.totalRight = (s.totalRight || 0) + 1;
    msg = pick(RIGHT);
    if (STREAK[streak]) { msg = STREAK[streak]; big = true; }
    else if (DAILY[s.todayRight]) { msg = DAILY[s.todayRight]; big = true; }
  } else if (result > 0) { streak = 0; msg = pick(PARTIAL); }
  else { streak = 0; msg = pick(WRONG); }
  if (first && s.days > 1) { msg += ` · Tag ${s.days} in Folge am Lernen! 📅`; big = true; }
  save(s);
  if (!silent) show(msg, result >= 1 ? 'ok' : result > 0 ? 'mid' : 'soft', big || (result >= 1 && Math.random() < 0.25));
  return msg;
}
export function cheerText(result) { return result >= 1 ? pick(RIGHT) : result > 0 ? pick(PARTIAL) : pick(WRONG); }
export function finishText(frac) {
  if (frac >= 0.9) return pick(['Fantastisch – fast alles richtig! 🏆', 'Hervorragend! Das Kapitel hast du im Griff. 👑']);
  if (frac >= 0.7) return pick(['Sehr gut gemacht! Nur noch ein paar Kleinigkeiten. 🌟', 'Starke Leistung! 💪']);
  if (frac >= 0.5) return pick(['Gut! Mehr als die Hälfte sitzt schon – die Lücken holst du auf. 🌱', 'Ordentlich! Mit einer Wiederholung wird das richtig gut. 💛']);
  return pick(['Jeder Anfang ist schwer – du hast es versucht, das zählt! 🌱 Lies die Zusammenfassung nochmal und probier es dann wieder.', 'Kopf hoch! Jetzt weißt du genau, wo die Lücken sind. 💛']);
}
export function todayStats() { const s = load(); return { right: s.todayRight || 0, all: s.todayAll || 0, days: s.lastActive === today() ? s.days || 1 : 0 }; }

function show(msg, kind, confetti) {
  document.querySelectorAll('.cheer').forEach(x => x.remove());
  const el = document.createElement('div');
  el.className = 'cheer cheer-' + kind;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.classList.add('out'), 2200);
  setTimeout(() => el.remove(), 2700);
  if (confetti) burst();
}
function burst() {
  const colors = ['#f7c6d9', '#c6def7', '#cdeccf', '#fff0a8', '#dccff4', '#ffd8bd', '#bfeee0'];
  const box = document.createElement('div'); box.className = 'confetti';
  for (let i = 0; i < 36; i++) {
    const p = document.createElement('i');
    p.style.left = Math.random() * 100 + 'vw';
    p.style.background = colors[i % colors.length];
    p.style.animationDelay = Math.random() * 0.4 + 's';
    p.style.transform = `rotate(${Math.random() * 360}deg)`;
    box.appendChild(p);
  }
  document.body.appendChild(box);
  setTimeout(() => box.remove(), 2600);
}
