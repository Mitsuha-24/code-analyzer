#!/usr/bin/env node
'use strict';
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { initDb, closeDb } = require('./Db');
const { ingestFile } = require('./ingest');
const { ingestAll } = require('./hooks');
const { norm } = require('./Transform');

const USAGE = `
node pipeline/cli.js ingest-all
node pipeline/cli.js ingest <file.jsonl>
node pipeline/cli.js add-user <email> "<name>" <instructor|admin> <password>
node pipeline/cli.js add-students <students.csv>        columns: studentId,name,email
node pipeline/cli.js add-assignment <assignmentId> "<title>" <language> <instructorEmail> <startISO> <endISO>
node pipeline/cli.js import-labels <labels.csv>         columns: studentId,assignmentId,label,aiTool,aiAssistanceLevel,promptRef
node pipeline/cli.js assign-splits <train%> <val%> <test%> <seed>
`;

// Plain CSV: header row, comma separated, no quoted commas.
function readCsv(file) {
  const [head, ...rows] = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim());
  const cols = head.split(',').map((c) => c.trim());
  return rows.map((l) => Object.fromEntries(l.split(',').map((v, i) => [cols[i], (v || '').trim()])));
}

function seededRandom(seed) { // mulberry32: same seed => same shuffle
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const commands = {
  async 'ingest-all'() {
    console.log(JSON.stringify(await ingestAll(), null, 2));
  },

  async ingest(db, [file]) {
    console.log(JSON.stringify(await ingestFile(file), null, 2));
  },

  async 'add-user'(db, [email, name, role, password]) {
    if (!['instructor', 'admin'].includes(role)) throw new Error('role must be instructor or admin (students come from add-students)');
    if (!email || !password) throw new Error('email and password are required');
    await db.collection('users').updateOne(
      { email },
      { $set: { name, role, passwordHash: await bcrypt.hash(password, 10) }, $setOnInsert: { createdAt: new Date(), source: 'manual' } },
      { upsert: true }
    );
    console.log(`user ${email} (${role}) saved`);
  },

  async 'add-students'(db, [file]) {
    let n = 0;
    for (const r of readCsv(file)) {
      if (!r.studentId) continue;
      const set = { name: r.name || null, role: 'student', studentId: r.studentId, source: 'roster' };
      if (r.email) set.email = r.email;
      await db.collection('users').updateOne(
        { studentKey: norm(r.studentId) },
        { $set: set, $setOnInsert: { passwordHash: null, createdAt: new Date() } }, // students are passive: no password
        { upsert: true }
      );
      n++;
    }
    console.log(`${n} students saved`);
  },

  async 'add-assignment'(db, [id, title, language, instructorEmail, start, end]) {
    const instructor = await db.collection('users').findOne({ email: instructorEmail });
    if (!instructor) throw new Error(`no user with email ${instructorEmail}; run add-user first`);
    await db.collection('assignments').replaceOne(
      { _id: id },
      { _id: id, instructorId: instructor._id, title, language, startTime: new Date(start), endTime: new Date(end) },
      { upsert: true }
    );
    console.log(`assignment ${id} saved. Set the plugin setting telemetryLogger.taskId = ${id} on the lab machines.`);
  },

  // Ground truth for the research dataset. A row without assignmentId labels ALL sessions of that student.
  async 'import-labels'(db, [file]) {
    let touched = 0;
    for (const r of readCsv(file)) {
      if (!['human', 'ai'].includes(r.label)) { console.warn(`skip ${r.studentId}: label must be human or ai (got "${r.label}")`); continue; }
      const filter = { studentKey: norm(r.studentId) };
      if (r.assignmentId) filter.assignmentId = r.assignmentId;
      const res = await db.collection('sessions').updateMany(filter, { $set: { label: {
        label: r.label, aiTool: r.aiTool || null, aiAssistanceLevel: r.aiAssistanceLevel || null,
        promptRef: r.promptRef || null, labelledAt: new Date()
      } } });
      if (!res.matchedCount) console.warn(`no session matched ${r.studentId}${r.assignmentId ? '/' + r.assignmentId : ''} (ingested yet? taskId set?)`);
      touched += res.matchedCount;
    }
    console.log(`${touched} session(s) labelled`);
  },

  // Participant-level split: every session of one student lands in the same split (paper section V.A).
  async 'assign-splits'(db, [train, val, test, seed]) {
    const [a, b, c] = [train, val, test].map(Number);
    if (![a, b, c].every(Number.isFinite) || a + b + c !== 100) throw new Error('percentages must add up to 100');
    const keys = (await db.collection('sessions').distinct('studentKey', { 'label.label': { $in: ['human', 'ai'] } })).sort();
    const rand = seededRandom(Number(seed) || 42);
    for (let i = keys.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [keys[i], keys[j]] = [keys[j], keys[i]]; }
    const nTrain = Math.round(keys.length * a / 100), nVal = Math.round(keys.length * b / 100);
    const counts = { train: 0, val: 0, test: 0 };
    for (let i = 0; i < keys.length; i++) {
      const split = i < nTrain ? 'train' : i < nTrain + nVal ? 'val' : 'test';
      await db.collection('sessions').updateMany({ studentKey: keys[i] }, { $set: { split } });
      counts[split]++;
    }
    console.log('participants per split:', counts, '(run once, after all labels are in, then freeze it)');
  }
};

(async () => {
  const [cmd, ...args] = process.argv.slice(2);
  if (!commands[cmd]) { console.log(USAGE); process.exit(cmd ? 1 : 0); }
  const db = await initDb();
  try { await commands[cmd](db, args); }
  finally { await closeDb(); }
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });