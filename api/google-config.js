// Vercel-Funktion: verrät der App, ob die dauerhafte Google-Anmeldung eingerichtet ist (und die Client-ID)
module.exports = (req, res) => {
  const id = process.env.GOOGLE_CLIENT_ID || '';
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ enabled: !!(id && process.env.GOOGLE_CLIENT_SECRET), clientId: id });
};
