// Vercel-Funktion: tauscht den Google-Anmeldecode gegen Zugang + Refresh-Token (das Client-Secret bleibt am Server)
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  const code = req.body && req.body.code;
  if (!code) return res.status(400).json({ error: 'code fehlt' });
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, redirect_uri: 'postmessage', grant_type: 'authorization_code' })
  });
  const j = await r.json();
  res.status(r.status).json({ access_token: j.access_token, expires_in: j.expires_in, refresh_token: j.refresh_token, error: j.error, error_description: j.error_description });
};
