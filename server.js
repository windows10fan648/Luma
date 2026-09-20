const path = require('path');
const express = require('express');
const crypto = require('crypto');
require('dotenv').config();
const { initDatabase, query } = require('./db');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/auth', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'auth.html')));

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}
function passwordMatches(password, stored) {
  if (!stored) return false;
  const [salt, original] = stored.split(':');
  const hashed = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hashed, 'hex'), Buffer.from(original, 'hex'));
}
function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map((item) => { const index = item.indexOf('='); return [item.slice(0, index).trim(), decodeURIComponent(item.slice(index + 1).trim())]; }));
}
async function currentUser(req) {
  const token = cookies(req).luma_session;
  if (!token) return null;
  const [user] = await query('SELECT users.id, users.username, users.display_name, users.email, users.status FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token = ? AND sessions.expires_at > NOW()', [token]);
  return user || null;
}
async function requireAuth(req, res, next) {
  try { req.user = await currentUser(req); } catch (error) { console.error(error); return res.status(503).json({ error: 'Database unavailable.' }); }
  if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
  next();
}

app.post('/api/auth/signup', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase(); const username = String(req.body.username || '').trim().toLowerCase(); const displayName = String(req.body.displayName || username).trim(); const password = String(req.body.password || '');
  if (!/^\S+@\S+\.\S+$/.test(email) || !/^[a-z0-9_]{3,24}$/.test(username) || displayName.length < 2 || password.length < 8) return res.status(400).json({ error: 'Use a valid email, a 3–24 character username, and a password with at least 8 characters.' });
  try {
    if ((await query('SELECT id FROM users WHERE email = ? OR username = ?', [email, username])).length) return res.status(409).json({ error: 'That email or username is already in use.' });
    const result = await query('INSERT INTO users (username, display_name, email, password_hash) VALUES (?, ?, ?, ?)', [username, displayName, email, hashPassword(password)]);
    const token = crypto.randomBytes(32).toString('hex'); await query('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 30 DAY))', [token, result.insertId]);
    res.setHeader('Set-Cookie', `luma_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
    res.status(201).json({ user: { username, display_name: displayName, email } });
  } catch (error) { console.error(error); res.status(503).json({ error: 'Unable to create your account.' }); }
});

app.post('/api/auth/login', async (req, res) => {
  const login = String(req.body.login || '').trim().toLowerCase(); const password = String(req.body.password || '');
  try {
    const [user] = await query('SELECT id, username, display_name, email, password_hash FROM users WHERE email = ? OR username = ?', [login, login]);
    if (!user || !passwordMatches(password, user.password_hash)) return res.status(401).json({ error: 'That login or password is incorrect.' });
    const token = crypto.randomBytes(32).toString('hex'); await query('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 30 DAY))', [token, user.id]);
    res.setHeader('Set-Cookie', `luma_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
    res.json({ user: { username: user.username, display_name: user.display_name, email: user.email } });
  } catch (error) { console.error(error); res.status(503).json({ error: 'Unable to log in right now.' }); }
});
app.post('/api/auth/logout', async (req, res) => { try { const token = cookies(req).luma_session; if (token) await query('DELETE FROM sessions WHERE token = ?', [token]); } catch (error) { console.error(error); } res.setHeader('Set-Cookie', 'luma_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'); res.json({ ok: true }); });
app.get('/api/auth/me', async (req, res) => { try { const user = await currentUser(req); if (!user) return res.status(401).json({ error: 'Not logged in.' }); res.json({ user }); } catch { res.status(503).json({ error: 'Database unavailable.' }); } });

app.get('/api/workspace', requireAuth, async (req, res) => {
  try {
    const [workspace] = await query('SELECT id, name FROM workspaces LIMIT 1');
    const channels = await query('SELECT id, name, description, type, position FROM channels WHERE workspace_id = ? ORDER BY position', [workspace.id]);
    const members = await query('SELECT id, username, display_name, status FROM users WHERE password_hash IS NOT NULL ORDER BY display_name');
    res.json({ workspace, channels, members });
  } catch (error) {
    console.error(error);
    res.status(503).json({ error: 'Database unavailable. Check your environment variables.' });
  }
});

app.get('/api/channels/:channelId/messages', requireAuth, async (req, res) => {
  try {
    const messages = await query(`
      SELECT messages.id, messages.content, messages.created_at, users.username, users.display_name
      FROM messages JOIN users ON users.id = messages.author_id
      WHERE messages.channel_id = ? ORDER BY messages.created_at ASC LIMIT 100
    `, [req.params.channelId]);
    res.json(messages);
  } catch (error) {
    console.error(error);
    res.status(503).json({ error: 'Unable to load messages.' });
  }
});

app.post('/api/channels/:channelId/messages', requireAuth, async (req, res) => {
  const content = String(req.body.content || '').trim();
  if (!content || content.length > 2000) return res.status(400).json({ error: 'Message must be between 1 and 2000 characters.' });
  try {
    const user = req.user;
    const result = await query('INSERT INTO messages (channel_id, author_id, content) VALUES (?, ?, ?)', [req.params.channelId, user.id, content]);
    const [message] = await query('SELECT id, content, created_at, ? AS username, ? AS display_name FROM messages WHERE id = ?', [user.username, user.display_name, result.insertId]);
    res.status(201).json(message);
  } catch (error) {
    console.error(error);
    res.status(503).json({ error: 'Unable to send message.' });
  }
});

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'luma' });
});

app.use((_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

if (require.main === module) {
  app.listen(port, () => console.log(`Luma is glowing on port ${port}`));
}

module.exports = app;
