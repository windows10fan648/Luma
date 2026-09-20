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

app.post('/api/channels', requireAuth, async (req, res) => {
  const name = String(req.body.name || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 40);
  if (!name) return res.status(400).json({ error: 'Channel name is required.' });
  try {
    const [workspace] = await query('SELECT id FROM workspaces LIMIT 1');
    const [position] = await query('SELECT COALESCE(MAX(position), -1) + 1 AS next_position FROM channels WHERE workspace_id = ?', [workspace.id]);
    const result = await query('INSERT INTO channels (workspace_id, name, description, type, position) VALUES (?, ?, ?, ?, ?)', [workspace.id, name, String(req.body.description || ''), 'text', position.next_position]);
    res.status(201).json({ id: result.insertId, name, description: String(req.body.description || ''), type: 'text', position: position.next_position });
  } catch (error) { if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'That channel already exists.' }); console.error(error); res.status(503).json({ error: 'Unable to create channel.' }); }
});

app.delete('/api/channels/:channelId', requireAuth, async (req, res) => {
  try { await query('DELETE FROM channels WHERE id = ?', [req.params.channelId]); res.json({ ok: true }); } catch (error) { console.error(error); res.status(503).json({ error: 'Unable to delete channel.' }); }
});

app.get('/api/channels/:channelId/messages', requireAuth, async (req, res) => {
  try {
    const messages = await query(`
      SELECT messages.id, messages.author_id, messages.content, messages.parent_id, messages.edited_at, messages.created_at, users.username, users.display_name,
        (SELECT COUNT(*) FROM message_reactions WHERE message_reactions.message_id = messages.id) AS reaction_count
      FROM messages JOIN users ON users.id = messages.author_id
      WHERE messages.channel_id = ? AND messages.deleted_at IS NULL ORDER BY messages.created_at ASC LIMIT 100
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
    const [message] = await query('SELECT id, author_id, content, parent_id, edited_at, created_at, ? AS username, ? AS display_name, 0 AS reaction_count FROM messages WHERE id = ?', [user.username, user.display_name, result.insertId]);
    res.status(201).json(message);
  } catch (error) {
    console.error(error);
    res.status(503).json({ error: 'Unable to send message.' });
  }
});

app.patch('/api/messages/:messageId', requireAuth, async (req, res) => {
  const content = String(req.body.content || '').trim();
  if (!content || content.length > 2000) return res.status(400).json({ error: 'Message must be between 1 and 2000 characters.' });
  try { const result = await query('UPDATE messages SET content = ?, edited_at = NOW() WHERE id = ? AND author_id = ? AND deleted_at IS NULL', [content, req.params.messageId, req.user.id]); if (!result.affectedRows) return res.status(403).json({ error: 'You can only edit your own messages.' }); res.json({ ok: true }); } catch (error) { console.error(error); res.status(503).json({ error: 'Unable to edit message.' }); }
});

app.delete('/api/messages/:messageId', requireAuth, async (req, res) => {
  try { const result = await query('UPDATE messages SET deleted_at = NOW() WHERE id = ? AND author_id = ?', [req.params.messageId, req.user.id]); if (!result.affectedRows) return res.status(403).json({ error: 'You can only delete your own messages.' }); res.json({ ok: true }); } catch (error) { console.error(error); res.status(503).json({ error: 'Unable to delete message.' }); }
});

app.post('/api/messages/:messageId/reactions', requireAuth, async (req, res) => {
  const emoji = String(req.body.emoji || '').trim().slice(0, 32); if (!emoji) return res.status(400).json({ error: 'Emoji is required.' });
  try { const existing = await query('SELECT message_id FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?', [req.params.messageId, req.user.id, emoji]); if (existing.length) await query('DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?', [req.params.messageId, req.user.id, emoji]); else await query('INSERT INTO message_reactions (message_id, user_id, emoji) VALUES (?, ?, ?)', [req.params.messageId, req.user.id, emoji]); const [count] = await query('SELECT COUNT(*) AS count FROM message_reactions WHERE message_id = ?', [req.params.messageId]); res.json({ active: !existing.length, count: count.count }); } catch (error) { console.error(error); res.status(503).json({ error: 'Unable to update reaction.' }); }
});

app.post('/api/invites', requireAuth, async (req, res) => {
  try { const [workspace] = await query('SELECT id FROM workspaces LIMIT 1'); const code = crypto.randomBytes(16).toString('hex'); await query('INSERT INTO workspace_invites (code, workspace_id, created_by, expires_at) VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL 7 DAY))', [code, workspace.id, req.user.id]); res.status(201).json({ code, url: `/auth?invite=${code}` }); } catch (error) { console.error(error); res.status(503).json({ error: 'Unable to create invite.' }); }
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
