const crypto = require('crypto');

function token(identity, roomName) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = { iss: process.env.LIVEKIT_API_KEY, sub: identity, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, video: { roomJoin: true, room: roomName, canPublish: true, canSubscribe: true, canPublishData: true } };
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const content = `${encode(header)}.${encode(payload)}`;
  return `${content}.${crypto.createHmac('sha256', process.env.LIVEKIT_API_SECRET).update(content).digest('base64url')}`;
}

module.exports = { token };
