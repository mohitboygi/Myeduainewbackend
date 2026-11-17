// Tiny replacement for "iconv-lite" on Cloudflare Workers.
// The real package crashes while loading on Workers (body-parser pulls it in).
// Our API only receives UTF-8 JSON, so this is enough.
const OK = /^(utf-?8|us-?ascii|ascii|latin-?1|iso-?8859-?1)$/i;
const label = (e) => {
  const s = String(e || 'utf-8').replace(/_/g, '-');
  return /^(us-?ascii|ascii|latin-?1|iso-?8859-?1)$/i.test(s) ? 'windows-1252' : 'utf-8';
};
const iconv = {
  encodingExists: (e) => OK.test(String(e || 'utf-8').replace(/_/g, '-')),
  getDecoder(e) {
    const d = new TextDecoder(label(e));
    return { write: (buf) => d.decode(buf, { stream: true }), end: () => d.decode() };
  },
  decode: (buf, e) => new TextDecoder(label(e)).decode(buf),
  encode: (str) => Buffer.from(String(str), 'utf8'),
  enableStreamingAPI() {},
};
module.exports = iconv;
module.exports.default = iconv;
