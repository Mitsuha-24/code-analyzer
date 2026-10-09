'use strict';
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Tunables. They only affect DERIVED data; the raw .jsonl is never modified,
// so you can change these and re-run the ingest at any time.
// ---------------------------------------------------------------------------
const LARGE_THRESHOLD = 15;          // same value as LARGE_INSERTION_THRESHOLD in extension.ts
const MAX_EVENTS_PER_WINDOW = 2000;  // same value as MAX_RAW_EVENTS_PER_WINDOW in extension.ts
const BURST_GAP_MS = 1000;           // a gap longer than this ends a typing burst
const MIN_BURST_LEN = 3;             // fewer typed changes than this is not counted as a burst

// Events worth storing one-by-one. Everything else (edit, diagnostic_change,
// small deletions) is summarised inside the window document instead.
const NOTABLE_TYPES = new Set([
  'large_insertion', 'focus_loss', 'focus_gain', 'save', 'tab_switch',
  'terminal_run', 'task_start', 'debug_start', 'debug_end', 'git_commit'
]);
const TYPED_TYPES = new Set(['edit', 'deletion']); // used for typing rhythm
const EVENT_OPTIONAL_FIELDS = [
  'file', 'language', 'charsAdded', 'charsDeleted', 'insertionSize', 'deletionSize',
  'pasteSource', 'diagnosticsErrors', 'diagnosticsWarnings', 'durationMs'
];
// Not stored on the window: events go to their own collection, and the three
// ai* fields are always 'unknown' in the plugin (labels live on the session).
const DROPPED_WINDOW_FIELDS = ['events', 'aiUsage', 'aiTool', 'aiAssistanceLevel'];

const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();
const sha = (alg, s) => crypto.createHash(alg).update(s).digest('hex');
const validDate = (x) => x != null && !Number.isNaN(new Date(x).getTime());
const round1 = (x) => Math.round(x * 10) / 10;

function classify(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  if (r.payloadType === 'code_snapshot') return 'snapshot';
  if (r.windowStart && r.windowEnd) return 'window';
  return null;
}

// Returns an error string, or null when the record is usable.
function validate(kind, r) {
  if (!r.sessionId || typeof r.sessionId !== 'string') return 'missing_sessionId';
  if (!r.studentId || typeof r.studentId !== 'string') return 'missing_studentId';
  if (kind === 'window') {
    if (!validDate(r.windowStart) || !validDate(r.windowEnd) || !validDate(r.receivedAt)) return 'bad_date';
  } else {
    if (!validDate(r.timestamp)) return 'bad_date';
    if (typeof r.content !== 'string') return 'missing_content';
    if (!r.file) return 'missing_file';
  }
  return null;
}

function sessionMeta(r) {
  return {
    studentId: r.studentId,
    taskId: r.taskId || 'unknown',
    schemaVersion: r.schemaVersion || null,
    machineId: r.machineId || null,
    projectId: r.projectId || null
  };
}

function isNotable(e) {
  if (NOTABLE_TYPES.has(e.eventType)) return true;
  return e.eventType === 'deletion' && (e.deletionSize || 0) >= LARGE_THRESHOLD; // big block deletes only
}

// FR-15: typing rhythm from the raw edit events, computed BEFORE the edit events are dropped.
function typingRhythm(events) {
  const ts = events
    .filter((e) => TYPED_TYPES.has(e.eventType))
    .map((e) => Date.parse(e.timestamp))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  const out = {
    typedChanges: ts.length, intervalCount: 0,
    meanMs: null, medianMs: null, stdMs: null, p90Ms: null, maxMs: null,
    burstCount: 0, meanBurstLen: null
  };
  if (ts.length < 2) return out; // nothing to measure (FR-27: missing data handled, not an error)

  const iv = [];
  for (let i = 1; i < ts.length; i++) iv.push(ts[i] - ts[i - 1]);
  const sorted = [...iv].sort((a, b) => a - b);
  const n = iv.length;
  const mean = iv.reduce((a, b) => a + b, 0) / n;
  const std = Math.sqrt(iv.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;

  let burstCount = 0, burstTotal = 0, len = 1;
  const closeBurst = () => { if (len >= MIN_BURST_LEN) { burstCount++; burstTotal += len; } };
  for (const gap of iv) {
    if (gap <= BURST_GAP_MS) len++;
    else { closeBurst(); len = 1; }
  }
  closeBurst();

  Object.assign(out, {
    intervalCount: n, meanMs: round1(mean), medianMs: round1(median), stdMs: round1(std),
    p90Ms: sorted[Math.ceil(0.9 * n) - 1], maxMs: sorted[n - 1],
    burstCount, meanBurstLen: burstCount ? round1(burstTotal / burstCount) : null
  });
  return out;
}

function buildWindow(r) {
  const evs = Array.isArray(r.events) ? r.events : [];
  const rest = { ...r };
  for (const f of DROPPED_WINDOW_FIELDS) delete rest[f];

  const eventTypeCounts = {};
  for (const e of evs) eventTypeCounts[e.eventType] = (eventTypeCounts[e.eventType] || 0) + 1;

  return {
    _id: `${r.sessionId}|${r.windowStart}`, // deterministic => re-ingest overwrites, never duplicates
    ...rest,
    receivedAt: new Date(r.receivedAt),
    windowStart: new Date(r.windowStart),
    windowEnd: new Date(r.windowEnd),
    typingRhythm: typingRhythm(evs),
    eventTypeCounts,
    notableEventCount: evs.filter(isNotable).length,
    eventsTruncated: evs.length >= MAX_EVENTS_PER_WINDOW // the plugin silently drops events past its cap
  };
}

// Only notable events become documents; returns how many were seen in total.
function buildEvents(r) {
  const evs = Array.isArray(r.events) ? r.events : [];
  const kept = [];
  for (const e of evs) {
    if (!e || !isNotable(e) || !validDate(e.timestamp)) continue;
    const doc = {
      _id: e.eventId || sha('sha1', `${r.sessionId}|${e.timestamp}|${e.eventType}|${e.file || ''}`),
      sessionId: e.sessionId || r.sessionId,
      ts: new Date(e.timestamp),
      eventType: e.eventType
    };
    for (const f of EVENT_OPTIONAL_FIELDS) if (e[f] !== undefined) doc[f] = e[f];
    kept.push(doc);
  }
  return { kept, total: evs.length };
}

// Snapshot text goes to a file (SRS: file storage); the document keeps a reference + hash.
function buildSnapshot(r) {
  const contentHash = sha('sha256', r.content);
  const doc = {
    _id: sha('sha1', `${r.sessionId}|${r.timestamp}|${r.file}|${r.trigger}`),
    sessionId: r.sessionId,
    studentId: r.studentId,
    takenAt: new Date(r.timestamp),
    trigger: r.trigger || null,
    file: r.file,
    language: r.language || null,
    contentHash,
    sizeBytes: Buffer.byteLength(r.content),
    contentRef: `${r.sessionId.replace(/[^\w.-]/g, '_')}/${contentHash}.txt`
  };
  return { doc, content: r.content };
}

module.exports = {
  norm, classify, validate, sessionMeta, isNotable,
  typingRhythm, buildWindow, buildEvents, buildSnapshot,
  MAX_EVENTS_PER_WINDOW, LARGE_THRESHOLD
};