// MyEdu - MCQ routes for the existing Express app (server.js) running on Cloudflare Workers.
// Put this file next to server.js. In server.js add:
//     const mcqRoutes = require('./mcq-routes');
//     app.use(mcqRoutes);      // place BEFORE any 404 / catch-all handler
// Needs:  npm i @libsql/client      Env: TURSO_DATABASE_URL, TURSO_AUTH_TOKEN (already in your Worker variables)
// Optional env: MCQ_TABLE (default "mcqs")
const express = require('express');
const { createClient } = require('@libsql/client/web');

const router = express.Router();
let db = null;
let cachedMap = null;

const getDb = () => db || (db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN }));
const table = () => process.env.MCQ_TABLE || 'mcqs';

async function getMap() {
  if (cachedMap) return cachedMap;
  const t = table();
  if (!/^[A-Za-z0-9_]+$/.test(t)) throw new Error('bad table name');
  const info = await getDb().execute(`PRAGMA table_info(${t})`);
  const cols = info.rows.map((r) => String(r.name));
  const pick = (...n) => n.find((x) => cols.includes(x)) || null;
  const m = {
    id: pick('id'), question: pick('question', 'q', 'question_text'),
    grade: pick('grade', 'class', 'std', 'standard', 'class_num'),
    subject: pick('subject'), chapter: pick('chapter', 'chapter_name'),
    options: pick('options', 'choices'),
    a: pick('option_a', 'opt_a', 'a'), b: pick('option_b', 'opt_b', 'b'),
    c: pick('option_c', 'opt_c', 'c'), d: pick('option_d', 'opt_d', 'd'),
    answer: pick('answer', 'correct', 'correct_answer', 'correct_option', 'ans'),
  };
  if (!m.question || !m.chapter || !m.answer) {
    console.log('MCQ unmapped columns', JSON.stringify({ table: t, cols }));
    throw new Error('MCQ columns not recognised');
  }
  return (cachedMap = m);
}

function toQuestion(row, m) {
  let options = [];
  if (m.options && row[m.options]) {
    try { options = JSON.parse(row[m.options]); } catch { options = String(row[m.options]).split('|'); }
  } else {
    options = [m.a, m.b, m.c, m.d].filter(Boolean).map((c) => row[c]).filter((x) => x != null && x !== '');
  }
  let ans = row[m.answer];
  if (typeof ans === 'string') {
    const k = ans.trim().toUpperCase();
    if (/^[A-D]$/.test(k)) ans = k.charCodeAt(0) - 65;
    else {
      const idx = options.findIndex((o) => String(o).trim().toUpperCase() === k);
      ans = idx >= 0 ? idx : parseInt(k, 10) - 1; // plain numbers treated as 1-based
    }
  }
  return { id: m.id ? row[m.id] : undefined, question: row[m.question], options, answer: ans };
}

router.use('/api/mcq', (req, res, next) => {
  res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

router.get('/api/mcq/chapters', async (req, res) => {
  try {
    const m = await getMap();
    const cls = parseInt(req.query.class, 10);
    const useG = m.grade && cls >= 6 && cls <= 12;
    const r = await getDb().execute({
      sql: `SELECT DISTINCT ${m.subject || "'General'"} AS subject, ${m.chapter} AS chapter FROM ${table()}
            WHERE ${m.chapter} IS NOT NULL AND ${m.chapter} != '' ${useG ? `AND ${m.grade} = ?` : ''} ORDER BY 1, 2`,
      args: useG ? [cls] : [],
    });
    const subjects = {};
    for (const row of r.rows) (subjects[row.subject] ||= []).push(row.chapter);
    res.json({ subjects });
  } catch (e) { console.log('mcq chapters error', e && e.message); res.status(500).json({ error: 'MCQ server error' }); }
});

router.get('/api/mcq', async (req, res) => {
  try {
    const m = await getMap();
    const chapter = String(req.query.chapter || '');
    const subject = String(req.query.subject || '');
    const cls = parseInt(req.query.class, 10);
    const count = Math.min(Math.max(parseInt(req.query.count, 10) || 0, 0), 500);
    const conds = [`${m.chapter} = ?`]; const args = [chapter];
    if (m.subject && subject) { conds.push(`${m.subject} = ?`); args.push(subject); }
    if (m.grade && cls >= 6 && cls <= 12) { conds.push(`${m.grade} = ?`); args.push(cls); }
    const where = conds.join(' AND ');
    const total = Number((await getDb().execute({ sql: `SELECT COUNT(*) AS n FROM ${table()} WHERE ${where}`, args })).rows[0].n);
    const r = await getDb().execute({ sql: `SELECT * FROM ${table()} WHERE ${where} ORDER BY RANDOM() LIMIT ${count || 500}`, args });
    res.json({ total, questions: r.rows.map((row) => toQuestion(row, m)) });
  } catch (e) { console.log('mcq error', e && e.message); res.status(500).json({ error: 'MCQ server error' }); }
});

router.post('/api/mcq/attempts', (req, res) => res.json({ ok: true }));

module.exports = router;
