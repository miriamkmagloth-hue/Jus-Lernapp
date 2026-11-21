// Vercel-Funktion: erneuert den Google-Zugang mit dem Refresh-Token
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  const rt = req.body && req.body.refresh_token;
  if (!rt) return res.status(400).json({ error: 'refresh_token fehlt' });
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ refresh_token: rt, client_id: (process.env.GOOGLE_CLIENT_ID || '').trim(), client_secret: (process.env.GOOGLE_CLIENT_SECRET || '').trim(), grant_type: 'refresh_token' })
  });
  const j = await r.json();
  res.status(r.status).json({ access_token: j.access_token, expires_in: j.expires_in, error: j.error });
};
