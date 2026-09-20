if (window.lucide) lucide.createIcons();
const state = { channels: [], activeChannel: null, members: [], user: null, mediaStream: null, muted: false, eventSource: null };
let pendingAttachmentId = null;
const toast = document.querySelector('#toast'); let toastTimer;
function showToast(message) { toast.textContent = message; toast.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('show'), 2200); }
function initials(name) { return name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase(); }
function avatarClass(name) { return ['avatar-lilac', 'avatar-sky', 'avatar-peach', 'avatar-yellow', 'avatar-pink'][name.charCodeAt(0) % 5]; }
function closeProfile() { document.querySelector('#profile-modal').classList.remove('open'); document.querySelector('#profile-modal').setAttribute('aria-hidden', 'true'); }
async function openProfile(member) {
  const modal = document.querySelector('#profile-modal'); const response = await fetch(`/api/users/${member.id}/profile`); const data = await response.json(); if (!response.ok) return showToast(data.error);
  document.querySelector('#profile-avatar').textContent = initials(data.user.display_name); document.querySelector('#profile-handle').textContent = `@${data.user.username}`; document.querySelector('#profile-name').textContent = data.user.display_name; document.querySelector('#profile-status').textContent = data.user.status === 'offline' ? 'offline' : 'online';
  const actions = document.querySelector('#profile-actions'); actions.innerHTML = '';
  if (data.relationship === 'none') { const button = document.createElement('button'); button.textContent = 'Add friend'; button.onclick = async () => { const result = await fetch('/api/friend-requests', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: data.user.id }) }); const body = await result.json(); if (!result.ok) return showToast(body.error); button.textContent = 'Request sent'; button.disabled = true; }; actions.append(button); }
  else if (data.relationship === 'outgoing') { const button = document.createElement('button'); button.className = 'secondary'; button.textContent = 'Friend request sent'; button.disabled = true; actions.append(button); }
  else if (data.relationship === 'incoming') { const accept = document.createElement('button'); accept.textContent = 'Accept friend request'; accept.onclick = async () => { const result = await fetch(`/api/friend-requests/${data.requestId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'accepted' }) }); if (result.ok) { accept.textContent = 'Friends'; accept.disabled = true; } }; actions.append(accept); }
  else if (data.relationship === 'friends') { const message = document.createElement('button'); message.textContent = 'Message'; message.onclick = () => { window.location.href = `/friends?user=${data.user.id}`; }; actions.append(message); const button = document.createElement('button'); button.className = 'secondary'; button.textContent = 'Friends'; button.disabled = true; actions.append(button); }
  modal.classList.add('open'); modal.setAttribute('aria-hidden', 'false');
}
document.querySelectorAll('[data-close-profile]').forEach((item) => item.addEventListener('click', closeProfile));

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
    button.addEventListener('click', () => joinVoice(channel)); voiceLabel.after(button);
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
    item.querySelector('strong').textContent = member.display_name; item.querySelector('span').textContent = groupIndex === 0 ? member.status : 'offline'; item.addEventListener('click', () => openProfile(member)); groups[groupIndex].append(item);
  }));
}

function renderMessage(message) {
  const article = document.createElement('article'); article.className = 'message'; const author = message.display_name || message.username;
  const ownActions = state.user && Number(message.author_id) === Number(state.user.id) ? '<div class="message-tools"><button data-edit title="Edit message">✎</button><button data-delete title="Delete message">×</button></div>' : '';
  article.innerHTML = `<div class="avatar ${avatarClass(author)}">${initials(author)}</div><div class="message-content"><div class="message-meta"><strong></strong><time></time>${message.edited_at ? '<span>(edited)</span>' : ''}</div><p></p><div class="reaction-row"><button class="reaction" data-react="✨">✨ <span>${message.reaction_count || 0}</span></button>${ownActions}</div></div>`;
  article.querySelector('strong').textContent = author; article.querySelector('time').textContent = new Date(message.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); article.querySelector('p').textContent = message.content;
  if (message.attachment_id) { const link = document.createElement('a'); link.href = `/api/uploads/${message.attachment_id}`; link.textContent = message.file_name || 'Open attachment'; link.target = '_blank'; link.className = 'attachment-link'; article.querySelector('.message-content').append(link); }
  article.querySelector('[data-react]')?.addEventListener('click', async (event) => { const response = await fetch(`/api/messages/${message.id}/reactions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ emoji: '✨' }) }); if (response.ok) event.currentTarget.querySelector('span').textContent = (await response.json()).count; });
  article.querySelector('[data-edit]')?.addEventListener('click', async () => { const content = window.prompt('Edit your message', message.content); if (!content || content.trim() === message.content) return; const response = await fetch(`/api/messages/${message.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }) }); if (response.ok) loadMessages(state.activeChannel); else showToast('Unable to edit message'); });
  article.querySelector('[data-delete]')?.addEventListener('click', async () => { if (!window.confirm('Delete this message?')) return; const response = await fetch(`/api/messages/${message.id}`, { method: 'DELETE' }); if (response.ok) article.remove(); else showToast('Unable to delete message'); });
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
  state.eventSource?.close(); state.eventSource = new EventSource(`/api/events?channelId=${channel.id}`); state.eventSource.addEventListener('message', () => loadMessages(channel)); state.eventSource.addEventListener('notification', refreshNotifications);
  await loadMessages(channel);
}

async function joinVoice(channel) { if (!navigator.mediaDevices?.getUserMedia) return showToast('Voice rooms require a secure browser connection'); try { state.mediaStream?.getTracks().forEach((track) => track.stop()); state.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false }); await fetch(`/api/voice/${channel.id}/signals`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ payload: { type: 'join', channel: channel.name } }) }); showToast(`You joined ${channel.name}`); } catch { showToast('Microphone permission was not granted'); } }

document.querySelector('#composer').addEventListener('submit', async (event) => {
  event.preventDefault(); const input = document.querySelector('#message-input'); const content = input.value.trim(); if (!content || !state.activeChannel) return;
  const button = document.querySelector('.send-button'); button.disabled = true;
  try {
    const response = await fetch(`/api/channels/${state.activeChannel.id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content, attachmentId: pendingAttachmentId }) }); const message = await response.json(); if (!response.ok) throw new Error(message.error);
    const list = document.querySelector('#message-list'); list.querySelector('.empty-state')?.remove(); list.append(renderMessage(message)); input.value = ''; pendingAttachmentId = null; document.querySelector('#message-area').scrollTo({ top: document.querySelector('#message-area').scrollHeight, behavior: 'smooth' });
  } catch (error) { showToast(error.message || 'Unable to send message'); } button.disabled = false;
});
document.querySelector('.emoji-trigger').addEventListener('click', () => { const input = document.querySelector('#message-input'); input.value += ' ✨'; input.focus(); });
const filePicker = document.createElement('input'); filePicker.type = 'file'; filePicker.hidden = true; filePicker.accept = 'image/*,.pdf,.txt,.zip'; document.body.append(filePicker);
document.querySelector('.compose-add').addEventListener('click', () => filePicker.click());
filePicker.addEventListener('change', async () => { const file = filePicker.files[0]; if (!file) return; if (file.size > 5 * 1024 * 1024) return showToast('Files must be smaller than 5 MB'); const reader = new FileReader(); reader.onload = async () => { const response = await fetch('/api/uploads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileName: file.name, mimeType: file.type, data: reader.result }) }); const data = await response.json(); if (!response.ok) return showToast(data.error); pendingAttachmentId = data.id; showToast(`${file.name} attached`); }; reader.readAsDataURL(file); });
document.querySelector('.add-server').addEventListener('click', async () => { const name = window.prompt('Name your new workspace'); if (!name?.trim()) return; const response = await fetch('/api/workspaces', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim() }) }); const data = await response.json(); if (!response.ok) return showToast(data.error); showToast(`Workspace “${data.name}” created`); });
document.querySelector('.icon-button').addEventListener('click', async () => { const response = await fetch('/api/invites', { method: 'POST' }); const data = await response.json(); if (!response.ok) return showToast(data.error); const url = `${window.location.origin}${data.url}`; await navigator.clipboard?.writeText(url); showToast('Invite link copied to clipboard'); });
document.querySelectorAll('.tiny-plus').forEach((button) => button.addEventListener('click', async () => { const name = window.prompt('New text channel name'); if (!name) return; const response = await fetch('/api/channels', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }); const data = await response.json(); if (!response.ok) return showToast(data.error); state.channels.push(data); renderChannels(); await selectChannel(data); }));
document.querySelector('#logout').addEventListener('click', async () => { await fetch('/api/auth/logout', { method: 'POST' }); window.location.href = '/auth'; });
async function refreshNotifications() { const response = await fetch('/api/notifications'); if (!response.ok) return; const items = await response.json(); const unread = items.filter((item) => !item.read_at); if (unread.length) showToast(`${unread.length} new notification${unread.length === 1 ? '' : 's'}`); }
document.querySelector('.header-action').addEventListener('click', refreshNotifications); setInterval(refreshNotifications, 15000);
document.querySelector('.user-action[aria-label="Mute"]').addEventListener('click', (event) => { if (!state.mediaStream) return showToast('Join a voice room before muting'); state.muted = !state.muted; state.mediaStream.getAudioTracks().forEach((track) => { track.enabled = !state.muted; }); event.currentTarget.setAttribute('aria-label', state.muted ? 'Unmute' : 'Mute'); showToast(state.muted ? 'Microphone muted' : 'Microphone unmuted'); });
document.querySelectorAll('.rail-icon')[0].addEventListener('click', () => showToast(`${state.channels.length} channels in ${document.querySelector('.workspace-head h1').textContent}`));
document.querySelectorAll('.rail-icon')[1].addEventListener('click', () => showToast('Luma help: choose a channel, write a message, or join a voice room'));
document.querySelectorAll('.header-action')[1].addEventListener('click', () => showToast('Pinned messages are available per channel once pinned'));
document.querySelectorAll('.header-action')[2].addEventListener('click', () => document.querySelector('.member-sidebar').classList.toggle('member-sidebar-open'));
document.querySelectorAll('.header-action')[3].addEventListener('click', refreshNotifications);
document.querySelectorAll('.header-action')[4].addEventListener('click', () => showToast('Use the search field to find messages in this channel'));
document.querySelector('.compose-button[aria-label="Add gift"]').addEventListener('click', () => { const input = document.querySelector('#message-input'); input.value += ' 🎁'; input.focus(); });
document.querySelector('.member-head .icon-button').addEventListener('click', () => document.querySelector('.member-sidebar').classList.remove('member-sidebar-open'));

async function boot() {
  try {
    const auth = await fetch('/api/auth/me');
    if (!auth.ok) { window.location.href = '/auth'; return; }
    const authData = await auth.json(); state.user = authData.user;
    const response = await fetch('/api/workspace'); if (!response.ok) throw new Error(); const data = await response.json(); state.channels = data.channels; state.members = data.members;
    document.querySelector('.workspace-head h1').textContent = data.workspace.name; document.querySelector('.member-head h2 span').textContent = data.members.length; renderChannels(); renderMembers(); await selectChannel(state.channels.find((channel) => channel.name === 'general') || state.channels[0]);
    document.querySelector('.user-copy strong').textContent = authData.user.display_name;
    document.querySelector('.user-avatar').firstChild.textContent = initials(authData.user.display_name);
  } catch { document.querySelector('#message-list').innerHTML = '<p class="empty-state">Connect your database to load this workspace.</p>'; showToast('Workspace could not be loaded'); }
}
boot();
