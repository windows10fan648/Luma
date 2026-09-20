function configured() { return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY); }
async function request(path, options = {}, token = process.env.SUPABASE_ANON_KEY) {
  if (!configured()) throw new Error('Supabase is not configured.');
  const response = await fetch(`${process.env.SUPABASE_URL}/auth/v1${path}`, { ...options, headers: { apikey: process.env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const body = await response.json().catch(() => ({})); if (!response.ok) { const error = new Error(body.msg || body.error_description || body.message || 'Supabase request failed.'); error.status = response.status; throw error; } return body;
}
module.exports = { configured, request };
