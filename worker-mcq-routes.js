// MyEdu - MCQ routes served straight from Turso (no changes needed in server.js).
// Used by worker.js:  const mcq = await handleMcq(request, env); if (mcq) return mcq;
// Env (already in your Worker): TURSO_DATABASE_URL, TURSO_AUTH_TOKEN. Optional: MCQ_TABLE (default "mcqs").
import { createClient } from '@libsql/client/web';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...CORS } });

const envVal = (env, k) => (env && env[k]) || (typeof process !== 'undefined' && process.env ? process.env[k] : undefined);
let cachedMap = null;

async function getMap(db, table) {
  if (cachedMap) return cachedMap;
  if (!/^[A-Za-z0-9_]+$/.test(table)) throw new Error('bad table name');
  const info = await db.execute(`PRAGMA table_info(${table})`);
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
    console.log('MCQ unmapped columns', JSON.stringify({ table, cols }));
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

export async function handleMcq(request, env) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/mcq')) return null;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  try {
    const db = createClient({ url: envVal(env, 'TURSO_DATABASE_URL'), authToken: envVal(env, 'TURSO_AUTH_TOKEN') });
    const table = envVal(env, 'MCQ_TABLE') || 'mcqs';
    const m = await getMap(db, table);

    if (url.pathname === '/api/mcq/chapters' && request.method === 'GET') {
      const cls = parseInt(url.searchParams.get('class') || '', 10);
      const useG = m.grade && cls >= 6 && cls <= 12;
      const r = await db.execute({
        sql: `SELECT DISTINCT ${m.subject || "'General'"} AS subject, ${m.chapter} AS chapter FROM ${table}
              WHERE ${m.chapter} IS NOT NULL AND ${m.chapter} != '' ${useG ? `AND ${m.grade} = ?` : ''} ORDER BY 1, 2`,
        args: useG ? [cls] : [],
      });
      const subjects = {};
      for (const row of r.rows) (subjects[row.subject] ||= []).push(row.chapter);
      return json({ subjects });
    }

    if (url.pathname === '/api/mcq' && request.method === 'GET') {
      const chapter = url.searchParams.get('chapter') || '';
      const subject = url.searchParams.get('subject') || '';
      const cls = parseInt(url.searchParams.get('class') || '', 10);
      const count = Math.min(Math.max(parseInt(url.searchParams.get('count') || '0', 10) || 0, 0), 500);
      const conds = [`${m.chapter} = ?`]; const args = [chapter];
      if (m.subject && subject) { conds.push(`${m.subject} = ?`); args.push(subject); }
      if (m.grade && cls >= 6 && cls <= 12) { conds.push(`${m.grade} = ?`); args.push(cls); }
      const where = conds.join(' AND ');
      const total = Number((await db.execute({ sql: `SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, args })).rows[0].n);
      const r = await db.execute({ sql: `SELECT * FROM ${table} WHERE ${where} ORDER BY RANDOM() LIMIT ${count || 500}`, args });
      return json({ total, questions: r.rows.map((row) => toQuestion(row, m)) });
    }

    if (url.pathname === '/api/mcq/attempts' && request.method === 'POST') return json({ ok: true });
    return json({ error: 'Not found' }, 404);
  } catch (e) {
    console.log('mcq error', e && e.message);
    return json({ error: 'MCQ server error' }, 500);
  }
}
