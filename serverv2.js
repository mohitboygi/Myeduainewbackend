// MyEduAI backend - Node/Express + PostgreSQL. Built for Mohit Corporation.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
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
const { norm: normCls, parseClasses, classAllowed, studentSeesClass, classNum } = require('./lib/scope');
const turso = require('./lib/turso');
const backup = require('./lib/backup');

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
const authCache = new Map();
async function authState(id) {
  const k = String(id);
  const c = authCache.get(k);
  if (c && Date.now() - c.at < 20000) return c;
  const r = (await q('SELECT u.token_version, u.active, u.institution_id, i.active AS inst_active FROM users u LEFT JOIN institutions i ON i.id = u.institution_id WHERE u.id=$1', [id])).rows[0];
  const ok = !!r && r.active && r.inst_active !== false;
  const st = { v: ok ? Number(r.token_version || 0) : null, inst: ok && r.institution_id != null ? String(r.institution_id) : null, at: Date.now() };
  authCache.set(k, st);
  return st;
}
function auth(...roles) {
  return async (req, res, next) => {
    try { req.user = jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), JWT_SECRET); }
    catch (e) { return res.status(401).json({ error: 'Please login again' }); }
    if (roles.length && !roles.includes(req.user.role)) return res.status(403).json({ error: 'Not allowed' });
    try {
      const st = await authState(req.user.id);
      // token must still match the account, and the account must still belong to the same institution
      if (st.v === null || st.v !== Number(req.user.tv || 0) || (st.inst || '') !== String(req.user.inst || '')) return res.status(401).json({ error: 'Please login again' });
    } catch (e) { return next(e); }
    next();
  };
}

// ---------- class-wise teacher control ----------
// A teacher only sees and manages the classes the admin assigned ("10A,11"). Admin / tuition owner see everything.
const tcCache = new Map();
async function teacherClassList(userId) {
  const k = String(userId), c = tcCache.get(k);
  if (c && Date.now() - c.at < 10000) return c.list;
  const r = (await q('SELECT class_name FROM users WHERE id=$1', [userId])).rows[0];
  const list = parseClasses(r && r.class_name);
  tcCache.set(k, { list, at: Date.now() });
  return list;
}
// null = no class limit (admin etc.), [] = teacher with no classes assigned yet (sees nothing)
const myClasses = async (user) => (user.role === 'teacher' ? teacherClassList(user.id) : null);
const canClass = (mine, cls, div) => mine === null || classAllowed(mine, cls, div);
const NO_CLASSES = 'Your admin has not assigned classes to you yet';
// the class (and division) of the signed-in student, or of all children of a parent
async function viewerClasses(user) {
  if (user.role === 'student') return (await q('SELECT class_name AS cls, division AS div FROM users WHERE id=$1', [user.id])).rows;
  if (user.role === 'parent') return (await q('SELECT c.class_name AS cls, c.division AS div FROM parent_student ps JOIN users c ON c.id=ps.student_id WHERE ps.parent_id=$1', [user.id])).rows;
  return null;
}
// can this signed-in person see something targeted at class `cls` / division `div`? (empty class = whole institution)
function seesClass(viewer, mine, cls, div) {
  if (!normCls(cls)) return true;
  if (mine !== null) return classAllowed(mine, cls, div);
  if (viewer) return viewer.some((v) => studentSeesClass(v.cls, v.div, cls, div));
  return true;
}
// may a teacher manage this student/parent? (admin: always yes)
async function teacherMayManage(req, targetId) {
  const mine = await myClasses(req.user);
  if (mine === null) return true;
  const t = (await q(`SELECT u.role, u.class_name, u.division, (SELECT json_agg(json_build_object('className', c.class_name, 'division', c.division)) FROM parent_student ps JOIN users c ON c.id=ps.student_id WHERE ps.parent_id=u.id) AS children FROM users u WHERE u.id=$1 AND u.institution_id=$2`, [targetId, req.user.inst])).rows[0];
  if (!t) return false;
  if (t.role === 'student') return classAllowed(mine, t.class_name, t.division);
  if (t.role === 'parent') return (t.children || []).some((c) => classAllowed(mine, c.className, c.division));
  return false;
}
const publicUser = (u) => ({ id: u.id, role: u.role, name: u.name, loginId: u.login_id, institutionId: u.institution_id, className: u.class_name, division: u.division, stream: u.stream, phone: u.phone });

app.post('/api/login', rateLimit({ windowMs: 15 * 60 * 1000, max: 30 }), ah(async (req, res) => {
  const loginId = norm(req.body.loginId), code = clean(req.body.instCode).toUpperCase() || null, pw = String(req.body.password || '');
  const { rows } = await q(`SELECT u.*, i.active AS inst_active, i.type AS inst_type, i.name AS inst_name, i.code AS inst_code FROM users u LEFT JOIN institutions i ON i.id = u.institution_id WHERE u.login_id = $1 AND ($2::text IS NULL OR upper(i.code) = $2) LIMIT 20`, [loginId, code]);
  const ok = [];
  for (const u of rows) if (u.active && u.inst_active !== false && (await bcrypt.compare(pw, u.password_hash))) ok.push(u);
  if (!ok.length) return res.status(401).json({ error: 'Wrong ID or password' });
  if (ok.length > 1) return res.status(409).json({ error: 'This ID is used in more than one school or tuition. Choose one.', needsInstitution: true, options: ok.map((u) => ({ code: u.inst_code, name: u.inst_name, type: u.inst_type, role: u.role })) });
  const u = ok[0];
  const token = jwt.sign({ id: u.id, role: u.role, inst: u.institution_id, tv: Number(u.token_version || 0) }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { ...publicUser(u), institutionType: u.inst_type, institutionName: u.inst_name, institutionCode: u.inst_code } });
}));
app.get('/api/me', auth(), ah(async (req, res) => {
  const { rows } = await q(`SELECT u.*, i.active AS inst_active, i.type AS inst_type, i.name AS inst_name, i.code AS inst_code FROM users u LEFT JOIN institutions i ON i.id = u.institution_id WHERE u.id=$1`, [req.user.id]);
  const u = rows[0];
  if (!u || !u.active || u.inst_active === false) return res.status(401).json({ error: 'Please login again' });
  const out = { ...publicUser(u), institutionType: u.inst_type, institutionName: u.inst_name, institutionCode: u.inst_code };
  if (u.role === 'parent') {
    out.children = (await q(`SELECT c.id, c.name, c.login_id AS "loginId", c.class_name AS "className", c.division, c.stream FROM parent_student ps JOIN users c ON c.id = ps.student_id WHERE ps.parent_id=$1`, [req.user.id])).rows;
  }
  res.json(out);
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
const INST_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newInstCode = () => { const b = crypto.randomBytes(6); let s = ''; for (let i = 0; i < 6; i++) s += INST_CODE_CHARS[b[i] % INST_CODE_CHARS.length]; return 'ME-' + s; };
app.post('/api/owner/institutions', auth('owner'), ah(async (req, res) => {
  const b = req.body || {};
  const type = b.type === 'tuition' ? 'tuition' : 'school';
  if (!clean(b.name) || !clean(b.adminName) || !clean(b.loginId) || String(b.password || '').length < 6) return res.status(400).json({ error: 'Name, admin name, login ID and password (min 6) required' });
  if (norm(b.loginId) === norm(OWNER_LOGIN_ID)) return res.status(409).json({ error: 'Login ID already taken' });
  const hash = await bcrypt.hash(String(b.password), 10);
  for (let attempt = 0; attempt < 5; attempt++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const inst = (await client.query('INSERT INTO institutions (type, name, phone, email, code) VALUES ($1,$2,$3,$4,$5) RETURNING id, code', [type, clean(b.name), clean(b.phone), clean(b.email), newInstCode()])).rows[0];
      await client.query('INSERT INTO users (institution_id, role, login_id, password_hash, name, phone, email, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [inst.id, type === 'school' ? 'admin' : 'inst_owner', norm(b.loginId), hash, clean(b.adminName), clean(b.phone), clean(b.email), req.user.id]);
      await client.query('COMMIT');
      return res.json({ ok: true, institutionId: inst.id, institutionCode: inst.code });
    } catch (e) {
      await client.query('ROLLBACK');
      if (e.code === '23505' && /code/.test(String(e.constraint || ''))) continue;   // institute code collision: try a new one
      if (e.code === '23505') return res.status(409).json({ error: 'Login ID already taken' });
      throw e;
    } finally { client.release(); }
  }
  res.status(500).json({ error: 'Could not create institute, try again' });
}));
app.delete('/api/owner/institutions/:id', auth('owner'), ah(async (req, res) => { await q('DELETE FROM institutions WHERE id=$1', [req.params.id]); res.json({ ok: true }); }));

// ---------- people: owner/admin -> teachers ; teacher -> students + parents ----------
async function createUser(req, res, role, extra = {}) {
  const b = req.body || {};
  if (!clean(b.name) || !clean(b.loginId) || String(b.password || '').length < 6) return res.status(400).json({ error: 'Name, login ID and password (min 6) required' });
  if (norm(b.loginId) === norm(OWNER_LOGIN_ID)) return res.status(409).json({ error: 'Login ID already taken' });
  if (req.user.role === 'teacher' && role === 'student') {
    const mine = await myClasses(req.user);
    if (!mine.length) return res.status(403).json({ error: NO_CLASSES });
    if (!canClass(mine, b.className, b.division)) return res.status(403).json({ error: 'You can only add students to your own classes' });
  }
  try {
    const hash = await bcrypt.hash(String(b.password), 10);
    const { rows } = await q('INSERT INTO users (institution_id, role, login_id, password_hash, name, phone, email, class_name, division, stream, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',
      [req.user.inst, role, norm(b.loginId), hash, clean(b.name), clean(b.phone), clean(b.email), clean(b.className) || null, clean(b.division) || null, clean(b.stream) || null, req.user.id]);
    if (extra.studentId) await q('INSERT INTO parent_student (parent_id, student_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [rows[0].id, extra.studentId]);
    res.json(publicUser(rows[0]));
  } catch (e) { if (e.code === '23505') return res.status(409).json({ error: 'Login ID already taken' }); throw e; }
}
const listUsers = (role) => ah(async (req, res) => {
  let rows = (await q(
    `SELECT u.id, u.name, u.login_id AS "loginId", u.phone, u.class_name AS "className", u.division, u.stream,
            (SELECT json_agg(json_build_object('id', c.id, 'name', c.name, 'className', c.class_name, 'division', c.division)) FROM parent_student ps JOIN users c ON c.id = ps.student_id WHERE ps.parent_id = u.id) AS children
     FROM users u WHERE u.institution_id=$1 AND u.role=$2 AND u.active ORDER BY u.name`, [req.user.inst, role])).rows;
  const mine = await myClasses(req.user);
  if (mine) {   // teacher: only own classes
    if (role === 'student') rows = rows.filter((r) => classAllowed(mine, r.className, r.division));
    else if (role === 'parent') rows = rows.filter((r) => (r.children || []).some((c) => classAllowed(mine, c.className, c.division)));
  }
  res.json(rows);
});
const deleteUser = (role) => ah(async (req, res) => {
  if (!(await teacherMayManage(req, req.params.id))) return res.status(403).json({ error: 'This person is not in your class' });
  const r = await q('DELETE FROM users WHERE id=$1 AND institution_id=$2 AND role=$3', [req.params.id, req.user.inst, role]);
  res.json({ ok: r.rowCount > 0 });
});
// reset someone's password: owner -> any admin; admin -> own teachers/students/parents; teacher -> own students/parents
app.post('/api/users/:id/password', auth('owner', 'admin', 'inst_owner', 'teacher'), ah(async (req, res) => {
  const pw = String((req.body && req.body.password) || '');
  if (pw.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const target = (await q('SELECT id, role, institution_id FROM users WHERE id=$1', [req.params.id])).rows[0];
  if (!target) return res.status(404).json({ error: 'User not found' });
  const me = req.user;
  let ok = false;
  if (me.role === 'owner') ok = target.role === 'admin' || target.role === 'inst_owner';
  else if (String(target.institution_id) !== String(me.inst)) ok = false;
  else if (me.role === 'admin' || me.role === 'inst_owner') ok = ['teacher', 'student', 'parent'].includes(target.role);
  else if (me.role === 'teacher') ok = ['student', 'parent'].includes(target.role) && (await teacherMayManage(req, target.id));
  if (!ok) return res.status(403).json({ error: 'Not allowed' });
  await q('UPDATE users SET password_hash=$1, token_version=token_version+1 WHERE id=$2', [await bcrypt.hash(pw, 10), target.id]);
  authCache.delete(String(target.id));
  res.json({ ok: true });
}));
// change my own password (all roles). Old sessions stop working; a fresh token is returned.
app.post('/api/me/password', auth(), rateLimit({ windowMs: 15 * 60 * 1000, max: 10, keyGenerator: (req) => 'u' + req.user.id }), ah(async (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (String(newPassword || '').length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });
  const u = (await q('SELECT * FROM users WHERE id=$1', [req.user.id])).rows[0];
  if (!u || !(await bcrypt.compare(String(oldPassword || ''), u.password_hash))) return res.status(400).json({ error: 'Current password is wrong' });
  const nv = Number(u.token_version || 0) + 1;
  await q('UPDATE users SET password_hash=$1, token_version=$2 WHERE id=$3', [await bcrypt.hash(String(newPassword), 10), nv, u.id]);
  authCache.delete(String(u.id));
  res.json({ ok: true, token: jwt.sign({ id: u.id, role: u.role, inst: u.institution_id, tv: nv }, JWT_SECRET, { expiresIn: '30d' }) });
}));
// admin edits a teacher (name, classes, subject, phone)
app.patch('/api/teachers/:id', auth('admin', 'inst_owner'), ah(async (req, res) => {
  const b = req.body || {};
  const r = await q(`UPDATE users SET name=COALESCE(NULLIF($1,''),name), class_name=COALESCE(NULLIF($2,''),class_name), stream=COALESCE(NULLIF($3,''),stream), phone=COALESCE(NULLIF($4,''),phone) WHERE id=$5 AND institution_id=$6 AND role='teacher'`,
    [clean(b.name), clean(b.className), clean(b.stream), clean(b.phone), req.params.id, req.user.inst]);
  tcCache.delete(String(req.params.id));
  res.json({ ok: r.rowCount > 0 });
}));
app.get('/api/teachers', auth('admin', 'inst_owner'), listUsers('teacher'));
app.post('/api/teachers', auth('admin', 'inst_owner'), ah((req, res) => createUser(req, res, 'teacher')));
app.delete('/api/teachers/:id', auth('admin', 'inst_owner'), deleteUser('teacher'));

app.get('/api/students', auth('teacher', 'admin', 'inst_owner'), listUsers('student'));
app.post('/api/students', auth('teacher'), ah((req, res) => createUser(req, res, 'student')));
app.delete('/api/students/:id', auth('teacher'), deleteUser('student'));

app.get('/api/parents', auth('teacher', 'admin', 'inst_owner'), listUsers('parent'));
app.post('/api/parents', auth('teacher'), ah(async (req, res) => {
  const st = (await q("SELECT id, class_name, division FROM users WHERE id=$1 AND institution_id=$2 AND role='student'", [req.body.studentId, req.user.inst])).rows[0];
  if (!st) return res.status(400).json({ error: 'Choose a valid student for this parent' });
  if (!canClass(await myClasses(req.user), st.class_name, st.division)) return res.status(403).json({ error: 'This student is not in your class' });
  return createUser(req, res, 'parent', { studentId: st.id });
}));
app.delete('/api/parents/:id', auth('teacher'), deleteUser('parent'));

// ---------- attendance: absent student => in-app notification to parents ----------
app.post('/api/attendance', auth('teacher'), ah(async (req, res) => {
  const day = clean(req.body.date) || new Date().toISOString().slice(0, 10);
  const records = Array.isArray(req.body.records) ? req.body.records : [];
  const mine = await myClasses(req.user);
  let absent = 0;
  for (const r of records) {
    const st = (await q("SELECT id, name, class_name, division FROM users WHERE id=$1 AND institution_id=$2 AND role='student'", [r.studentId, req.user.inst])).rows[0];
    if (!st || !canClass(mine, st.class_name, st.division)) continue;
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
// staff: attendance of one day for the whole institution (teacher marks, admin watches live)
app.get('/api/attendance', auth('teacher', 'admin', 'inst_owner'), ah(async (req, res) => {
  const day = clean(req.query.date) || new Date().toISOString().slice(0, 10);
  const mine = await myClasses(req.user);
  const rows = (await q('SELECT a.student_id AS "studentId", a.status, u.class_name, u.division FROM attendance a JOIN users u ON u.id=a.student_id WHERE a.institution_id=$1 AND a.day=$2', [req.user.inst, day])).rows;
  res.json(rows.filter((r) => canClass(mine, r.class_name, r.division)).map(({ studentId, status }) => ({ studentId, status })));
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
  let target = null;   // null = whole institution (admin only); otherwise the classes it is for
  const mine = await myClasses(req.user);
  if (mine) {
    if (!mine.length) return res.status(403).json({ error: NO_CLASSES });
    const asked = parseClasses(req.body.className);
    target = (asked.length ? asked : mine);
    if (!target.every((t) => mine.includes(t) || mine.some((m) => t.startsWith(m)))) return res.status(403).json({ error: 'You can only post to your own classes' });
    target = target.join(',');
  } else if (clean(req.body.className)) target = parseClasses(req.body.className).join(',') || null;
  await q('INSERT INTO announcements (institution_id, audience, class_name, title, body, created_by) VALUES ($1,$2,$3,$4,$5,$6)', [req.user.inst, aud, target, clean(req.body.title), clean(req.body.body), req.user.id]);
  res.json({ ok: true });
}));
app.get('/api/announcements', auth('admin', 'inst_owner', 'teacher', 'student', 'parent'), ah(async (req, res) => {
  const mineAud = { student: 'students', parent: 'parents', teacher: 'teachers' }[req.user.role];
  let rows = (await q(`SELECT a.id, a.audience, a.class_name, a.created_by, a.title, a.body, a.created_at AS "createdAt", u.name AS "by" FROM announcements a LEFT JOIN users u ON u.id=a.created_by
    WHERE a.institution_id=$1 AND ($2::text IS NULL OR a.audience IN ('all',$2)) ORDER BY a.created_at DESC LIMIT 200`, [req.user.inst, mineAud || null])).rows;
  const mine = await myClasses(req.user), viewer = await viewerClasses(req.user);
  rows = rows.filter((a) => {
    if (!a.class_name) return true;
    const tokens = parseClasses(a.class_name);
    if (req.user.role === 'teacher') return a.created_by === req.user.id || tokens.some((t) => mine.includes(t) || mine.some((m) => t.startsWith(m) || m.startsWith(t)));
    if (viewer) return viewer.some((v) => classAllowed(tokens, v.cls, v.div));
    return true;
  });
  res.json(rows.slice(0, 100).map(({ class_name, created_by, ...rest }) => rest));
}));
app.delete('/api/announcements/:id', auth('admin', 'inst_owner', 'teacher'), ah(async (req, res) => {
  const own = req.user.role === 'teacher';   // a teacher can remove only what they posted
  await q('DELETE FROM announcements WHERE id=$1 AND institution_id=$2 AND ($3::boolean = FALSE OR created_by=$4)', [req.params.id, req.user.inst, own, req.user.id]);
  res.json({ ok: true });
}));
// ---------- study material PDFs -> owner's Google Drive ----------
function drive() {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) throw new Error('Google Drive is not configured');
  const oauth = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
  oauth.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
  return google.drive({ version: 'v3', auth: oauth });
}
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
async function mayUseDoc(user, d) {
  const mine = await myClasses(user), viewer = await viewerClasses(user);
  if (!d.class_name) return mine === null || mine.length > 0 || d.uploaded_by === user.id;
  if (mine) return d.uploaded_by === user.id || classAllowed(mine, d.class_name, '') || mine.some((m) => normCls(d.class_name) === m);
  if (viewer) return viewer.some((v) => normCls(v.cls) === normCls(d.class_name));
  return true;
}
app.post('/api/documents', auth('teacher'), upload.single('file'), ah(async (req, res) => {
  const f = req.file;
  if (!f || f.mimetype !== 'application/pdf' || !clean(req.body.title)) return res.status(400).json({ error: 'Send a PDF file and a title' });
  const mine = await myClasses(req.user);
  if (!mine.length) return res.status(403).json({ error: NO_CLASSES });
  if (clean(req.body.className) && !canClass(mine, req.body.className, '')) return res.status(403).json({ error: 'You can only upload for your own classes' });
  const r = await drive().files.create({
    requestBody: { name: `${req.user.inst}-${Date.now()}-${f.originalname}`.slice(0, 150), parents: DRIVE_FOLDER_ID ? [DRIVE_FOLDER_ID] : undefined },
    media: { mimeType: 'application/pdf', body: Readable.from(f.buffer) }, fields: 'id',
  });
  await q('INSERT INTO documents (institution_id, class_name, subject, title, drive_file_id, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6)',
    [req.user.inst, clean(req.body.className) || null, clean(req.body.subject) || null, clean(req.body.title), r.data.id, req.user.id]);
  res.json({ ok: true });
}));
app.get('/api/documents', auth('teacher', 'admin', 'inst_owner', 'student', 'parent'), ah(async (req, res) => {
  const rows = (await q(`SELECT id, title, subject, class_name, uploaded_by, created_at AS "createdAt" FROM documents WHERE institution_id=$1 ORDER BY created_at DESC`, [req.user.inst])).rows;
  const out = [];
  for (const d of rows) if (await mayUseDoc(req.user, d)) out.push({ id: d.id, title: d.title, subject: d.subject, className: d.class_name, createdAt: d.createdAt });
  res.json(out);
}));
app.get('/api/documents/:id/file', auth('teacher', 'admin', 'inst_owner', 'student', 'parent'), ah(async (req, res) => {
  const d = (await q('SELECT drive_file_id, title, class_name, uploaded_by FROM documents WHERE id=$1 AND institution_id=$2', [req.params.id, req.user.inst])).rows[0];
  if (!d || !(await mayUseDoc(req.user, d))) return res.status(404).json({ error: 'Not found' });
  const r = await drive().files.get({ fileId: d.drive_file_id, alt: 'media' }, { responseType: 'stream' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${d.title.replace(/[^\w .-]/g, '_')}.pdf"`);
  r.data.pipe(res);
}));
app.delete('/api/documents/:id', auth('teacher', 'admin', 'inst_owner'), ah(async (req, res) => {
  const cur = (await q('SELECT class_name, uploaded_by FROM documents WHERE id=$1 AND institution_id=$2', [req.params.id, req.user.inst])).rows[0];
  if (!cur) return res.json({ ok: false });
  if (req.user.role === 'teacher' && cur.uploaded_by !== req.user.id && !(cur.class_name && canClass(await myClasses(req.user), cur.class_name, ''))) return res.status(403).json({ error: 'Not your class' });
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
  const system = `You are Samantha, the friendly AI tutor of MyEduAI, helping Indian students. If asked your name, say you are Samantha. Class ${clean(b.cls) || 'not given'}, subject ${clean(b.subject) || 'general'}. Reply in ${clean(b.language) || 'English'}. ${how} Keep answers short and correct. If a question is not about studies, politely bring the student back to studies.`;
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


// ---------- homework file upload (stored in Google Drive, tracked in v2_files) ----------
const uploadHw = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
app.post('/api/files', auth('student', 'teacher', 'admin', 'inst_owner'), uploadHw.single('file'), ah(async (req, res) => {
  const f = req.file;
  if (!f) return res.status(400).json({ error: 'Choose a file' });
  if (!/^(application\/pdf|image\/(png|jpe?g|webp)|application\/msword|application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document|text\/plain)$/.test(f.mimetype)) return res.status(400).json({ error: 'Only PDF, image, Word or text files are allowed' });
  let d;
  try { d = drive(); } catch (e) { return res.status(503).json({ error: 'File upload is not set up yet' }); }
  const r = await d.files.create({
    requestBody: { name: `hw-${req.user.inst}-${Date.now()}-${f.originalname}`.slice(0, 150), parents: DRIVE_FOLDER_ID ? [DRIVE_FOLDER_ID] : undefined },
    media: { mimeType: f.mimetype, body: Readable.from(f.buffer) }, fields: 'id',
  });
  const id = crypto.randomUUID();
  await q('INSERT INTO v2_files (id, institution_id, drive_file_id, name, mime, size, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6,$7)', [id, String(req.user.inst), r.data.id, f.originalname.slice(0, 150), f.mimetype, f.size, String(req.user.id)]);
  res.json({ id, name: f.originalname });
}));
app.get('/api/files/:id', auth(), ah(async (req, res) => {
  const row = (await q('SELECT * FROM v2_files WHERE id=$1 AND institution_id=$2', [req.params.id, String(req.user.inst)])).rows[0];
  if (!row) return res.status(404).json({ error: 'File not found' });
  if (!isStaffRole(req.user.role) && row.uploaded_by !== String(req.user.id)) {
    const mine = req.user.role === 'parent' && (await q('SELECT 1 FROM parent_student WHERE parent_id=$1 AND student_id::text=$2', [req.user.id, row.uploaded_by])).rowCount;
    if (!mine) return res.status(403).json({ error: 'Not allowed' });
  }
  const r = await drive().files.get({ fileId: row.drive_file_id, alt: 'media' }, { responseType: 'stream' });
  res.setHeader('Content-Type', row.mime);
  res.setHeader('Content-Disposition', `inline; filename="${row.name.replace(/[^\w .-]/g, '_')}"`);
  r.data.pipe(res);
}));

// ---------- school data kept per institution as JSON documents ----------
// w = who may write: staff (teacher/admin), admin (admin only), own (a student, own rows only)
// r = who may read:  all (everyone in the institution), staff, own (a student/parent sees only their child's rows), notif (class-wide + own)
const V2_KINDS = {
  homework: { w: 'staff', r: 'all' },
  tests: { w: 'staff', r: 'all' },
  library: { w: 'staff', r: 'all' },
  events: { w: 'staff', r: 'all' },
  timetable: { w: 'staff', r: 'all' },
  notifications: { w: 'staff', r: 'notif' },
  feePlans: { w: 'admin', r: 'staff' },
  invoices: { w: 'admin', r: 'own' },
  submissions: { w: 'own', r: 'own' },
  attempts: { w: 'own', r: 'own' },
};
const isStaffRole = (r) => r === 'teacher' || r === 'admin' || r === 'inst_owner';
const isAdminRole = (r) => r === 'admin' || r === 'inst_owner';
const studentKey = (id) => 'MYEDU' + String(id).slice(-6);
async function ownKeys(user) {
  if (user.role === 'student') return [studentKey(user.id)];
  if (user.role === 'parent') return (await q('SELECT student_id FROM parent_student WHERE parent_id=$1', [user.id])).rows.map((r) => studentKey(r.student_id));
  return [];
}
const canWrite = (user, w) => (w === 'staff' ? isStaffRole(user.role) : w === 'admin' ? isAdminRole(user.role) : false);
const v2Cls = (d) => ({ cls: d.cls ?? d.className ?? '', div: d.div ?? d.division ?? '' });
// studentKey -> class of every student of one institution (to scope submissions / attempts / invoices by class)
async function studentClassByKey(inst) {
  const m = {};
  (await q("SELECT id, class_name, division FROM users WHERE institution_id=$1 AND role='student'", [inst])).rows.forEach((r) => { m[studentKey(r.id)] = r; });
  return m;
}
app.get('/api/v2/:kind', auth(), ah(async (req, res) => {
  const kind = req.params.kind;
  const cfg = V2_KINDS[kind];
  if (!cfg) return res.status(404).json({ error: 'Unknown type' });
  if (!req.user.inst) return res.json([]);
  const staff = isStaffRole(req.user.role);
  if (cfg.r === 'staff' && !staff) return res.json([]);
  const { rows } = await q('SELECT data FROM v2_docs WHERE institution_id=$1 AND kind=$2 ORDER BY created_at', [String(req.user.inst), kind]);
  let out = rows.map((r) => r.data);
  if (!staff && (cfg.r === 'own' || cfg.r === 'notif')) {
    const keys = await ownKeys(req.user);
    out = out.filter((d) => (cfg.r === 'notif' && !d.studentKey) || keys.includes(d.studentKey));
  }
  // class scoping: a teacher gets only own classes, a student / parent only their own class
  const mine = await myClasses(req.user), viewer = await viewerClasses(req.user);
  if (mine !== null || viewer) {
    const byKey = mine !== null && out.some((d) => d.studentKey) ? await studentClassByKey(String(req.user.inst)) : null;
    out = out.filter((d) => {
      if (byKey && d.studentKey) { const s = byKey[d.studentKey]; return !!s && classAllowed(mine, s.class_name, s.division); }
      const c = v2Cls(d);
      return seesClass(viewer, mine, c.cls, c.div);
    });
  }
  if (kind === 'tests' && !staff) out = out.map((t) => (t.resultsPublished ? t : { ...t, questions: (t.questions || []).map(({ correct, ...rest }) => rest) }));
  res.json(out);
}));
app.put('/api/v2/:kind/:id', auth(), ah(async (req, res) => {
  const kind = req.params.kind;
  const cfg = V2_KINDS[kind];
  if (!cfg) return res.status(404).json({ error: 'Unknown type' });
  if (!req.user.inst) return res.status(403).json({ error: 'Not allowed' });
  const id = clean(req.params.id).slice(0, 80);
  const data = req.body && req.body.data;
  if (!id || !data || typeof data !== 'object' || Array.isArray(data)) return res.status(400).json({ error: 'Invalid data' });
  const inst = String(req.user.inst);
  const old = (await q('SELECT data FROM v2_docs WHERE institution_id=$1 AND kind=$2 AND id=$3', [inst, kind, id])).rows[0];
  if (cfg.w === 'own') {
    if (!isStaffRole(req.user.role)) {
      if (req.user.role !== 'student' || data.studentKey !== studentKey(req.user.id)) return res.status(403).json({ error: 'Not allowed' });
      if (kind === 'attempts' && old) return res.status(409).json({ error: 'Already submitted' });
      if (kind === 'attempts') {
        const test = (await q(`SELECT data FROM v2_docs WHERE institution_id=$1 AND kind='tests' AND id=$2`, [inst, String(data.testId)])).rows[0];
        if (!test) return res.status(404).json({ error: 'Test not found' });
        const tc = v2Cls(test.data), me = await viewerClasses(req.user);
        if (!seesClass(me, null, tc.cls, tc.div)) return res.status(403).json({ error: 'This test is not for your class' });
        const used = Number((await q(`SELECT COUNT(*) AS n FROM v2_docs WHERE institution_id=$1 AND kind='attempts' AND data->>'studentKey'=$2 AND data->>'testId'=$3`, [inst, data.studentKey, String(data.testId)])).rows[0].n);
        if (used >= (Number(test.data.attemptLimit) || 1)) return res.status(409).json({ error: 'Attempt limit reached' });
      }
      if (kind === 'submissions') {
        data.graded = old ? old.data.graded : false;
        data.marks = old ? old.data.marks : null;
        data.feedback = old ? old.data.feedback : '';
      }
    }
  } else if (!canWrite(req.user, cfg.w)) {
    return res.status(403).json({ error: cfg.w === 'admin' ? 'Only the school admin can do this' : 'Only teachers can do this' });
  }
  // a teacher can create / change items only for the classes assigned to them
  const mine = await myClasses(req.user);
  if (mine !== null) {
    const nc = v2Cls(data);
    if (normCls(nc.cls) && !classAllowed(mine, nc.cls, nc.div)) return res.status(403).json({ error: 'You can only do this for your own classes' });
    if (['homework', 'tests'].includes(kind) && !normCls(nc.cls)) return res.status(400).json({ error: 'Choose a class' });
    if (old) {
      const oc = v2Cls(old.data);
      if (normCls(oc.cls) && !classAllowed(mine, oc.cls, oc.div)) return res.status(403).json({ error: 'This belongs to another class' });
    }
  }
  data.id = id;
  data.demo = false;
  await q(`INSERT INTO v2_docs (institution_id, kind, id, data, created_by) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (institution_id, kind, id) DO UPDATE SET data=EXCLUDED.data, updated_at=now()`, [inst, kind, id, JSON.stringify(data), String(req.user.id)]);
  res.json({ ok: true });
}));
app.delete('/api/v2/:kind/:id', auth(), ah(async (req, res) => {
  const cfg = V2_KINDS[req.params.kind];
  if (!cfg) return res.status(404).json({ error: 'Unknown type' });
  const w = cfg.w === 'own' ? 'staff' : cfg.w;
  if (!canWrite(req.user, w)) return res.status(403).json({ error: 'Not allowed' });
  const inst = String(req.user.inst), id = clean(req.params.id);
  const mine = await myClasses(req.user);
  if (mine !== null) {
    const old = (await q('SELECT data FROM v2_docs WHERE institution_id=$1 AND kind=$2 AND id=$3', [inst, req.params.kind, id])).rows[0];
    if (old) {
      let ok;
      if (old.data.studentKey) { const s = (await studentClassByKey(inst))[old.data.studentKey]; ok = !!s && classAllowed(mine, s.class_name, s.division); }
      else { const c = v2Cls(old.data); ok = !normCls(c.cls) || classAllowed(mine, c.cls, c.div); }
      if (!ok) return res.status(403).json({ error: 'This belongs to another class' });
    }
  }
  await q('DELETE FROM v2_docs WHERE institution_id=$1 AND kind=$2 AND id=$3', [inst, req.params.kind, id]);
  res.json({ ok: true });
}));

// ---------- MCQ content: shared bank (read only) + each institution's own questions ----------
const MCQ_MAX = 300;
const mcqLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, keyGenerator: (req) => 'u' + (req.user ? req.user.id : req.ip) });
// students only get Class 12 banks when they are in Class 12; staff and parents see everything
async function studentLevel(user) {
  if (user.role !== 'student') return null;
  const r = (await q('SELECT class_name FROM users WHERE id=$1', [user.id])).rows[0];
  return classNum(r && r.class_name);
}
// which classes (6 to 12) may this person open in the Turso content? student = own class, parent = children's classes, teacher = assigned classes, admin = all
async function allowedStds(user) {
  const all = turso.stds();
  const viewer = await viewerClasses(user), mine = await myClasses(user);
  if (viewer) return [...new Set(viewer.map((v) => classNum(v.cls)))].filter((n) => all.includes(n));
  if (mine) return [...new Set(mine.map((m) => parseInt(m, 10)))].filter((n) => all.includes(n));
  return all;
}
const pickStd = (allowed, asked) => { const n = parseInt(asked, 10); return allowed.includes(n) ? n : allowed[0]; };
app.get('/api/content/std', auth(), ah(async (req, res) => {
  if (!turso.ready()) return res.json({ stds: [], std: null });
  const stds = await allowedStds(req.user);
  res.json({ stds, std: pickStd(stds, req.query.std) || null });
}));
app.get('/api/content/mcq/subjects', auth(), mcqLimiter, ah(async (req, res) => {
  if (turso.ready()) {
    const std = pickStd(await allowedStds(req.user), req.query.std);
    if (std) {
      const own = req.user.inst ? (await q('SELECT subject, chapter, COUNT(*) AS n FROM inst_mcq WHERE institution_id=$1::int AND std=$2 GROUP BY 1, 2', [req.user.inst, std])).rows : [];
      const rows = [...(await turso.subjects(std))];
      for (const o of own) { const r = rows.find((x) => x.subject === o.subject && x.chapter === o.chapter); if (r) r.n += Number(o.n); }
      const out = [];
      for (const r of rows) { let s = out[out.length - 1]; if (!s || s.subject !== r.subject) { s = { subject: r.subject, chapters: [] }; out.push(s); } s.chapters.push({ name: r.chapter, count: r.n }); }
      return res.json(out);
    }
  }
  const level = await studentLevel(req.user);
  const rows = (await q(`SELECT s.subject, s.min_class, c.chapter,
      (SELECT COUNT(*) FROM mcq_questions mq WHERE mq.chapter = c.chapter) + (SELECT COUNT(*) FROM inst_mcq im WHERE im.chapter = c.chapter AND im.institution_id = $1::int) AS n
    FROM mcq_subjects s JOIN mcq_chapters c ON c.subject = s.subject ORDER BY s.sort, s.subject, c.sort, c.chapter`, [req.user.inst || null])).rows;
  const out = [];
  for (const r of rows) {
    if (level !== null && r.min_class && level < r.min_class) continue;
    let s = out[out.length - 1];
    if (!s || s.subject !== r.subject) { s = { subject: r.subject, chapters: [] }; out.push(s); }
    s.chapters.push({ name: r.chapter, count: Number(r.n) });
  }
  res.json(out);
}));
app.get('/api/content/mcq/questions', auth(), mcqLimiter, ah(async (req, res) => {
  const chapter = clean(req.query.chapter), subject = clean(req.query.subject);
  const count = Math.max(1, Math.min(MCQ_MAX, parseInt(req.query.count, 10) || MCQ_MAX));
  const mine = await myClasses(req.user), viewer = await viewerClasses(req.user);
  const addOwn = (list, own) => {
    for (const r of own) {
      const tokens = parseClasses(r.class_name);
      const see = !tokens.length || (viewer ? viewer.some((v) => classAllowed(tokens, v.cls, v.div)) : mine ? mine.some((m) => tokens.includes(m) || tokens.some((t) => t.startsWith(m) || m.startsWith(t))) : true);
      if (see) list.push({ id: r.id, question: r.question, options: r.options, answer: r.answer, byTeacher: true });
    }
  };
  let list;
  const std = turso.ready() && subject ? pickStd(await allowedStds(req.user), req.query.std) : null;
  if (std) {   // class 6-12 content from Turso
    list = (await turso.questions(std, subject, chapter)).map((x) => ({ ...x }));
    if (!list.length) return res.status(404).json({ error: 'Chapter not found' });
    if (req.user.inst) addOwn(list, (await q('SELECT 1000000 + id AS id, question, options, answer, class_name FROM inst_mcq WHERE institution_id=$1::int AND std=$2 AND subject=$3 AND chapter=$4', [req.user.inst, std, subject, chapter])).rows);
  } else {     // older shared bank in PostgreSQL
    const ch = (await q('SELECT s.min_class FROM mcq_chapters c JOIN mcq_subjects s ON s.subject = c.subject WHERE c.chapter=$1', [chapter])).rows[0];
    if (!ch) return res.status(404).json({ error: 'Chapter not found' });
    const level = await studentLevel(req.user);
    if (level !== null && ch.min_class && level < ch.min_class) return res.status(403).json({ error: 'Not available for your class' });
    list = (await q('SELECT qid AS id, question, options, answer FROM mcq_questions WHERE chapter=$1', [chapter])).rows.map((r) => ({ ...r, byTeacher: false }));
    if (req.user.inst) addOwn(list, (await q('SELECT 1000000 + id AS id, question, options, answer, class_name FROM inst_mcq WHERE chapter=$1 AND institution_id=$2::int AND std IS NULL', [chapter, req.user.inst])).rows);
  }
  if (req.query.random !== '0') for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
  else list.sort((a, b) => a.id - b.id);
  res.json({ total: list.length, questions: list.slice(0, count) });
}));
// teachers / admin add questions that only their own institution sees
app.post('/api/content/mcq', auth('teacher', 'admin', 'inst_owner'), ah(async (req, res) => {
  const b = req.body || {};
  const chapter = clean(b.chapter), subject = clean(b.subject), question = clean(b.question).slice(0, 1000);
  const options = (Array.isArray(b.options) ? b.options : []).map((o) => clean(o).slice(0, 300));
  const answer = Number(b.answer);
  if (!question || options.length < 2 || options.length > 6 || options.some((o) => !o) || !Number.isInteger(answer) || answer < 0 || answer >= options.length) return res.status(400).json({ error: 'Write the question, 2 to 6 options and the right answer' });
  let std = null;
  if (turso.ready() && subject) {
    std = pickStd(await allowedStds(req.user), b.std);
    if (!std || !(await turso.subjects(std)).some((r) => r.subject === subject && r.chapter === chapter)) return res.status(400).json({ error: 'Choose a valid class, subject and chapter' });
  } else if (!(await q('SELECT 1 FROM mcq_chapters WHERE chapter=$1', [chapter])).rowCount) return res.status(400).json({ error: 'Choose a valid chapter' });
  let target = parseClasses(b.className);
  const mine = await myClasses(req.user);
  if (mine) {
    if (!mine.length) return res.status(403).json({ error: NO_CLASSES });
    if (!target.length) target = mine;
    if (!target.every((t) => mine.includes(t) || mine.some((m) => t.startsWith(m)))) return res.status(403).json({ error: 'You can only add for your own classes' });
  }
  const r = (await q('INSERT INTO inst_mcq (institution_id, std, subject, chapter, question, options, answer, class_name, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id', [req.user.inst, std, std ? subject : null, chapter, question, JSON.stringify(options), answer, target.join(',') || null, req.user.id])).rows[0];
  res.json({ ok: true, id: 1000000 + r.id });
}));
app.get('/api/content/mcq/mine', auth('teacher', 'admin', 'inst_owner'), ah(async (req, res) => {
  const mine = await myClasses(req.user);
  let rows = (await q(`SELECT 1000000 + id AS id, std, subject, chapter, question, options, answer, class_name AS "className", created_by FROM inst_mcq WHERE institution_id=$1 AND ($2::text IS NULL OR chapter=$2) AND ($3::text IS NULL OR subject=$3) ORDER BY id DESC LIMIT 500`, [req.user.inst, clean(req.query.chapter) || null, clean(req.query.subject) || null])).rows;
  if (mine) rows = rows.filter((r) => r.created_by === req.user.id);
  res.json(rows.map(({ created_by, ...rest }) => rest));
}));

// ---------- backups (owner only) ----------
let backupRunning = false;
app.post('/api/owner/backup/run', auth('owner'), (req, res) => {
  if (backupRunning) return res.json({ started: false, message: 'A backup is already running' });
  backupRunning = true;
  backup.runBackup().then((r) => console.log('backup', JSON.stringify(r))).catch((e) => console.error('backup failed:', e.message)).then(() => { backupRunning = false; });
  res.json({ started: true });
});
app.get('/api/owner/backup/status', auth('owner'), ah(async (req, res) => res.json({ running: backupRunning, logs: await backup.lastLogs() })));
app.get('/api/owner/content/status', auth('owner'), (req, res) => res.json(turso.getStatus()));
app.delete('/api/content/mcq/:id', auth('teacher', 'admin', 'inst_owner'), ah(async (req, res) => {
  const id = Number(req.params.id) - 1000000;
  const own = req.user.role === 'teacher';
  const r = await q('DELETE FROM inst_mcq WHERE id=$1 AND institution_id=$2 AND ($3::boolean = FALSE OR created_by=$4)', [id, req.user.inst, own, req.user.id]);
  res.json({ ok: r.rowCount > 0 });
}));

// loads the shared MCQ bank from content/mcq.json (safe to run again; keeps every institution's own questions)
async function seedMcq() {
  const f = path.join(__dirname, 'content', 'mcq.json');
  if (!fs.existsSync(f)) return;
  const have = Number((await q('SELECT COUNT(*) AS n FROM mcq_questions')).rows[0].n);
  if (have > 0 && process.env.SEED_MCQ !== 'force') return;
  const data = JSON.parse(fs.readFileSync(f, 'utf8'));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let si = 0;
    for (const s of data.subjects) {
      await client.query('INSERT INTO mcq_subjects (subject, min_class, sort) VALUES ($1,$2,$3) ON CONFLICT (subject) DO UPDATE SET min_class=EXCLUDED.min_class, sort=EXCLUDED.sort', [s.subject, s.minClass || null, si++]);
      let ci = 0;
      for (const c of s.chapters) await client.query('INSERT INTO mcq_chapters (chapter, subject, sort) VALUES ($1,$2,$3) ON CONFLICT (chapter) DO UPDATE SET subject=EXCLUDED.subject, sort=EXCLUDED.sort', [c, s.subject, ci++]);
    }
    await client.query('DELETE FROM mcq_questions');
    const all = [];
    for (const [chapter, list] of Object.entries(data.questions)) for (const x of list) all.push([chapter, x.id, x.question, JSON.stringify(x.options), x.answer]);
    for (let i = 0; i < all.length; i += 500) {
      const part = all.slice(i, i + 500);
      await client.query(`INSERT INTO mcq_questions (chapter, qid, question, options, answer) SELECT chapter, qid, question, options::jsonb, answer FROM unnest($1::text[], $2::int[], $3::text[], $4::text[], $5::int[]) AS t(chapter, qid, question, options, answer)`,
        [part.map((r) => r[0]), part.map((r) => r[1]), part.map((r) => r[2]), part.map((r) => r[3]), part.map((r) => r[4])]);
    }
    await client.query('COMMIT');
    console.log('MCQ bank loaded:', all.length, 'questions');
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}
app.get('/', (req, res) => res.json({ app: 'MyEduAI backend', ok: true }));
app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'File too large (max 10 MB)' });
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

(async () => {
  await q(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  await q(`CREATE TABLE IF NOT EXISTS v2_docs (
    institution_id TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, data JSONB NOT NULL, created_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (institution_id, kind, id))`);
  await q('ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INT NOT NULL DEFAULT 0');
  // v2 migrations (all safe to run again)
  await q('ALTER TABLE institutions ADD COLUMN IF NOT EXISTS code TEXT');
  await q('ALTER TABLE announcements ADD COLUMN IF NOT EXISTS class_name TEXT');
  await q('CREATE UNIQUE INDEX IF NOT EXISTS institutions_code_key ON institutions (code) WHERE code IS NOT NULL');
  for (const r of (await q('SELECT id FROM institutions WHERE code IS NULL')).rows) {
    for (let k = 0; k < 8; k++) { try { await q('UPDATE institutions SET code=$1 WHERE id=$2', [newInstCode(), r.id]); break; } catch (e) { if (e.code !== '23505') throw e; } }
  }
  // login IDs: unique inside one institution (not across all of them), so the same person can be in a school AND a tuition
  await q('ALTER TABLE users DROP CONSTRAINT IF EXISTS users_login_id_key');
  await q('CREATE UNIQUE INDEX IF NOT EXISTS users_inst_login ON users (institution_id, login_id) WHERE institution_id IS NOT NULL');
  await q('CREATE UNIQUE INDEX IF NOT EXISTS users_owner_login ON users (login_id) WHERE institution_id IS NULL');
  await seedMcq();
  await q('ALTER TABLE inst_mcq ADD COLUMN IF NOT EXISTS std INT');
  await q('ALTER TABLE inst_mcq ADD COLUMN IF NOT EXISTS subject TEXT');
  await q('ALTER TABLE inst_mcq DROP CONSTRAINT IF EXISTS inst_mcq_chapter_fkey');
  // Supabase publishes every table of the public schema through its web API. Switch row security on (no policies) so
  // only this server (the database owner) can read the tables, not someone holding the public anon key. SKIP_RLS=1 turns this off.
  if (process.env.SKIP_RLS !== '1') {
    for (const t of (await q("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows) {
      try { await q('ALTER TABLE public."' + t.tablename.replace(/"/g, '""') + '" ENABLE ROW LEVEL SECURITY'); } catch (e) { console.error('RLS not set on', t.tablename, e.message); }
    }
  }
  await turso.init();
  if (process.env.BACKUP_AT_SERVER === '1') setInterval(async () => {   // optional: run the daily backup from this server (02:00 IST), if no cron is set up
    try { const h = new Date(Date.now() + 5.5 * 3600 * 1000).getUTCHours(); if (h !== 2 || backupRunning) return; const done = (await backup.lastLogs()).some((t) => (t.last || []).some((l) => l.ok && l.day === backup.ist())); if (done) return; backupRunning = true; await backup.runBackup(); } catch (e) { console.error('scheduled backup failed:', e.message); } finally { backupRunning = false; }
  }, 10 * 60 * 1000);
  await q(`CREATE TABLE IF NOT EXISTS v2_files (
    id TEXT PRIMARY KEY, institution_id TEXT NOT NULL, drive_file_id TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL,
    size INT, uploaded_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  if (OWNER_PASSWORD) {
    const has = (await q("SELECT 1 FROM users WHERE role='owner' LIMIT 1")).rowCount;
    if (!has) { await q("INSERT INTO users (role, login_id, password_hash, name, email) VALUES ('owner',$1,$2,'Mohit Yadav',$3)", [norm(OWNER_LOGIN_ID), await bcrypt.hash(OWNER_PASSWORD, 10), OWNER_EMAIL]); console.log('Owner account created'); }
  }
  app.listen(PORT, () => console.log('MyEduAI backend on', PORT));
})().catch((e) => { console.error(e); process.exit(1); });
