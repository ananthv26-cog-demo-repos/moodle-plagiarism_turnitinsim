'use strict';
// Mock of the Turnitin Core API (TCA) surface used by plagiarism_turnitinsim.
// Deterministic: similarity = share of 5-word shingles found in corpus.txt.
// Zero dependencies so it runs straight from the node:22 image.

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 80);
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const MOODLE_PUBLIC_URL = (process.env.MOODLE_PUBLIC_URL || 'http://localhost:8080').replace(/\/$/, '');
const MOODLE_INTERNAL_URL = (process.env.MOODLE_INTERNAL_URL || MOODLE_PUBLIC_URL).replace(/\/$/, '');
const WEBHOOK_DELAY_MS = Number(process.env.WEBHOOK_DELAY_MS || 1500);
const STATE_FILE = process.env.STATE_FILE || '/data/state.json';
const API_KEY = process.env.API_KEY || 'northgate-sandbox-key';
const EULA_VERSION = 'v1beta';

// ---------------------------------------------------------------- state
const state = { webhooks: {}, submissions: {}, launches: {}, requests: [] };
function load() {
  try { Object.assign(state, JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))); } catch (e) { /* fresh */ }
}
function save() {
  try { fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify(state)); } catch (e) { /* read-only fs is fine */ }
}
load();

// ---------------------------------------------------------------- corpus
const SHINGLE = 5;
const corpus = (() => {
  const text = fs.readFileSync(path.join(__dirname, 'corpus.txt'), 'utf8');
  const sources = [];
  let current = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('# source:')) {
      const [url, repo, name] = line.replace('# source:', '').split('|').map(s => s.trim());
      current = { url, repository: repo, name, text: '' };
      sources.push(current);
    } else if (current && line.trim()) {
      current.text += (current.text ? ' ' : '') + line.trim();
    }
  }
  const shingles = new Map(); // shingle -> source index
  sources.forEach((s, i) => { for (const sh of shinglesOf(tokenize(s.text).words)) if (!shingles.has(sh)) shingles.set(sh, i); });
  return { sources, shingles };
})();


function tokenize(text) {
  // Keep original token offsets so the viewer can highlight the raw text.
  const words = []; const spans = [];
  const re = /[A-Za-z0-9][A-Za-z0-9'’-]*/g; let m;
  while ((m = re.exec(text))) { words.push(m[0].toLowerCase().replace(/[’']/g, '')); spans.push([m.index, m.index + m[0].length]); }
  return { words, spans };
}
function shinglesOf(words) {
  const out = []; for (let i = 0; i + SHINGLE <= words.length; i++) out.push(words.slice(i, i + SHINGLE).join(' '));
  return out;
}
function score(text, opts = {}) {
  const { words, spans } = tokenize(text);
  const covered = new Array(words.length).fill(-1);
  const sh = shinglesOf(words);
  sh.forEach((s, i) => {
    const src = corpus.shingles.get(s);
    if (src !== undefined) for (let k = i; k < i + SHINGLE; k++) covered[k] = src;
  });
  const total = words.length || 1;
  const perSource = corpus.sources.map(() => 0);
  covered.forEach(src => { if (src >= 0) perSource[src]++; });
  const overall = Math.round(100 * covered.filter(c => c >= 0).length / total);
  const byRepo = { INTERNET: 0, PUBLICATION: 0, SUBMITTED_WORK: 0 };
  corpus.sources.forEach((s, i) => { byRepo[s.repository] += perSource[i]; });
  const pct = n => Math.round(100 * n / total);
  const matches = corpus.sources.map((s, i) => ({ name: s.name, url: s.url, repository: s.repository, percentage: pct(perSource[i]), matched_word_count: perSource[i] }))
    .filter(m => m.matched_word_count > 0).sort((a, b) => b.percentage - a.percentage);
  // Highlight spans for the viewer.
  const highlights = [];
  let i = 0;
  while (i < words.length) {
    if (covered[i] >= 0) { const src = covered[i]; const start = spans[i][0]; while (i < words.length && covered[i] === src) i++; highlights.push({ start, end: spans[i - 1][1], source: src }); } else i++;
  }
  return {
    overall_match_percentage: overall,
    internet_match_percentage: pct(byRepo.INTERNET),
    publication_match_percentage: pct(byRepo.PUBLICATION),
    submitted_works_match_percentage: pct(byRepo.SUBMITTED_WORK),
    word_count: words.length,
    top_matches: matches,
    highlights,
  };
}

// ---------------------------------------------------------------- helpers
const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
function send(res, status, body, headers = {}) {
  const isObj = body !== null && typeof body === 'object';
  const payload = isObj ? JSON.stringify(body) : (body == null ? '' : String(body));
  res.writeHead(status, Object.assign({ 'Content-Type': isObj ? 'application/json' : 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(payload) }, headers));
  res.end(payload);
}
function readBody(req) {
  return new Promise(resolve => { const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => resolve(Buffer.concat(chunks))); });
}
function log(entry) { state.requests.push(Object.assign({ at: now() }, entry)); if (state.requests.length > 500) state.requests.shift(); save(); }
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fireWebhook(eventType, payload) {
  const body = JSON.stringify(payload);
  for (const wh of Object.values(state.webhooks)) {
    if (!wh.event_types.includes(eventType)) continue;
    const target = new URL(wh.url.replace(MOODLE_PUBLIC_URL, MOODLE_INTERNAL_URL));
    const publicHost = new URL(wh.url).host;
    const sig = crypto.createHmac('sha256', Buffer.from(wh.signing_secret, 'base64')).update(body).digest('hex');
    const req = http.request({
      method: 'POST', hostname: target.hostname, port: target.port || 80, path: target.pathname + target.search,
      headers: { Host: publicHost, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'X-Turnitin-Signature': sig, 'X-Turnitin-EventType': eventType },
    }, res => { let out = ''; res.on('data', c => out += c); res.on('end', () => log({ kind: 'webhook', event: eventType, url: wh.url, status: res.statusCode, response: out.slice(0, 300), payload })); });
    req.on('error', err => log({ kind: 'webhook', event: eventType, url: wh.url, error: err.message, payload }));
    req.end(body);
  }
}

// ---------------------------------------------------------------- pages
function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;background:#f4f5f7;color:#1b1f23}
header{background:#0d1b2a;color:#fff;padding:14px 24px;display:flex;align-items:center;gap:14px}
header .brand{font-weight:700;letter-spacing:.3px}header .tag{font-size:12px;background:#ff5a00;padding:2px 8px;border-radius:10px}
main{max-width:1000px;margin:24px auto;padding:0 24px;display:grid;grid-template-columns:1fr 300px;gap:24px}
.card{background:#fff;border-radius:8px;padding:20px 24px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
.paper{white-space:pre-wrap;line-height:1.7;font-family:Georgia,serif;font-size:16px}
mark{padding:1px 0;border-radius:2px}
.s0{background:#ffd6d6}.s1{background:#d6e6ff}.s2{background:#e3d6ff}
.score{font-size:48px;font-weight:700}
.badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:12px;font-weight:600;color:#fff}
dl{display:grid;grid-template-columns:auto 1fr;gap:6px 12px;font-size:14px}dt{color:#666}
.src{margin:8px 0;font-size:14px}.src .pct{display:inline-block;min-width:40px;font-weight:700}
.eula p{line-height:1.6}
</style></head><body>
<header><span class="brand">turnitin</span><span class="tag">SANDBOX MOCK</span><span style="margin-left:auto;font-size:13px;opacity:.8">${esc(title)}</span></header>
${body}</body></html>`;
}

function viewerPage(sub, launch) {
  const rep = sub.report;
  const anonymous = !(launch.given_name || launch.family_name);
  const author = anonymous ? 'Anonymous student' : `${launch.given_name || ''} ${launch.family_name || ''}`.trim();
  const role = launch.viewer_default_permission_set || 'LEARNER';
  let html = ''; let cursor = 0;
  const text = sub.text || '';
  for (const h of (rep ? rep.highlights : [])) { html += esc(text.slice(cursor, h.start)); html += `<mark class="s${h.source}" title="${esc(corpus.sources[h.source].name)}">${esc(text.slice(h.start, h.end))}</mark>`; cursor = h.end; }
  html += esc(text.slice(cursor));
  const colour = p => p === 0 ? '#4ea3f0' : p <= 25 ? '#70c30f' : p <= 50 ? '#d4b800' : p <= 75 ? '#ffa400' : '#f03a3a';
  const sources = rep ? rep.top_matches.map((m, i) => `<div class="src" data-testid="viewer-source"><span class="pct">${m.percentage}%</span> <span class="badge" style="background:#555">${esc(m.repository)}</span> ${esc(m.name)}</div>`).join('') : '<em>Report not generated yet.</em>';
  const vs = launch.similarity && launch.similarity.view_settings || {};
  return page(`Similarity Report - ${sub.title}`, `<main>
  <section class="card">
    <h2 data-testid="viewer-title" style="margin-top:0">${esc(sub.title)}</h2>
    <div style="color:#555;margin-bottom:16px">Author: <strong data-testid="viewer-author">${esc(author)}</strong>
      &middot; Viewing as <span data-testid="viewer-role" class="badge" style="background:${role === 'INSTRUCTOR' ? '#0d6efd' : '#6c757d'}">${esc(role)}</span></div>
    <div class="paper" data-testid="viewer-paper">${html}</div>
  </section>
  <aside>
    <div class="card" style="text-align:center">
      <div style="font-size:12px;color:#666;text-transform:uppercase">Overall similarity</div>
      <div class="score" data-testid="viewer-score" style="color:${rep ? colour(rep.overall_match_percentage) : '#999'}">${rep ? rep.overall_match_percentage + '%' : '—'}</div>
      <div style="font-size:12px;color:#666">${rep ? rep.word_count + ' words' : ''}</div>
    </div>
    <div class="card" style="margin-top:16px"><h4 style="margin:0 0 8px">Match sources</h4>${sources}</div>
    <div class="card" style="margin-top:16px"><h4 style="margin:0 0 8px">Launch details</h4>
      <dl><dt>Submission</dt><dd data-testid="viewer-submission-id">${esc(sub.id)}</dd>
      <dt>Locale</dt><dd>${esc(launch.locale || '')}</dd>
      <dt>Exclude quotes</dt><dd data-testid="viewer-exclude-quotes">${vs.exclude_quotes ? 'yes' : 'no'}</dd>
      <dt>Exclude bibliography</dt><dd data-testid="viewer-exclude-bibliography">${vs.exclude_bibliography ? 'yes' : 'no'}</dd>
      <dt>Full source access</dt><dd data-testid="viewer-full-source">${launch.viewer_permissions && launch.viewer_permissions.may_view_submission_full_source ? 'yes' : 'no'}</dd></dl>
    </div>
  </aside></main>`);
}

function eulaPage() {
  return page('End User License Agreement', `<main style="grid-template-columns:1fr"><section class="card eula">
  <h2 data-testid="eula-heading" style="margin-top:0">Turnitin End User License Agreement (${EULA_VERSION})</h2>
  <p>This is the sandbox stand-in for the Turnitin EULA. Submissions sent through this harness never leave your machine: the "Turnitin" you are talking to is a mock service running in Docker.</p>
  <p>By accepting you agree that the mock may store your submitted text in memory for the lifetime of the container, compare it against a three-paragraph corpus about the printing press, and report the result back to Moodle.</p>
  </section></main>`);
}

function indexPage() {
  const subs = Object.values(state.submissions);
  const rows = subs.map(s => `<tr><td><code>${esc(s.id.slice(0, 8))}</code></td><td>${esc(s.title)}</td><td>${esc(s.status)}</td><td>${s.report ? s.report.overall_match_percentage + '%' : '—'}</td><td>${esc(s.metadata && s.metadata.owners && s.metadata.owners[0] ? [s.metadata.owners[0].given_name, s.metadata.owners[0].family_name].filter(Boolean).join(' ') || '(anonymous)' : '')}</td></tr>`).join('');
  return page('Mock console', `<main style="grid-template-columns:1fr"><section class="card">
  <h2 style="margin-top:0">Mock Turnitin console</h2>
  <p>${Object.keys(state.webhooks).length} webhook(s) registered &middot; ${subs.length} submission(s) &middot; ${state.requests.length} logged request(s)
  &middot; <a href="/__mock/requests">requests</a> &middot; <a href="/__mock/state">state</a></p>
  <table style="width:100%;border-collapse:collapse;font-size:14px"><tr><th align="left">id</th><th align="left">title</th><th align="left">status</th><th align="left">score</th><th align="left">owner sent as</th></tr>${rows}</table>
  </section></main>`);
}

// ---------------------------------------------------------------- router
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const raw = await readBody(req);
  let body = {};
  if ((req.headers['content-type'] || '').includes('json') && raw.length) { try { body = JSON.parse(raw.toString('utf8')); } catch (e) { body = {}; } }
  log({ kind: 'request', method: req.method, path: p, body: p.endsWith('/original') ? `<${raw.length} bytes>` : body });

  // Public pages (no auth).
  if (p === '/') return send(res, 200, indexPage());
  if (p === `/api/v1/eula/${EULA_VERSION}/view`) return send(res, 200, eulaPage());
  let m;
  if ((m = p.match(/^\/viewer\/([^/]+)\/([^/]+)$/))) {
    const sub = state.submissions[m[1]]; const launch = state.launches[m[2]];
    if (!sub || !launch || launch.submission_id !== sub.id) return send(res, 404, page('Not found', '<main><section class="card">Unknown viewer launch.</section></main>'));
    return send(res, 200, viewerPage(sub, launch));
  }
  if (p === '/__mock/state') return send(res, 200, state);
  if (p === '/__mock/requests') return send(res, 200, state.requests);
  if (p === '/__mock/reset' && req.method === 'POST') { state.submissions = {}; state.launches = {}; state.requests = []; save(); return send(res, 200, { ok: true }); }
  if (p === '/remote-logging/api/log') return send(res, 200, { ok: true });

  // Everything under /api needs a bearer token.
  const auth = req.headers.authorization || '';
  if (auth !== `Bearer ${API_KEY}`) return send(res, 403, { message: 'Missing or invalid API key' });

  if (p === '/api/v1/features-enabled') {
    return send(res, 200, {
      similarity: {
        viewer_modes: { match_overview: true, all_sources: true },
        generation_settings: { search_repositories: ['INTERNET', 'PUBLICATION', 'SUBMITTED_WORK'], submission_auto_excludes: true },
        view_settings: { exclude_bibliography: true, exclude_quotes: true, exclude_abstract: false, exclude_methods: false, exclude_small_sources: false, exclude_small_matches: false, exclude_internet: true, exclude_publications: true, exclude_submitted_works: true },
      },
      tenant: { require_eula: true },
      product_name: 'Turnitin Integrity (sandbox mock)',
    });
  }
  if (p === '/api/v1/eula/latest') {
    return send(res, 200, { version: EULA_VERSION, valid_from: '2018-05-01T00:00:00Z', valid_until: null, url: `${PUBLIC_URL}/api/v1/eula/${EULA_VERSION}/view`, available_languages: ['en-US', 'en-GB', 'de-DE', 'es-MX'] });
  }

  if (p === '/api/v1/webhooks' && req.method === 'GET') return send(res, 200, Object.values(state.webhooks).map(w => ({ id: w.id, url: w.url, description: w.description, created_time: w.created_time, event_types: w.event_types, allow_insecure: w.allow_insecure })));
  if (p === '/api/v1/webhooks' && req.method === 'POST') {
    if (Object.values(state.webhooks).some(w => w.url === body.url)) return send(res, 409, { message: 'A webhook already exists for this URL' });
    const wh = { id: uuid(), url: body.url, description: body.description || '', created_time: now(), event_types: body.event_types || [], allow_insecure: !!body.allow_insecure, signing_secret: body.signing_secret };
    state.webhooks[wh.id] = wh; save();
    const { signing_secret, ...pub } = wh;
    return send(res, 201, pub);
  }
  if ((m = p.match(/^\/api\/v1\/webhooks\/([^/]+)$/))) {
    const wh = state.webhooks[m[1]];
    if (!wh) return send(res, 404, { message: 'Webhook not found' });
    if (req.method === 'DELETE') { delete state.webhooks[m[1]]; save(); return send(res, 204, null); }
    const { signing_secret, ...pub } = wh; return send(res, 200, pub);
  }

  if (p === '/api/v1/submissions' && req.method === 'POST') {
    const sub = { id: uuid(), owner: body.owner, submitter: body.submitter, title: body.title, status: 'CREATED', created_time: now(), metadata: body.metadata || {}, eula: body.eula || null, owner_default_permission_set: body.owner_default_permission_set, submitter_default_permission_set: body.submitter_default_permission_set, text: null, report: null };
    if (!sub.eula) return send(res, 451, { message: 'EULA has not been accepted by the owner' });
    state.submissions[sub.id] = sub; save();
    return send(res, 201, { owner: sub.owner, title: sub.title, status: sub.status, id: sub.id, created_time: sub.created_time });
  }
  if ((m = p.match(/^\/api\/v1\/submissions\/([^/]+)(?:\/(original|similarity|viewer-url))?$/))) {
    const sub = state.submissions[m[1]]; const action = m[2];
    if (!sub) return send(res, 404, { message: `Submission ${m[1]} not found` });
    if (!action && req.method === 'GET') return send(res, 200, { id: sub.id, owner: sub.owner, title: sub.title, status: sub.status, created_time: sub.created_time, content_type: 'text/plain', page_count: 1, word_count: sub.text ? tokenize(sub.text).words.length : 0, character_count: sub.text ? sub.text.length : 0 });
    if (action === 'original' && req.method === 'PUT') {
      sub.text = raw.toString('utf8'); sub.status = 'PROCESSING'; save();
      setTimeout(() => { sub.status = 'COMPLETE'; save(); fireWebhook('SUBMISSION_COMPLETE', { id: sub.id, owner: sub.owner, title: sub.title, status: 'COMPLETE', content_type: 'text/plain', page_count: 1, word_count: tokenize(sub.text).words.length, character_count: sub.text.length, created_time: sub.created_time }); }, WEBHOOK_DELAY_MS);
      return send(res, 202, { message: `Successfully uploaded file for submission ${sub.id}` });
    }
    if (action === 'similarity' && req.method === 'PUT') {
      if (sub.status !== 'COMPLETE') return send(res, 409, { message: 'CANNOT_EXTRACT_TEXT' });
      const words = tokenize(sub.text || '').words.length;
      if (words < 20) return send(res, 422, { message: 'TOO_LITTLE_TEXT' });
      sub.generation_settings = body.generation_settings; sub.view_settings = body.view_settings;
      sub.report_status = 'PROCESSING'; sub.time_requested = now(); save();
      setTimeout(() => {
        sub.report = score(sub.text); sub.report_status = 'COMPLETE'; sub.time_generated = now(); save();
        const r = sub.report;
        fireWebhook('SIMILARITY_COMPLETE', { submission_id: sub.id, overall_match_percentage: r.overall_match_percentage, internet_match_percentage: r.internet_match_percentage, publication_match_percentage: r.publication_match_percentage, submitted_works_match_percentage: r.submitted_works_match_percentage, status: 'COMPLETE', time_requested: sub.time_requested, time_generated: sub.time_generated, top_source_largest_matched_word_count: r.top_matches[0] ? r.top_matches[0].matched_word_count : 0, top_matches: r.top_matches });
      }, WEBHOOK_DELAY_MS);
      return send(res, 202, { message: 'Successfully scheduled similarity report generation' });
    }
    if (action === 'similarity' && req.method === 'GET') {
      if (!sub.report) return send(res, 200, { submission_id: sub.id, status: sub.report_status || 'PROCESSING' });
      const r = sub.report;
      return send(res, 200, { submission_id: sub.id, overall_match_percentage: r.overall_match_percentage, internet_match_percentage: r.internet_match_percentage, publication_match_percentage: r.publication_match_percentage, submitted_works_match_percentage: r.submitted_works_match_percentage, status: 'COMPLETE', time_requested: sub.time_requested, time_generated: sub.time_generated, top_matches: r.top_matches });
    }
    if (action === 'viewer-url' && req.method === 'POST') {
      const token = uuid();
      state.launches[token] = Object.assign({ submission_id: sub.id, at: now() }, body); save();
      return send(res, 200, { viewer_url: `${PUBLIC_URL}/viewer/${sub.id}/${token}` });
    }
  }
  return send(res, 404, { message: `No mock route for ${req.method} ${p}` });
});

server.listen(PORT, () => console.log(`mock turnitin listening on :${PORT}, public ${PUBLIC_URL}, webhooks -> ${MOODLE_INTERNAL_URL} (Host ${MOODLE_PUBLIC_URL})`));
