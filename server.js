const path = require('path');
const express = require('express');
const crypto = require('crypto');
require('dotenv').config();
const { initDatabase, query } = require('./db');
const pusher = require('./realtime');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/auth', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'auth.html')));
app.get('/friends', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'friends.html')));

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
async function membership(userId) {
  const [member] = await query('SELECT workspace_id, role, banned_until FROM workspace_members WHERE user_id = ? LIMIT 1', [userId]);
  if (member?.banned_until && new Date(member.banned_until) > new Date()) return null;
  return member || null;
}
async function requireMember(req, res, next) {
  try { req.membership = await membership(req.user.id); } catch (error) { console.error(error); return res.status(503).json({ error: 'Database unavailable.' }); }
  if (!req.membership) return res.status(403).json({ error: 'You do not have access to this workspace.' });
  next();
}
function canModerate(role) { return ['owner', 'admin', 'moderator'].includes(role); }

app.post('/api/auth/signup', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase(); const username = String(req.body.username || '').trim().toLowerCase(); const displayName = String(req.body.displayName || username).trim(); const password = String(req.body.password || '');
  if (!/^\S+@\S+\.\S+$/.test(email) || !/^[a-z0-9_]{3,24}$/.test(username) || displayName.length < 2 || password.length < 8) return res.status(400).json({ error: 'Use a valid email, a 3–24 character username, and a password with at least 8 characters.' });
  try {
    if ((await query('SELECT id FROM users WHERE email = ? OR username = ?', [email, username])).length) return res.status(409).json({ error: 'That email or username is already in use.' });
    const result = await query('INSERT INTO users (username, display_name, email, password_hash) VALUES (?, ?, ?, ?)', [username, displayName, email, hashPassword(password)]);
    const [workspace] = await query('SELECT id FROM workspaces LIMIT 1');
    if (workspace) await query('INSERT IGNORE INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)', [workspace.id, result.insertId, 'member']);
    const token = crypto.randomBytes(32).toString('hex'); await query('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 30 DAY))', [token, result.insertId]);
    res.setHeader('Set-Cookie', `luma_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
    res.status(201).json({ user: { username, display_name: displayName, email } });
  } catch (error) { console.error(error); res.status(503).json({ error: 'Unable to create your account.' }); }
});

app.post('/api/auth/login', async (req, res) => {
  const login = String(req.body.login || '').trim().toLowerCase(); const password = String(req.body.password || '');
  try {
    const [user] = await query('SELECT id, username, display_name, email, password_hash FROM users WHERE LOWER(email) = ? OR LOWER(username) = ? OR LOWER(display_name) = ?', [login, login, login]);
    if (!user || !passwordMatches(password, user.password_hash)) return res.status(401).json({ error: 'That login or password is incorrect.' });
    const token = crypto.randomBytes(32).toString('hex'); await query('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 30 DAY))', [token, user.id]);
    res.setHeader('Set-Cookie', `luma_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
    res.json({ user: { username: user.username, display_name: user.display_name, email: user.email } });
  } catch (error) { console.error(error); res.status(503).json({ error: 'Unable to log in right now.' }); }
});
app.post('/api/auth/logout', async (req, res) => { try { const token = cookies(req).luma_session; if (token) await query('DELETE FROM sessions WHERE token = ?', [token]); } catch (error) { console.error(error); } res.setHeader('Set-Cookie', 'luma_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'); res.json({ ok: true }); });
app.get('/api/auth/me', async (req, res) => { try { const user = await currentUser(req); if (!user) return res.status(401).json({ error: 'Not logged in.' }); res.json({ user }); } catch { res.status(503).json({ error: 'Database unavailable.' }); } });
app.get('/api/realtime/config', requireAuth, (_req, res) => { res.json({ enabled: pusher.configured(), key: process.env.PUSHER_KEY || null, cluster: process.env.PUSHER_CLUSTER || null }); });
app.post('/api/realtime/auth', requireAuth, (req, res) => { if (!pusher.configured()) return res.status(503).json({ error: 'Pusher is not configured on this deployment.' }); const channel = String(req.body.channel_name || ''); const socketId = String(req.body.socket_id || ''); if (!channel.startsWith('private-') || !socketId) return res.status(400).json({ error: 'Invalid Pusher authorization request.' }); try { res.json(pusher.auth(socketId, channel)); } catch (error) { console.error('Pusher auth failed:', error); res.status(500).json({ error: 'Unable to authorize realtime channel.' }); } });

app.get('/api/invites/:code', async (req, res) => {
  try { const [invite] = await query('SELECT workspace_id, expires_at FROM workspace_invites WHERE code = ? AND expires_at > NOW()', [req.params.code]); if (!invite) return res.status(404).json({ error: 'Invite expired or invalid.' }); const [workspace] = await query('SELECT id, name FROM workspaces WHERE id = ?', [invite.workspace_id]); res.json({ workspace }); } catch { res.status(503).json({ error: 'Unable to check invite.' }); }
});
app.post('/api/invites/:code/accept', requireAuth, async (req, res) => {
  try { const [invite] = await query('SELECT workspace_id FROM workspace_invites WHERE code = ? AND expires_at > NOW()', [req.params.code]); if (!invite) return res.status(404).json({ error: 'Invite expired or invalid.' }); await query('INSERT IGNORE INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)', [invite.workspace_id, req.user.id, 'member']); res.json({ ok: true }); } catch { res.status(503).json({ error: 'Unable to accept invite.' }); }
});

app.get('/api/workspace', requireAuth, requireMember, async (req, res) => {
  try {
    const [workspace] = await query('SELECT id, name FROM workspaces LIMIT 1');
    const channels = await query('SELECT id, name, description, type, position FROM channels WHERE workspace_id = ? ORDER BY position', [workspace.id]);
    const members = await query('SELECT users.id, username, display_name, status, workspace_members.role FROM users JOIN workspace_members ON workspace_members.user_id = users.id WHERE workspace_members.workspace_id = ? AND password_hash IS NOT NULL ORDER BY display_name', [workspace.id]);
    res.json({ workspace, channels, members });
  } catch (error) {
    console.error(error);
    res.status(503).json({ error: 'Database unavailable. Check your environment variables.' });
  }
});
app.post('/api/workspaces', requireAuth, async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 80);
  if (name.length < 2) return res.status(400).json({ error: 'Workspace name must be at least 2 characters.' });
  try { const result = await query('INSERT INTO workspaces (name, owner_id) VALUES (?, ?)', [name, req.user.id]); await query('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)', [result.insertId, req.user.id, 'owner']); const channel = await query('INSERT INTO channels (workspace_id, name, description, type, position) VALUES (?, ?, ?, ?, ?)', [result.insertId, 'general', 'Start the conversation', 'text', 0]); res.status(201).json({ id: result.insertId, name, channelId: channel.insertId }); } catch (error) { console.error(error); res.status(503).json({ error: 'Unable to create workspace.' }); }
});

app.get('/api/workspace/members', requireAuth, requireMember, async (req, res) => { res.json(await query('SELECT users.id, username, display_name, status, workspace_members.role, workspace_members.banned_until FROM users JOIN workspace_members ON workspace_members.user_id = users.id WHERE workspace_members.workspace_id = ?', [req.membership.workspace_id])); });
app.patch('/api/workspace/members/:userId/role', requireAuth, requireMember, async (req, res) => { if (!canModerate(req.membership.role)) return res.status(403).json({ error: 'Moderator permission required.' }); const role = ['admin', 'moderator', 'member'].includes(req.body.role) ? req.body.role : null; if (!role) return res.status(400).json({ error: 'Invalid role.' }); await query('UPDATE workspace_members SET role = ? WHERE workspace_id = ? AND user_id = ?', [role, req.membership.workspace_id, req.params.userId]); res.json({ ok: true }); });
app.post('/api/workspace/members/:userId/timeout', requireAuth, requireMember, async (req, res) => { if (!canModerate(req.membership.role)) return res.status(403).json({ error: 'Moderator permission required.' }); const minutes = Math.min(Math.max(Number(req.body.minutes) || 10, 1), 10080); await query(`UPDATE workspace_members SET banned_until = DATE_ADD(NOW(), INTERVAL ${minutes} MINUTE) WHERE workspace_id = ? AND user_id = ?`, [req.membership.workspace_id, req.params.userId]); res.json({ ok: true }); });

app.post('/api/uploads', requireAuth, requireMember, async (req, res) => {
  const fileName = String(req.body.fileName || 'upload').slice(0, 255); const mimeType = String(req.body.mimeType || 'application/octet-stream').slice(0, 120); const encoded = String(req.body.data || '');
  const data = Buffer.from(encoded.replace(/^data:[^;]+;base64,/, ''), 'base64');
  if (!data.length || data.length > 5 * 1024 * 1024) return res.status(400).json({ error: 'Files must be smaller than 5 MB.' });
  try { const result = await query('INSERT INTO attachments (uploader_id, file_name, mime_type, file_size, data) VALUES (?, ?, ?, ?, ?)', [req.user.id, fileName, mimeType, data.length, data]); res.status(201).json({ id: result.insertId, fileName, mimeType, fileSize: data.length, url: `/api/uploads/${result.insertId}` }); } catch (error) { console.error(error); res.status(503).json({ error: 'Unable to upload file.' }); }
});
app.get('/api/uploads/:id', async (req, res) => { try { const [file] = await query('SELECT file_name, mime_type, data FROM attachments WHERE id = ?', [req.params.id]); if (!file) return res.sendStatus(404); res.setHeader('Content-Type', file.mime_type); res.setHeader('Content-Disposition', `inline; filename="${file.file_name.replace(/"/g, '')}"`); res.send(file.data); } catch { res.sendStatus(404); } });

app.get('/api/notifications', requireAuth, async (req, res) => { res.json(await query('SELECT id, type, title, body, link, read_at, created_at FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 30', [req.user.id])); });
app.patch('/api/notifications/:id/read', requireAuth, async (req, res) => { await query('UPDATE notifications SET read_at = NOW() WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]); res.json({ ok: true }); });

app.get('/api/events', requireAuth, async (req, res) => {
  res.status(200).set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders?.();
  let lastMessageId = Number(req.query.after || 0);
  let lastNotificationId = 0;
  const channelId = Number(req.query.channelId || 0);
  const dmUserId = Number(req.query.dmUserId || 0);
  let closed = false;
  const send = (event, data) => { if (!closed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
  const poll = async () => {
    try {
      if (channelId) { const [message] = await query('SELECT id FROM messages WHERE channel_id = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1', [channelId]); if (message && Number(message.id) > lastMessageId) { lastMessageId = Number(message.id); send('message', { channelId }); } }
      if (dmUserId) { const conversationId = await getDmConversation(req.user.id, dmUserId); const [message] = await query('SELECT id FROM direct_messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1', [conversationId]); if (message && Number(message.id) > lastMessageId) { lastMessageId = Number(message.id); send('dm', { userId: dmUserId }); } }
      const [notification] = await query('SELECT id FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 1', [req.user.id]); if (notification && Number(notification.id) > lastNotificationId) { lastNotificationId = Number(notification.id); send('notification', { id: notification.id }); }
      send('ping', { at: Date.now() });
    } catch (error) { send('error', { message: 'Live updates temporarily unavailable.' }); }
  };
  send('ready', { at: Date.now() }); await poll(); const timer = setInterval(poll, 2500);
  req.on('close', () => { closed = true; clearInterval(timer); });
});

app.get('/api/users/:userId/profile', requireAuth, async (req, res) => {
  try {
    const [user] = await query('SELECT id, username, display_name, status, created_at FROM users WHERE id = ? AND password_hash IS NOT NULL', [req.params.userId]);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    if (Number(user.id) === Number(req.user.id)) return res.json({ user, relationship: 'self' });
    const [friendship] = await query('SELECT user_id FROM friendships WHERE user_id = ? AND friend_id = ?', [req.user.id, user.id]);
    if (friendship) return res.json({ user, relationship: 'friends' });
    const [outgoing] = await query('SELECT id FROM friend_requests WHERE requester_id = ? AND addressee_id = ? AND status = \'pending\'', [req.user.id, user.id]);
    if (outgoing) return res.json({ user, relationship: 'outgoing', requestId: outgoing.id });
    const [incoming] = await query('SELECT id FROM friend_requests WHERE requester_id = ? AND addressee_id = ? AND status = \'pending\'', [user.id, req.user.id]);
    res.json({ user, relationship: incoming ? 'incoming' : 'none', requestId: incoming?.id });
  } catch (error) { console.error(error); res.status(503).json({ error: 'Unable to load profile.' }); }
});

app.get('/api/friends', requireAuth, async (req, res) => { res.json(await query('SELECT users.id, users.username, users.display_name, users.status FROM friendships JOIN users ON users.id = friendships.friend_id WHERE friendships.user_id = ? ORDER BY users.display_name', [req.user.id])); });
app.get('/api/friend-requests', requireAuth, async (req, res) => { res.json(await query(`SELECT friend_requests.id, friend_requests.status, friend_requests.created_at, requester.id AS requester_id, requester.username AS requester_username, requester.display_name AS requester_name, addressee.id AS addressee_id, addressee.username AS addressee_username, addressee.display_name AS addressee_name FROM friend_requests JOIN users requester ON requester.id = requester_id JOIN users addressee ON addressee.id = addressee_id WHERE requester_id = ? OR addressee_id = ? ORDER BY friend_requests.created_at DESC`, [req.user.id, req.user.id])); });
app.post('/api/friend-requests', requireAuth, async (req, res) => {
  const addresseeId = Number(req.body.userId); if (!addresseeId || addresseeId === Number(req.user.id)) return res.status(400).json({ error: 'Choose another user.' });
  try {
    const [target] = await query('SELECT id, display_name FROM users WHERE id = ? AND password_hash IS NOT NULL', [addresseeId]); if (!target) return res.status(404).json({ error: 'User not found.' });
    if ((await query('SELECT user_id FROM friendships WHERE user_id = ? AND friend_id = ?', [req.user.id, addresseeId])).length) return res.status(409).json({ error: 'You are already friends.' });
    if ((await query('SELECT id FROM friend_requests WHERE ((requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)) AND status = \'pending\'', [req.user.id, addresseeId, addresseeId, req.user.id])).length) return res.status(409).json({ error: 'A friend request is already pending.' });
    const result = await query('INSERT INTO friend_requests (requester_id, addressee_id) VALUES (?, ?)', [req.user.id, addresseeId]);
    await query('INSERT INTO notifications (user_id, type, title, body, link) VALUES (?, ?, ?, ?, ?)', [addresseeId, 'friend_request', 'New friend request', `${req.user.display_name} wants to connect with you`, '/']);
    await pusher.trigger(`private-user-${addresseeId}`, 'friend-request:new', { requestId: result.insertId, from: req.user.id });
    res.status(201).json({ id: result.insertId, relationship: 'outgoing' });
  } catch (error) { console.error(error); res.status(503).json({ error: 'Unable to send friend request.' }); }
});
app.patch('/api/friend-requests/:requestId', requireAuth, async (req, res) => {
  const action = req.body.action; if (!['accepted', 'declined'].includes(action)) return res.status(400).json({ error: 'Choose accept or decline.' });
  try {
    const [request] = await query('SELECT id, requester_id, addressee_id FROM friend_requests WHERE id = ? AND addressee_id = ? AND status = \'pending\'', [req.params.requestId, req.user.id]); if (!request) return res.status(404).json({ error: 'Friend request not found.' });
    await query('UPDATE friend_requests SET status = ? WHERE id = ?', [action, request.id]);
    if (action === 'accepted') { await query('INSERT IGNORE INTO friendships (user_id, friend_id) VALUES (?, ?)', [request.requester_id, request.addressee_id]); await query('INSERT IGNORE INTO friendships (user_id, friend_id) VALUES (?, ?)', [request.addressee_id, request.requester_id]); }
    await query('INSERT INTO notifications (user_id, type, title, body, link) VALUES (?, ?, ?, ?, ?)', [request.requester_id, 'friend_request', action === 'accepted' ? 'Friend request accepted' : 'Friend request declined', `${req.user.display_name} ${action === 'accepted' ? 'accepted' : 'declined'} your friend request`, '/']);
    res.json({ ok: true, relationship: action === 'accepted' ? 'friends' : 'none' });
  } catch (error) { console.error(error); res.status(503).json({ error: 'Unable to update friend request.' }); }
});

app.get('/api/dms', requireAuth, async (req, res) => {
  const rows = await query(`SELECT conversations.id, users.id AS user_id, users.username, users.display_name, users.status, MAX(direct_messages.created_at) AS last_message_at, (SELECT content FROM direct_messages latest WHERE latest.conversation_id = conversations.id ORDER BY latest.created_at DESC LIMIT 1) AS last_message FROM conversations JOIN conversation_members mine ON mine.conversation_id = conversations.id AND mine.user_id = ? JOIN conversation_members other ON other.conversation_id = conversations.id AND other.user_id != ? JOIN users ON users.id = other.user_id LEFT JOIN direct_messages ON direct_messages.conversation_id = conversations.id WHERE conversations.kind = 'dm' GROUP BY conversations.id, users.id, users.username, users.display_name, users.status ORDER BY last_message_at DESC`, [req.user.id, req.user.id]);
  res.json(rows);
});
async function getDmConversation(userId, otherId) {
  const [existing] = await query(`SELECT conversations.id FROM conversations JOIN conversation_members a ON a.conversation_id = conversations.id AND a.user_id = ? JOIN conversation_members b ON b.conversation_id = conversations.id AND b.user_id = ? WHERE conversations.kind = 'dm' LIMIT 1`, [userId, otherId]);
  if (existing) return existing.id;
  const result = await query('INSERT INTO conversations (kind) VALUES (?)', ['dm']);
  await query('INSERT INTO conversation_members (conversation_id, user_id) VALUES (?, ?), (?, ?)', [result.insertId, userId, result.insertId, otherId]);
  return result.insertId;
}
app.get('/api/dms/:userId/messages', requireAuth, async (req, res) => {
  const otherId = Number(req.params.userId); if (!otherId) return res.status(400).json({ error: 'Invalid user.' });
  try { const conversationId = await getDmConversation(req.user.id, otherId); res.json(await query('SELECT direct_messages.id, direct_messages.content, direct_messages.author_id, direct_messages.created_at, users.display_name, users.username FROM direct_messages JOIN users ON users.id = direct_messages.author_id WHERE conversation_id = ? ORDER BY direct_messages.created_at ASC LIMIT 200', [conversationId])); } catch (error) { console.error(error); res.status(503).json({ error: 'Unable to load direct messages.' }); }
});
app.post('/api/dms/:userId/messages', requireAuth, async (req, res) => {
  const otherId = Number(req.params.userId); const content = String(req.body.content || '').trim(); if (!otherId || !content || content.length > 2000) return res.status(400).json({ error: 'Invalid direct message.' });
  try { const [other] = await query('SELECT id FROM users WHERE id = ? AND password_hash IS NOT NULL', [otherId]); if (!other) return res.status(404).json({ error: 'User not found.' }); const conversationId = await getDmConversation(req.user.id, otherId); const result = await query('INSERT INTO direct_messages (conversation_id, author_id, content) VALUES (?, ?, ?)', [conversationId, req.user.id, content]); await query('INSERT INTO notifications (user_id, type, title, body, link) VALUES (?, ?, ?, ?, ?)', [otherId, 'dm', `Message from ${req.user.display_name}`, content.slice(0, 120), '/friends']); await pusher.trigger(`private-user-${otherId}`, 'dm:new', { userId: req.user.id, messageId: result.insertId }); res.status(201).json({ id: result.insertId, content, author_id: req.user.id, display_name: req.user.display_name, username: req.user.username, created_at: new Date().toISOString() }); } catch (error) { console.error(error); res.status(503).json({ error: 'Unable to send direct message.' }); }
});

app.post('/api/channels', requireAuth, requireMember, async (req, res) => {
  const name = String(req.body.name || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 40);
  if (!name) return res.status(400).json({ error: 'Channel name is required.' });
  try {
    const [workspace] = await query('SELECT id FROM workspaces LIMIT 1');
    const [position] = await query('SELECT COALESCE(MAX(position), -1) + 1 AS next_position FROM channels WHERE workspace_id = ?', [workspace.id]);
    const result = await query('INSERT INTO channels (workspace_id, name, description, type, position) VALUES (?, ?, ?, ?, ?)', [workspace.id, name, String(req.body.description || ''), 'text', position.next_position]);
    res.status(201).json({ id: result.insertId, name, description: String(req.body.description || ''), type: 'text', position: position.next_position });
  } catch (error) { if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'That channel already exists.' }); console.error(error); res.status(503).json({ error: 'Unable to create channel.' }); }
});

app.delete('/api/channels/:channelId', requireAuth, requireMember, async (req, res) => {
  try { await query('DELETE FROM channels WHERE id = ?', [req.params.channelId]); res.json({ ok: true }); } catch (error) { console.error(error); res.status(503).json({ error: 'Unable to delete channel.' }); }
});

app.get('/api/channels/:channelId/messages', requireAuth, requireMember, async (req, res) => {
  try {
    const messages = await query(`
      SELECT messages.id, messages.author_id, messages.content, messages.parent_id, messages.edited_at, messages.created_at, users.username, users.display_name, attachments.id AS attachment_id, attachments.file_name, attachments.mime_type,
        (SELECT COUNT(*) FROM message_reactions WHERE message_reactions.message_id = messages.id) AS reaction_count
      FROM messages JOIN users ON users.id = messages.author_id LEFT JOIN attachments ON attachments.id = messages.attachment_id
      WHERE messages.channel_id = ? AND messages.deleted_at IS NULL ORDER BY messages.created_at ASC LIMIT 100
    `, [req.params.channelId]);
    res.json(messages);
  } catch (error) {
    console.error(error);
    res.status(503).json({ error: 'Unable to load messages.' });
  }
});

app.post('/api/channels/:channelId/messages', requireAuth, requireMember, async (req, res) => {
  const content = String(req.body.content || '').trim();
  if (!content || content.length > 2000) return res.status(400).json({ error: 'Message must be between 1 and 2000 characters.' });
  try {
    const user = req.user;
    const attachmentId = req.body.attachmentId || null;
    const result = await query('INSERT INTO messages (channel_id, author_id, content, attachment_id) VALUES (?, ?, ?, ?)', [req.params.channelId, user.id, content, attachmentId]);
    const [message] = await query('SELECT id, author_id, content, parent_id, edited_at, created_at, ? AS username, ? AS display_name, attachment_id, 0 AS reaction_count FROM messages WHERE id = ?', [user.username, user.display_name, result.insertId]);
    const recipients = await query('SELECT user_id FROM workspace_members WHERE workspace_id = ? AND user_id != ?', [req.membership.workspace_id, user.id]);
    for (const recipient of recipients) await query('INSERT INTO notifications (user_id, type, title, body, link) VALUES (?, ?, ?, ?, ?)', [recipient.user_id, 'message', `New message from ${user.display_name}`, content.slice(0, 120), `/`]);
    await pusher.trigger(`private-channel-${req.params.channelId}`, 'message:new', { channelId: Number(req.params.channelId), messageId: result.insertId });
    res.status(201).json(message);
  } catch (error) {
    console.error(error);
    res.status(503).json({ error: 'Unable to send message.' });
  }
});

app.patch('/api/messages/:messageId', requireAuth, requireMember, async (req, res) => {
  const content = String(req.body.content || '').trim();
  if (!content || content.length > 2000) return res.status(400).json({ error: 'Message must be between 1 and 2000 characters.' });
  try { const result = await query('UPDATE messages SET content = ?, edited_at = NOW() WHERE id = ? AND author_id = ? AND deleted_at IS NULL', [content, req.params.messageId, req.user.id]); if (!result.affectedRows) return res.status(403).json({ error: 'You can only edit your own messages.' }); res.json({ ok: true }); } catch (error) { console.error(error); res.status(503).json({ error: 'Unable to edit message.' }); }
});

app.delete('/api/messages/:messageId', requireAuth, requireMember, async (req, res) => {
  try { const condition = canModerate(req.membership.role) ? 'id = ?' : 'id = ? AND author_id = ?'; const values = canModerate(req.membership.role) ? [req.params.messageId] : [req.params.messageId, req.user.id]; const result = await query(`UPDATE messages SET deleted_at = NOW() WHERE ${condition}`, values); if (!result.affectedRows) return res.status(403).json({ error: 'You can only delete your own messages.' }); res.json({ ok: true }); } catch (error) { console.error(error); res.status(503).json({ error: 'Unable to delete message.' }); }
});

app.post('/api/messages/:messageId/reactions', requireAuth, async (req, res) => {
  const emoji = String(req.body.emoji || '').trim().slice(0, 32); if (!emoji) return res.status(400).json({ error: 'Emoji is required.' });
  try { const existing = await query('SELECT message_id FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?', [req.params.messageId, req.user.id, emoji]); if (existing.length) await query('DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?', [req.params.messageId, req.user.id, emoji]); else await query('INSERT INTO message_reactions (message_id, user_id, emoji) VALUES (?, ?, ?)', [req.params.messageId, req.user.id, emoji]); const [count] = await query('SELECT COUNT(*) AS count FROM message_reactions WHERE message_id = ?', [req.params.messageId]); res.json({ active: !existing.length, count: count.count }); } catch (error) { console.error(error); res.status(503).json({ error: 'Unable to update reaction.' }); }
});

app.get('/api/voice/:channelId/signals', requireAuth, requireMember, async (req, res) => { const after = Number(req.query.after || 0); res.json(await query('SELECT id, sender_id, recipient_id, payload FROM voice_signals WHERE channel_id = ? AND id > ? AND (recipient_id IS NULL OR recipient_id = ?) ORDER BY id ASC LIMIT 100', [req.params.channelId, after, req.user.id])); });
app.post('/api/voice/:channelId/signals', requireAuth, requireMember, async (req, res) => { const payload = JSON.stringify(req.body.payload || {}); const result = await query('INSERT INTO voice_signals (channel_id, sender_id, recipient_id, payload) VALUES (?, ?, ?, ?)', [req.params.channelId, req.user.id, req.body.recipientId || null, payload]); res.status(201).json({ id: result.insertId }); });

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
