// Leitet Anfragen an die Message-Batches-API von Anthropic weiter (Hintergrund-Modus, halber Preis).
// Der Browser darf diese Schnittstelle nicht direkt aufrufen; der eigene Claude-Schlüssel wird nur durchgereicht, nie gespeichert.
module.exports = async (req, res) => {
  const q = { ...req.query };
  const path = Array.isArray(q.path) ? q.path.join('/') : String(q.path || '');
  if (!/^messages\/batches(\/[A-Za-z0-9_-]+(\/(results|cancel))?)?$/.test(path)) { res.status(400).json({ error: { message: 'ungültiger Pfad' } }); return; }
  const key = req.headers['x-api-key'];
  if (!key) { res.status(401).json({ error: { message: 'Kein Claude-Schlüssel' } }); return; }
  try {
    const headers = { 'x-api-key': key, 'anthropic-version': req.headers['anthropic-version'] || '2023-06-01' };
    if (req.headers['anthropic-beta']) headers['anthropic-beta'] = req.headers['anthropic-beta'];
    let body;
    if (req.method === 'POST') { headers['content-type'] = 'application/json'; body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {}); }
    const r = await fetch('https://api.anthropic.com/v1/' + path, { method: req.method, headers, body, redirect: 'follow' });
    const text = await r.text();
    res.setHeader('Content-Type', r.headers.get('content-type') || 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.status(r.status).send(text);
  } catch (e) {
    res.status(502).json({ error: { message: 'Anthropic nicht erreichbar: ' + e.message } });
  }
};
