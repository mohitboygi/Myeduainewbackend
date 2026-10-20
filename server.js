// MyEduAI backend - Node/Express + PostgreSQL. Built for Mohit Corporation.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const nodemailer = require('nodemailer');
const rateLimit = require('express-rate-limit');
const { google } = require('googleapis');

const {
  DATABASE_URL, JWT_SECRET, PORT = 3000, ALLOWED_ORIGIN = '*',
  OWNER_EMAIL = 'mohityadavoffical1@gmail.com', SMTP_USER, SMTP_PASS,
  OWNER_LOGIN_ID = 'owner', OWNER_PASSWORD,
  GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN, DRIVE_FOLDER_ID,
  AI_ROUTER_URL, AI_ROUTER_KEY, AI_MODEL = 'auto',
} = process.env;
if (!DATABASE_URL || !JWT_SECRET) { console.error('Set DATABASE_URL and JWT_SECRET'); process.exit(1); }

const pool = new Pool({ connectionString: DATABASE_URL, ssl: /localhost|127\.0\.0\.1/.test(DATABASE_URL) ? false : { rejectUnauthorized: false } });
const q = (text, params) => pool.query(text, params);
const ah = (fn) => (req, res, next) => fn(req, res, next).catch(next);
const norm = (s) => String(s || '').trim().toLowerCase();
const clean = (s) => String(s || '').trim();

const app = express();
app.set('trust proxy', 1);
app.use(cors({ origin: ALLOWED_ORIGIN === '*' ? true : ALLOWED_ORIGIN.split(',') }));
app.use(express.json({ limit: '200kb' }));

// ---------- auth ----------
function auth(...roles) {
  return (req, res, next) => {
    try { req.user = jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), JWT_SECRET); }
    catch (e) { return res.status(401).json({ error: 'Please login again' }); }
    if (roles.length && !roles.includes(req.user.role)) return res.status(403).json({ error: 'Not allowed' });
    next();
  };
}
const publicUser = (u) => ({ id: u.id, role: u.role, name: u.name, loginId: u.login_id, institutionId: u.institution_id, className: u.class_name, division: u.division, stream: u.stream, phone: u.phone });

app.post('/api/login', rateLimit({ windowMs: 15 * 60 * 1000, max: 30 }), ah(async (req, res) => {
  const { rows } = await q(`SELECT u.*, i.active AS inst_active, i.type AS inst_type, i.name AS inst_name FROM users u LEFT JOIN institutions i ON i.id = u.institution_id WHERE u.login_id = $1`, [norm(req.body.loginId)]);
  const u = rows[0];
  if (!u || !u.active || u.inst_active === false || !(await bcrypt.compare(String(req.body.password || ''), u.password_hash))) return res.status(401).json({ error: 'Wrong ID or password' });
  const token = jwt.sign({ id: u.id, role: u.role, inst: u.institution_id }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { ...publicUser(u), institutionType: u.inst_type, institutionName: u.inst_name } });
}));
app.get('/api/me', auth(), ah(async (req, res) => {
  const { rows } = await q('SELECT * FROM users WHERE id=$1', [req.user.id]);
  res.json(rows[0] ? publicUser(rows[0]) : null);
}));

// ---------- get started form -> saved in PostgreSQL + emailed to the owner ----------
const mailer = SMTP_USER && SMTP_PASS ? nodemailer.createTransport({ service: 'gmail', auth: { user: SMTP_USER, pass: SMTP_PASS } }) : null;
app.post('/api/leads', rateLimit({ windowMs: 60 * 60 * 1000, max: 20 }), ah(async (req, res) => {
  const b = req.body || {};
  const lead = { type: b.type === 'tuition' ? 'tuition' : 'school', inst: clean(b.instName).slice(0, 120), person: clean(b.personName).slice(0, 80), phone: clean(b.phone).slice(0, 30), email: clean(b.email).slice(0, 120), students: clean(b.students).slice(0, 20) };
  if (!lead.inst || !lead.person || !lead.phone || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lead.email)) return res.status(400).json({ error: 'Fill all fields' });
  await q('INSERT INTO leads (type, inst_name, person_name, phone, email, students) VALUES ($1,$2,$3,$4,$5,$6)', [lead.type, lead.inst, lead.person, lead.phone, lead.email, lead.students]);
  if (mailer) {
    mailer.sendMail({
      from: `MyEduAI <${SMTP_USER}>`, to: OWNER_EMAIL, replyTo: lead.email,
      subject: `New MyEduAI trial request - ${lead.inst}`,
      text: `Type: ${lead.type}\nInstitution: ${lead.inst}\nName: ${lead.person}\nPhone: ${lead.phone}\nEmail: ${lead.email}\nApprox. students: ${lead.students}`,
    }).catch((e) => console.error('Mail failed:', e.message));
  }
  res.json({ ok: true });
}));

// ---------- app owner (Mohit): leads + create institution accounts ----------
app.get('/api/owner/leads', auth('owner'), ah(async (req, res) => res.json((await q('SELECT * FROM leads ORDER BY created_at DESC')).rows)));
app.patch('/api/owner/leads/:id', auth('owner'), ah(async (req, res) => { await q('UPDATE leads SET status=$1 WHERE id=$2', [clean(req.body.status), req.params.id]); res.json({ ok: true }); }));
app.get('/api/owner/institutions', auth('owner'), ah(async (req, res) => res.json((await q(`SELECT i.*, (SELECT COUNT(*) FROM users s WHERE s.institution_id=i.id AND s.role='student') AS students, (SELECT COUNT(*) FROM users t WHERE t.institution_id=i.id AND t.role='teacher') AS teachers FROM institutions i ORDER BY i.created_at DESC`)).rows)));
app.get('/api/owner/stats', auth('owner'), ah(async (req, res) => res.json((await q(`SELECT
  (SELECT COUNT(*) FROM institutions) AS institutions,
  (SELECT COUNT(*) FROM institutions WHERE type='school') AS schools,
  (SELECT COUNT(*) FROM institutions WHERE type='tuition') AS tuitions,
  (SELECT COUNT(*) FROM users WHERE role='teacher') AS teachers,
  (SELECT COUNT(*) FROM users WHERE role='student') AS students,
  (SELECT COUNT(*) FROM users WHERE role='parent') AS parents,
  (SELECT COUNT(*) FROM leads WHERE status='new') AS new_leads`)).rows[0])));
app.get('/api/owner/institutions/:id/users', auth('owner'), ah(async (req, res) => res.json((await q(
  `SELECT id, role, name, login_id AS "loginId", phone, email, class_name AS "className", division, stream, active, created_at AS "createdAt"
   FROM users WHERE institution_id=$1 AND ($2::text IS NULL OR role=$2) ORDER BY role, name`, [req.params.id, req.query.role || null])).rows)));
app.post('/api/owner/institutions', auth('owner'), ah(async (req, res) => {
  const b = req.body || {};
  const type = b.type === 'tuition' ? 'tuition' : 'school';
  if (!clean(b.name) || !clean(b.adminName) || !clean(b.loginId) || String(b.password || '').length < 6) return res.status(400).json({ error: 'Name, admin name, login ID and password (min 6) required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inst = (await client.query('INSERT INTO institutions (type, name, phone, email) VALUES ($1,$2,$3,$4) RETURNING id', [type, clean(b.name), clean(b.phone), clean(b.email)])).rows[0];
    await client.query('INSERT INTO users (institution_id, role, login_id, password_hash, name, phone, email, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [inst.id, type === 'school' ? 'admin' : 'inst_owner', norm(b.loginId), await bcrypt.hash(String(b.password), 10), clean(b.adminName), clean(b.phone), clean(b.email), req.user.id]);
    await client.query('COMMIT');
    res.json({ ok: true, institutionId: inst.id });
  } catch (e) { await client.query('ROLLBACK'); if (e.code === '23505') return res.status(409).json({ error: 'Login ID already taken' }); throw e; }
  finally { client.release(); }
}));
app.delete('/api/owner/institutions/:id', auth('owner'), ah(async (req, res) => { await q('DELETE FROM institutions WHERE id=$1', [req.params.id]); res.json({ ok: true }); }));

// ---------- people: owner/admin -> teachers ; teacher -> students + parents ----------
async function createUser(req, res, role, extra = {}) {
  const b = req.body || {};
  if (!clean(b.name) || !clean(b.loginId) || String(b.password || '').length < 6) return res.status(400).json({ error: 'Name, login ID and password (min 6) required' });
  try {
    const hash = await bcrypt.hash(String(b.password), 10);
    const { rows } = await q('INSERT INTO users (institution_id, role, login_id, password_hash, name, phone, email, class_name, division, stream, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',
      [req.user.inst, role, norm(b.loginId), hash, clean(b.name), clean(b.phone), clean(b.email), clean(b.className) || null, clean(b.division) || null, clean(b.stream) || null, req.user.id]);
    if (extra.studentId) await q('INSERT INTO parent_student (parent_id, student_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [rows[0].id, extra.studentId]);
    res.json(publicUser(rows[0]));
  } catch (e) { if (e.code === '23505') return res.status(409).json({ error: 'Login ID already taken' }); throw e; }
}
const listUsers = (role) => ah(async (req, res) => res.json((await q(
  `SELECT u.id, u.name, u.login_id AS "loginId", u.phone, u.class_name AS "className", u.division, u.stream,
          (SELECT json_agg(json_build_object('id', c.id, 'name', c.name)) FROM parent_student ps JOIN users c ON c.id = ps.student_id WHERE ps.parent_id = u.id) AS children
   FROM users u WHERE u.institution_id=$1 AND u.role=$2 AND u.active ORDER BY u.name`, [req.user.inst, role])).rows));
const deleteUser = (role) => ah(async (req, res) => {
  const r = await q('DELETE FROM users WHERE id=$1 AND institution_id=$2 AND role=$3', [req.params.id, req.user.inst, role]);
  res.json({ ok: r.rowCount > 0 });
});

app.get('/api/teachers', auth('admin', 'inst_owner'), listUsers('teacher'));
app.post('/api/teachers', auth('admin', 'inst_owner'), ah((req, res) => createUser(req, res, 'teacher')));
app.delete('/api/teachers/:id', auth('admin', 'inst_owner'), deleteUser('teacher'));

app.get('/api/students', auth('teacher', 'admin', 'inst_owner'), listUsers('student'));
app.post('/api/students', auth('teacher'), ah((req, res) => createUser(req, res, 'student')));
app.delete('/api/students/:id', auth('teacher'), deleteUser('student'));

app.get('/api/parents', auth('teacher', 'admin', 'inst_owner'), listUsers('parent'));
app.post('/api/parents', auth('teacher'), ah(async (req, res) => {
  const st = (await q("SELECT id FROM users WHERE id=$1 AND institution_id=$2 AND role='student'", [req.body.studentId, req.user.inst])).rows[0];
  if (!st) return res.status(400).json({ error: 'Choose a valid student for this parent' });
  return createUser(req, res, 'parent', { studentId: st.id });
}));
app.delete('/api/parents/:id', auth('teacher'), deleteUser('parent'));

// ---------- attendance: absent student => in-app notification to parents ----------
app.post('/api/attendance', auth('teacher'), ah(async (req, res) => {
  const day = clean(req.body.date) || new Date().toISOString().slice(0, 10);
  const records = Array.isArray(req.body.records) ? req.body.records : [];
  let absent = 0;
  for (const r of records) {
    const st = (await q("SELECT id, name FROM users WHERE id=$1 AND institution_id=$2 AND role='student'", [r.studentId, req.user.inst])).rows[0];
    if (!st) continue;
    const status = r.status === 'absent' ? 'absent' : 'present';
    const prev = (await q('SELECT status FROM attendance WHERE student_id=$1 AND day=$2', [st.id, day])).rows[0];
    await q(`INSERT INTO attendance (institution_id, student_id, day, status, marked_by) VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (student_id, day) DO UPDATE SET status=EXCLUDED.status, marked_by=EXCLUDED.marked_by`, [req.user.inst, st.id, day, status, req.user.id]);
    if (status === 'absent' && (!prev || prev.status !== 'absent')) {
      absent++;
      await q(`INSERT INTO notifications (user_id, title, body, kind)
               SELECT ps.parent_id, 'Absent today', $1, 'absent' FROM parent_student ps WHERE ps.student_id=$2`, [`${st.name} was absent on ${day}.`, st.id]);
    }
  }
  res.json({ ok: true, absentNotified: absent });
}));
app.get('/api/attendance/me', auth('student', 'parent'), ah(async (req, res) => {
  const ids = req.user.role === 'student' ? [req.user.id] : (await q('SELECT student_id FROM parent_student WHERE parent_id=$1', [req.user.id])).rows.map((r) => r.student_id);
  res.json((await q(`SELECT a.student_id AS "studentId", u.name, to_char(a.day,'YYYY-MM-DD') AS day, a.status FROM attendance a JOIN users u ON u.id=a.student_id WHERE a.student_id = ANY($1) ORDER BY a.day DESC LIMIT 400`, [ids])).rows);
}));

// ---------- notifications (in-app) ----------
app.get('/api/notifications', auth(), ah(async (req, res) => res.json((await q('SELECT id, title, body, kind, is_read AS "isRead", created_at AS "createdAt" FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100', [req.user.id])).rows)));
app.post('/api/notifications/read', auth(), ah(async (req, res) => { await q('UPDATE notifications SET is_read=TRUE WHERE user_id=$1', [req.user.id]); res.json({ ok: true }); }));

// ---------- announcements ----------
app.post('/api/announcements', auth('admin', 'inst_owner', 'teacher'), ah(async (req, res) => {
  const aud = ['all', 'students', 'parents', 'teachers'].includes(req.body.audience) ? req.body.audience : 'all';
  if (!clean(req.body.title)) return res.status(400).json({ error: 'Title required' });
  await q('INSERT INTO announcements (institution_id, audience, title, body, created_by) VALUES ($1,$2,$3,$4,$5)', [req.user.inst, aud, clean(req.body.title), clean(req.body.body), req.user.id]);
  res.json({ ok: true });
}));
app.get('/api/announcements', auth('admin', 'inst_owner', 'teacher', 'student', 'parent'), ah(async (req, res) => {
  const mine = { student: 'students', parent: 'parents', teacher: 'teachers' }[req.user.role];
  const { rows } = await q(`SELECT a.id, a.audience, a.title, a.body, a.created_at AS "createdAt", u.name AS "by" FROM announcements a LEFT JOIN users u ON u.id=a.created_by
    WHERE a.institution_id=$1 AND ($2::text IS NULL OR a.audience IN ('all',$2)) ORDER BY a.created_at DESC LIMIT 100`, [req.user.inst, mine || null]);
  res.json(rows);
}));
app.delete('/api/announcements/:id', auth('admin', 'inst_owner', 'teacher'), ah(async (req, res) => { await q('DELETE FROM announcements WHERE id=$1 AND institution_id=$2', [req.params.id, req.user.inst]); res.json({ ok: true }); }));

// ---------- study material PDFs -> owner's Google Drive ----------
function drive() {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) throw new Error('Google Drive is not configured');
  const oauth = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
  oauth.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
  return google.drive({ version: 'v3', auth: oauth });
}
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
app.post('/api/documents', auth('teacher'), upload.single('file'), ah(async (req, res) => {
  const f = req.file;
  if (!f || f.mimetype !== 'application/pdf' || !clean(req.body.title)) return res.status(400).json({ error: 'Send a PDF file and a title' });
  const r = await drive().files.create({
    requestBody: { name: `${req.user.inst}-${Date.now()}-${f.originalname}`.slice(0, 150), parents: DRIVE_FOLDER_ID ? [DRIVE_FOLDER_ID] : undefined },
    media: { mimeType: 'application/pdf', body: Readable.from(f.buffer) }, fields: 'id',
  });
  await q('INSERT INTO documents (institution_id, class_name, subject, title, drive_file_id, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6)',
    [req.user.inst, clean(req.body.className) || null, clean(req.body.subject) || null, clean(req.body.title), r.data.id, req.user.id]);
  res.json({ ok: true });
}));
app.get('/api/documents', auth('teacher', 'admin', 'inst_owner', 'student', 'parent'), ah(async (req, res) => {
  let cls = null;
  if (req.user.role === 'student') cls = (await q('SELECT class_name FROM users WHERE id=$1', [req.user.id])).rows[0]?.class_name || null;
  res.json((await q(`SELECT id, title, subject, class_name AS "className", created_at AS "createdAt" FROM documents WHERE institution_id=$1 AND ($2::text IS NULL OR class_name IS NULL OR class_name=$2) ORDER BY created_at DESC`, [req.user.inst, cls])).rows);
}));
app.get('/api/documents/:id/file', auth('teacher', 'admin', 'inst_owner', 'student', 'parent'), ah(async (req, res) => {
  const d = (await q('SELECT drive_file_id, title FROM documents WHERE id=$1 AND institution_id=$2', [req.params.id, req.user.inst])).rows[0];
  if (!d) return res.status(404).json({ error: 'Not found' });
  const r = await drive().files.get({ fileId: d.drive_file_id, alt: 'media' }, { responseType: 'stream' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${d.title.replace(/[^\w .-]/g, '_')}.pdf"`);
  r.data.pipe(res);
}));
app.delete('/api/documents/:id', auth('teacher', 'admin', 'inst_owner'), ah(async (req, res) => {
  const d = (await q('DELETE FROM documents WHERE id=$1 AND institution_id=$2 RETURNING drive_file_id', [req.params.id, req.user.inst])).rows[0];
  if (d) drive().files.delete({ fileId: d.drive_file_id }).catch(() => {});
  res.json({ ok: !!d });
}));

// ---------- MyEduAI study helper -> your Render AI router (API key stays on the server) ----------
app.post('/api/ai/chat', auth('student', 'teacher', 'parent', 'admin', 'inst_owner'), rateLimit({ windowMs: 60 * 1000, max: 12, keyGenerator: (req) => 'u' + req.user.id }), ah(async (req, res) => {
  if (!AI_ROUTER_URL || !AI_ROUTER_KEY) return res.status(503).json({ error: 'AI is not connected yet' });
  const b = req.body || {};
  const msg = clean(b.message).slice(0, 2000);
  if (!msg) return res.status(400).json({ error: 'Type a question' });
  const how = { explain: 'Explain step by step in simple words.', hint: 'Give only a hint, not the full answer.', practice: 'Give 3 practice questions with answers at the end.' }[b.mode] || 'Explain simply.';
  const system = `You are MyEduAI, a friendly study helper for Indian students. Class ${clean(b.cls) || 'not given'}, subject ${clean(b.subject) || 'general'}. Reply in ${clean(b.language) || 'English'}. ${how} Keep answers short and correct. If a question is not about studies, politely bring the student back to studies.`;
  const history = (Array.isArray(b.history) ? b.history : []).slice(-8).filter((m) => m && ['user', 'assistant'].includes(m.role)).map((m) => ({ role: m.role, content: clean(m.content).slice(0, 2000) }));
  const r = await fetch(AI_ROUTER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + AI_ROUTER_KEY },
    body: JSON.stringify({ model: AI_MODEL, messages: [{ role: 'system', content: system }, ...history, { role: 'user', content: msg }] }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { console.error('AI router error', r.status, JSON.stringify(d).slice(0, 300)); return res.status(502).json({ error: 'AI is busy, please try again' }); }
  const reply = d.choices?.[0]?.message?.content || d.reply || d.text || d.output || '';
  if (!reply) return res.status(502).json({ error: 'AI gave no answer, please try again' });
  res.json({ reply: String(reply).trim() });
}));

app.get('/', (req, res) => res.json({ app: 'MyEduAI backend', ok: true }));
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'Server error' }); });

(async () => {
  await q(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  if (OWNER_PASSWORD) {
    const has = (await q("SELECT 1 FROM users WHERE role='owner' LIMIT 1")).rowCount;
    if (!has) { await q("INSERT INTO users (role, login_id, password_hash, name, email) VALUES ('owner',$1,$2,'Mohit Yadav',$3)", [norm(OWNER_LOGIN_ID), await bcrypt.hash(OWNER_PASSWORD, 10), OWNER_EMAIL]); console.log('Owner account created'); }
  }
  app.listen(PORT, () => console.log('MyEduAI backend on', PORT));
})().catch((e) => { console.error(e); process.exit(1); });
