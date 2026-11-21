// Holt ein Dokument von www.ris.bka.gv.at (Entscheidungstexte, Rechtssätze, Gesetzestexte) – serverseitig,
// weil der Browser das RIS wegen fehlender CORS-Freigabe nicht direkt abfragen darf.
module.exports = async (req, res) => {
  const q = { ...req.query };
  let path = Array.isArray(q.path) ? q.path.join('/') : String(q.path || '');
  delete q.path;
  const rest = new URLSearchParams(q).toString();
  if (rest) path += (path.includes('?') ? '&' : '?') + rest;
  if (!/^(Dokumente\/|NormDokument\.wxe|Dokument\.wxe)/.test(path)) { res.status(400).send('ungültiger Pfad'); return; }
  try {
    const r = await fetch('https://www.ris.bka.gv.at/' + path, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Jus-Lernapp; private Lernhilfe)', Accept: 'text/html,application/xhtml+xml,*/*', 'Accept-Language': 'de-AT,de;q=0.9' },
      redirect: 'follow'
    });
    const body = await r.text();
    res.setHeader('Content-Type', r.headers.get('content-type') || 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.status(r.status).send(body);
  } catch (e) {
    res.status(502).send('RIS nicht erreichbar: ' + e.message);
  }
};
