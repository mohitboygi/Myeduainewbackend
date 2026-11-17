// Google Drive through its plain web API (the big `googleapis` package does not fit on Cloudflare Workers).
// Gives the three calls the server uses: files.create, files.get (stream), files.delete.
const { Readable } = require('stream');
let tok = null;
async function token() {
  if (tok && Date.now() < tok.exp) return tok.v;
  const e = process.env;
  if (!e.GOOGLE_CLIENT_ID || !e.GOOGLE_CLIENT_SECRET || !e.GOOGLE_REFRESH_TOKEN) throw new Error('File storage is not connected yet');
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: e.GOOGLE_CLIENT_ID, client_secret: e.GOOGLE_CLIENT_SECRET, refresh_token: e.GOOGLE_REFRESH_TOKEN, grant_type: 'refresh_token' }) });
  const j = await r.json();
  if (!r.ok) throw new Error('Google sign-in failed: ' + (j.error_description || j.error));
  tok = { v: j.access_token, exp: Date.now() + (Number(j.expires_in || 3600) - 120) * 1000 };
  return tok.v;
}
const head = async () => ({ Authorization: 'Bearer ' + (await token()) });
async function toBuffer(b) { if (Buffer.isBuffer(b)) return b; const parts = []; for await (const c of b) parts.push(Buffer.from(c)); return Buffer.concat(parts); }
function drive() {
  return { files: {
    async create({ requestBody, media }) {
      const data = await toBuffer(media.body), boundary = 'myedu' + Math.random().toString(36).slice(2);
      const pre = Buffer.from('--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(requestBody || {}) + '\r\n--' + boundary + '\r\nContent-Type: ' + media.mimeType + '\r\n\r\n');
      const r = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', { method: 'POST', headers: { ...(await head()), 'Content-Type': 'multipart/related; boundary=' + boundary }, body: Buffer.concat([pre, data, Buffer.from('\r\n--' + boundary + '--')]) });
      const j = await r.json();
      if (!r.ok) throw new Error('Upload failed: ' + ((j.error && j.error.message) || r.status));
      return { data: { id: j.id } };
    },
    async get({ fileId }) {
      const r = await fetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fileId) + '?alt=media', { headers: await head() });
      if (!r.ok) throw new Error('File not found');
      return { data: Readable.from(Buffer.from(await r.arrayBuffer())) };
    },
    async delete({ fileId }) { await fetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fileId), { method: 'DELETE', headers: await head() }); },
  } };
}
module.exports = { drive };
