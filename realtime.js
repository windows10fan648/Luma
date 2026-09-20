const crypto = require('crypto');

function configured() { return Boolean(process.env.PUSHER_APP_ID && process.env.PUSHER_KEY && process.env.PUSHER_SECRET && process.env.PUSHER_CLUSTER); }
async function trigger(channel, name, data) {
  if (!configured()) return false;
  const body = JSON.stringify({ name, channel, data: JSON.stringify(data) });
  const bodyMd5 = crypto.createHash('md5').update(body).digest('hex'); const timestamp = Math.floor(Date.now() / 1000).toString();
  const params = `auth_key=${encodeURIComponent(process.env.PUSHER_KEY)}&auth_timestamp=${timestamp}&auth_version=1.0&body_md5=${bodyMd5}`;
  const signature = crypto.createHmac('sha256', process.env.PUSHER_SECRET).update(`POST\n/apps/${process.env.PUSHER_APP_ID}/events\n${params}`).digest('hex');
  const response = await fetch(`https://api-${process.env.PUSHER_CLUSTER}.pusher.com/apps/${process.env.PUSHER_APP_ID}/events?${params}&auth_signature=${signature}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  if (!response.ok) throw new Error(`Pusher publish failed: ${response.status}`); return true;
}
function auth(socketId, channelName) { const value = `socket_id=${socketId}&channel_name=${channelName}`; return { auth: `${process.env.PUSHER_KEY}:${crypto.createHmac('sha256', process.env.PUSHER_SECRET).update(value).digest('hex')}` }; }
module.exports = { configured, trigger, auth };
