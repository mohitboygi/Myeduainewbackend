// Legal & privacy endpoints: marketing consent, privacy requests, grievances, cookie choices, data export.
// Contact details used for marketing are stored only as an HMAC hash (never in clear text).
const crypto = require('crypto');
const sec = require('./security');

const BUSINESSES = ['MOHORA', 'Mohit EV', 'Other Mohit Corporation businesses'];
const CHANNELS = ['email', 'whatsapp', 'sms', 'phone'];
const REQ_TYPES = ['Access my data', 'Correct my data', 'Delete my data', 'Withdraw consent', 'Other'];
const GRV_TYPES = ['Privacy', 'Child safety', 'Copyright', 'Billing / payment', 'Other'];
const STATUSES = ['open', 'in_progress', 'resolved', 'rejected'];

module.exports = function registerLegal(app, { q, ah, auth, optAuth, limiter, pepper }) {
  const hashContact = (c) => crypto.createHmac('sha256', pepper).update(String(c).trim().toLowerCase()).digest('hex');
  const audit = (req, action, type, id) => q('INSERT INTO legal_audit_log (id, actor_user_id, action, object_type, object_id, ip) VALUES ($1,$2,$3,$4,$5,$6)',
    [crypto.randomUUID(), req.user ? req.user.id : null, action, type, String(id || ''), limiter.ip(req)]).catch((e) => console.error('audit failed:', e.message));
  const newRef = (p) => { const d = new Date().toISOString().slice(0, 10).replace(/-/g, ''); return p + '-' + d + '-' + crypto.randomBytes(3).toString('hex').slice(0, 4).toUpperCase(); };
  const pickRef = (p, asked) => (new RegExp('^' + p + '-\\d{8}-[A-Z0-9]{4}$').test(String(asked || '')) ? String(asked) : newRef(p));
  const contactOk = (c) => c.length >= 5 && c.length <= 120 && (sec.isEmail(c) || sec.isPhone(c)) && !/[<>]/.test(c);

  // ----- privacy requests and grievances (public form, optional login) -----
  function ticket(table, prefix, types, typeCol) {
    return ah(async (req, res) => {
      const b = req.body || {};
      const type = types.includes(b[typeCol]) ? b[typeCol] : null;
      const name = sec.text(b.name, 80), contact = sec.text(b.contact, 120), desc = sec.text(b.description, 2000);
      if (!type || name.length < 2 || !contactOk(contact) || desc.length < 10) return res.status(400).json({ error: 'Please fill the type, your name, a valid phone or email, and at least 10 characters of details' });
      for (let i = 0; i < 4; i++) {
        const ref = i === 0 ? pickRef(prefix, b.reference_number) : newRef(prefix);
        try {
          await q(`INSERT INTO ${table} (id, reference_number, user_id, ${typeCol}, description, contact, name) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [crypto.randomUUID(), ref, req.user ? req.user.id : null, type, desc, contact, name]);
          audit(req, 'create', table, ref);
          return res.json({ ok: true, reference_number: ref });
        } catch (e) { if (e.code !== '23505') throw e; }
      }
      res.status(500).json({ error: 'Could not save, please try again' });
    });
  }
  const pub = limiter.limit({ name: 'legal-pub', windowMs: 60 * 60 * 1000, max: 8 });
  app.post('/api/legal/privacy-requests', pub, optAuth, ticket('privacy_requests', 'PRQ', REQ_TYPES, 'request_type'));
  app.post('/api/legal/grievances', pub, optAuth, ticket('grievance_records', 'GRV', GRV_TYPES, 'complaint_type'));

  // ----- cookie choices (public) -----
  app.post('/api/legal/cookie-preferences', limiter.limit({ name: 'legal-cookie', windowMs: 60 * 60 * 1000, max: 30 }), optAuth, ah(async (req, res) => {
    const b = req.body || {}, sid = String(b.anonymous_session_id || '');
    if (!/^[a-z0-9]{6,40}$/.test(sid)) return res.status(400).json({ error: 'Invalid session' });
    await q(`INSERT INTO cookie_preferences (anonymous_session_id, user_id, essential_enabled, analytics_enabled, marketing_enabled, updated_at) VALUES ($1,$2,TRUE,$3,$4,now())
             ON CONFLICT (anonymous_session_id) DO UPDATE SET user_id=COALESCE(EXCLUDED.user_id, cookie_preferences.user_id), analytics_enabled=EXCLUDED.analytics_enabled, marketing_enabled=EXCLUDED.marketing_enabled, updated_at=now()`,
      [sid, req.user ? req.user.id : null, b.analytics_enabled === true, b.marketing_enabled === true]);
    res.json({ ok: true });
  }));

  // ----- marketing consent: parents and teachers only, always optional -----
  app.post('/api/legal/consents', auth('parent', 'teacher'), limiter.limit({ name: 'legal-consent', windowMs: 60 * 60 * 1000, max: 20, key: (r) => 'u' + r.user.id }), ah(async (req, res) => {
    const list = Array.isArray(req.body && req.body.records) ? req.body.records.slice(0, 12) : [];
    if (!list.length) return res.status(400).json({ error: 'Nothing to save' });
    const rows = [];
    for (const r of list) {
      const contact = sec.text(r && r.contact, 120);
      if (!r || !BUSINESSES.includes(r.business_name) || !CHANNELS.includes(r.communication_channel) || !contactOk(contact)) return res.status(400).json({ error: 'Invalid consent choice' });
      rows.push({ b: r.business_name, c: r.communication_channel, h: hashContact(contact), v: sec.text(r.policy_version, 40), s: sec.text(r.source, 60) });
    }
    for (const r of rows) {
      await q(`INSERT INTO consent_records (id, user_id, institution_id, consent_type, business_name, communication_channel, consent_status, policy_version, source, contact_hash) VALUES ($1,$2,$3,'marketing',$4,$5,'granted',$6,$7,$8)`,
        [crypto.randomUUID(), req.user.id, req.user.inst || null, r.b, r.c, r.v, r.s, r.h]);
      await q('DELETE FROM marketing_suppression WHERE contact_hash=$1 AND business_name=$2 AND communication_channel=$3', [r.h, r.b, r.c]);
    }
    audit(req, 'consent_granted', 'consent_records', rows.length);
    res.json({ ok: true, saved: rows.length });
  }));
  app.post('/api/legal/consents/withdraw', auth(), ah(async (req, res) => {
    const mine = (await q("SELECT id, business_name, communication_channel, contact_hash FROM consent_records WHERE user_id=$1 AND consent_status='granted'", [req.user.id])).rows;
    for (const r of mine) await q('INSERT INTO marketing_suppression (id, contact_hash, business_name, communication_channel) VALUES ($1,$2,$3,$4)', [crypto.randomUUID(), r.contact_hash, r.business_name, r.communication_channel]);
    await q("UPDATE consent_records SET consent_status='withdrawn', withdrawal_timestamp=now() WHERE user_id=$1 AND consent_status='granted'", [req.user.id]);
    audit(req, 'consent_withdrawn', 'consent_records', mine.length);
    res.json({ ok: true, withdrawn: mine.length });
  }));
  app.get('/api/legal/consents', auth(), ah(async (req, res) => res.json((await q('SELECT business_name, communication_channel, consent_status, policy_version, consent_timestamp, withdrawal_timestamp FROM consent_records WHERE user_id=$1 ORDER BY consent_timestamp DESC LIMIT 100', [req.user.id])).rows)));

  // ----- my data: export, and a deletion request (a person checks it before anything is erased) -----
  app.get('/api/legal/my-data/export', auth(), limiter.limit({ name: 'legal-export', windowMs: 60 * 60 * 1000, max: 5, key: (r) => 'u' + r.user.id }), ah(async (req, res) => {
    const u = (await q('SELECT id, role, login_id, name, phone, email, class_name, division, stream, created_at FROM users WHERE id=$1', [req.user.id])).rows[0];
    const consents = (await q('SELECT business_name, communication_channel, consent_status, policy_version, consent_timestamp, withdrawal_timestamp FROM consent_records WHERE user_id=$1', [req.user.id])).rows;
    const requests = (await q('SELECT reference_number, request_type, status, created_at, resolved_at FROM privacy_requests WHERE user_id=$1', [req.user.id])).rows;
    audit(req, 'export', 'users', req.user.id);
    res.setHeader('Content-Disposition', 'attachment; filename="my-myedu-data.json"');
    res.json({ exportedAt: new Date().toISOString(), profile: u, marketingConsents: consents, privacyRequests: requests });
  }));
  app.post('/api/legal/my-data/delete', auth(), limiter.limit({ name: 'legal-del', windowMs: 24 * 60 * 60 * 1000, max: 3, key: (r) => 'u' + r.user.id }), ah(async (req, res) => {
    const ref = newRef('PRQ');
    await q("INSERT INTO privacy_requests (id, reference_number, user_id, institution_id, request_type, description, contact, name) VALUES ($1,$2,$3,$4,'Delete my data','Requested from the app by the signed-in user','in-app','in-app')", [crypto.randomUUID(), ref, req.user.id, req.user.inst || null]);
    audit(req, 'delete_requested', 'privacy_requests', ref);
    res.json({ ok: true, reference_number: ref });
  }));

  // ----- owner only: see and update requests and complaints -----
  const listOf = (table) => ah(async (req, res) => res.json((await q(`SELECT * FROM ${table} ORDER BY created_at DESC LIMIT 500`)).rows));
  const setStatus = (table) => ah(async (req, res) => {
    const st = String((req.body && req.body.status) || '');
    if (!STATUSES.includes(st)) return res.status(400).json({ error: 'Invalid status' });
    const r = await q(`UPDATE ${table} SET status=$1::text, resolved_at=CASE WHEN $1::text IN ('resolved','rejected') THEN now() ELSE NULL END WHERE reference_number=$2`, [st, String(req.params.ref)]);
    audit(req, 'status_' + st, table, req.params.ref);
    res.json({ ok: r.rowCount > 0 });
  });
  app.get('/api/owner/legal/privacy-requests', auth('owner'), listOf('privacy_requests'));
  app.get('/api/owner/legal/grievances', auth('owner'), listOf('grievance_records'));
  app.patch('/api/owner/legal/privacy-requests/:ref', auth('owner'), setStatus('privacy_requests'));
  app.patch('/api/owner/legal/grievances/:ref', auth('owner'), setStatus('grievance_records'));
};
