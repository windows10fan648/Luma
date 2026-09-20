if (window.lucide) lucide.createIcons();
const state = { channels: [], activeChannel: null, members: [] };
const toast = document.querySelector('#toast'); let toastTimer;
function showToast(message) { toast.textContent = message; toast.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('show'), 2200); }
function initials(name) { return name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase(); }
function avatarClass(name) { return ['avatar-lilac', 'avatar-sky', 'avatar-peach', 'avatar-yellow', 'avatar-pink'][name.charCodeAt(0) % 5]; }

function renderChannels() {
  const list = document.querySelector('.channel-list');
  list.querySelectorAll('.channel').forEach((item) => item.remove());
  const textLabel = list.querySelector('.section-label'); const voiceLabel = list.querySelector('.voice-label');
  state.channels.filter((channel) => channel.type === 'text').forEach((channel) => {
    const button = document.createElement('button'); button.className = 'channel'; button.dataset.channelId = channel.id;
    button.innerHTML = '<i class="hash" data-lucide="hash"></i><span></span>'; button.querySelector('span').textContent = channel.name;
    button.addEventListener('click', () => selectChannel(channel)); textLabel.after(button);
  });
  state.channels.filter((channel) => channel.type === 'voice').forEach((channel) => {
    const button = document.createElement('button'); button.className = 'channel voice'; button.dataset.channelId = channel.id;
    button.innerHTML = '<i class="speaker" data-lucide="volume-2"></i><span></span>'; button.querySelector('span').textContent = channel.name;
    button.addEventListener('click', () => showToast('Voice rooms are ready for the next step')); voiceLabel.after(button);
  });
  if (window.lucide) lucide.createIcons();
}

function renderMembers() {
  const online = state.members.filter((member) => member.status !== 'offline'); const offline = state.members.filter((member) => member.status === 'offline');
  const list = document.querySelector('#member-list');
  list.innerHTML = `<p class="member-group">Online — ${online.length}</p><div class="member-list"></div><p class="member-group offline">Offline — ${offline.length}</p><div class="member-list faded"></div>`;
  const groups = list.querySelectorAll('.member-list');
  [online, offline].forEach((members, groupIndex) => members.forEach((member) => {
    const item = document.createElement('div'); item.className = 'member';
    item.innerHTML = `<div class="avatar ${avatarClass(member.display_name)}">${initials(member.display_name)}${groupIndex === 0 ? '<span class="status-dot"></span>' : ''}</div><div><strong></strong><span></span></div>`;
    item.querySelector('strong').textContent = member.display_name; item.querySelector('span').textContent = groupIndex === 0 ? member.status : 'offline'; groups[groupIndex].append(item);
  }));
}

function renderMessage(message) {
  const article = document.createElement('article'); article.className = 'message'; const author = message.display_name || message.username;
  article.innerHTML = `<div class="avatar ${avatarClass(author)}">${initials(author)}</div><div class="message-content"><div class="message-meta"><strong></strong><time></time></div><p></p></div>`;
  article.querySelector('strong').textContent = author; article.querySelector('time').textContent = new Date(message.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); article.querySelector('p').textContent = message.content;
  return article;
}

async function loadMessages(channel) {
  const list = document.querySelector('#message-list'); list.innerHTML = '<p class="empty-state">Loading messages…</p>';
  try {
    const response = await fetch(`/api/channels/${channel.id}/messages`); if (!response.ok) throw new Error(); const messages = await response.json(); list.innerHTML = '';
    if (!messages.length) list.innerHTML = '<p class="empty-state">No messages yet. Start the conversation.</p>'; messages.forEach((message) => list.append(renderMessage(message)));
  } catch { list.innerHTML = '<p class="empty-state">Could not load messages right now.</p>'; }
}
async function selectChannel(channel) {
  if (!channel) return; state.activeChannel = channel;
  document.querySelectorAll('.channel[data-channel-id]').forEach((item) => item.classList.toggle('active', Number(item.dataset.channelId) === channel.id));
  document.querySelector('#channel-name').textContent = channel.name; document.querySelector('#channel-description').textContent = channel.description; document.querySelector('#message-input').placeholder = `Message #${channel.name}`;
  await loadMessages(channel);
}

document.querySelector('#composer').addEventListener('submit', async (event) => {
  event.preventDefault(); const input = document.querySelector('#message-input'); const content = input.value.trim(); if (!content || !state.activeChannel) return;
  const button = document.querySelector('.send-button'); button.disabled = true;
  try {
    const response = await fetch(`/api/channels/${state.activeChannel.id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }) }); const message = await response.json(); if (!response.ok) throw new Error(message.error);
    const list = document.querySelector('#message-list'); list.querySelector('.empty-state')?.remove(); list.append(renderMessage(message)); input.value = ''; document.querySelector('#message-area').scrollTo({ top: document.querySelector('#message-area').scrollHeight, behavior: 'smooth' });
  } catch (error) { showToast(error.message || 'Unable to send message'); } button.disabled = false;
});
document.querySelector('.emoji-trigger').addEventListener('click', () => { const input = document.querySelector('#message-input'); input.value += ' ✨'; input.focus(); });
document.querySelector('.compose-add').addEventListener('click', () => showToast('Attachments are coming soon'));
document.querySelectorAll('.add-server, .tiny-plus').forEach((button) => button.addEventListener('click', () => showToast('Workspace tools are coming soon')));
document.querySelector('#logout').addEventListener('click', async () => { await fetch('/api/auth/logout', { method: 'POST' }); window.location.href = '/auth'; });

async function boot() {
  try {
    const auth = await fetch('/api/auth/me');
    if (!auth.ok) { window.location.href = '/auth'; return; }
    const authData = await auth.json();
    const response = await fetch('/api/workspace'); if (!response.ok) throw new Error(); const data = await response.json(); state.channels = data.channels; state.members = data.members;
    document.querySelector('.workspace-head h1').textContent = data.workspace.name; document.querySelector('.member-head h2 span').textContent = data.members.length; renderChannels(); renderMembers(); await selectChannel(state.channels.find((channel) => channel.name === 'general') || state.channels[0]);
    document.querySelector('.user-copy strong').textContent = authData.user.display_name;
    document.querySelector('.user-avatar').firstChild.textContent = initials(authData.user.display_name);
  } catch { document.querySelector('#message-list').innerHTML = '<p class="empty-state">Connect your database to load this workspace.</p>'; showToast('Workspace could not be loaded'); }
}
boot();
