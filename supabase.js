function configured() { return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY); }
async function request(path, options = {}, token = process.env.SUPABASE_ANON_KEY) {
  if (!configured()) throw new Error('Supabase is not configured.');
  const response = await fetch(`${process.env.SUPABASE_URL}/auth/v1${path}`, { ...options, headers: { apikey: process.env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const body = await response.json().catch(() => ({})); if (!response.ok) { const error = new Error(body.msg || body.error_description || body.message || 'Supabase request failed.'); error.status = response.status; throw error; } return body;
}
module.exports = { configured, request };

async function storageRequest(path, options = {}) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.SUPABASE_BUCKET) throw new Error('Supabase Storage is not configured.');
  return fetch(`${process.env.SUPABASE_URL}/storage/v1/object/${process.env.SUPABASE_BUCKET}/${path.split('/').map(encodeURIComponent).join('/')}`, { ...options, headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, ...(options.headers || {}) } });
}
async function storageUpload(path, data, mimeType) { const response = await storageRequest(path, { method: 'POST', headers: { 'Content-Type': mimeType, 'x-upsert': 'false' }, body: data }); if (!response.ok) throw new Error(`Storage upload failed: ${response.status}`); }
async function storageDownload(path) { const response = await storageRequest(path); if (!response.ok) throw new Error(`Storage download failed: ${response.status}`); return response; }
module.exports = { configured, request, storageUpload, storageDownload };
