import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { state, save } from './src/store.js';
import { authUrl, finishAuth, isConnected, getSpace, listMessages, getMember } from './src/google.js';
import { parseMessage, summarize, issueKey, report } from './src/alerts.js';
import { solveIssue, askGroup } from './src/solve.js';
import { postInThread, postIn, announcement, replyIntent, mentionsBot, stripBot, sendDm, messageLink, owners, pullEvents, readEvent } from './src/bot.js';

const env = process.env;
const PORT = Number(env.PORT) || 4600;
const HOST = env.HOST || '127.0.0.1';
const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);
const SPACES = list(env.SPACES).map((s) => s.replace(/^spaces\//, ''));
const REPO_DIRS = list(env.REPO_DIRS);
const SYNC_MS = (Number(env.SYNC_MINUTES) || 1) * 60_000;
const FIRST_SYNC_DAYS = Number(env.FIRST_SYNC_DAYS) || 7;
const KEEP_DAYS = Number(env.KEEP_DAYS) || 30;
// The bot only posts in these groups, so it can be tried on a test group before the live ones.
const BOT_SPACES = env.BOT_KEY_FILE ? list(env.BOT_SPACES).map((s) => s.replace(/^spaces\//, '')) : [];
const BOT_NAME = env.BOT_NAME || 'Error Monitor';
const POST_WITHIN_MS = 60 * 60_000; // don't post on old alerts (the first sync reads days back)
// The Chat app's Pub/Sub subscription: DMs and @mentions arrive here instantly (polling never sees DMs).
const PUBSUB_SUBSCRIPTION = env.BOT_KEY_FILE ? env.PUBSUB_SUBSCRIPTION || '' : '';

// State files from before the bot.
state.teams ??= []; state.posts ??= {}; state.ours ??= {}; state.members ??= {}; state.notified ??= {}; state.handled ??= {}; delete state.userIds;

const bad = SPACES.filter((s) => !/^[\w-]+$/.test(s));
const badBot = BOT_SPACES.filter((s) => !SPACES.includes(s));
if (badBot.length) { console.error(`BOT_SPACES must also be in SPACES: ${badBot.join(', ')}`); process.exit(1); }
if (bad.length) { console.error(`SPACES has invalid IDs: ${bad.join(', ')}. Use the ID from the group URL, e.g. AAQA4jC2Ac0.`); process.exit(1); }
if (!['127.0.0.1', 'localhost', '::1'].includes(HOST) && !env.DASH_PASSWORD) {
  console.error(`Set DASH_PASSWORD before listening on ${HOST}: the dashboard shows client IDs and error payloads.`);
  process.exit(1);
}

// ---------- Sync GChat -> state ----------
let syncing = null;
const spaceErrors = {};

async function syncOnce() {
  const fresh = [], asks = [], tags = [], groupAsks = [];
  for (const id of SPACES) {
    try {
      if (!state.spaceNames[id]) state.spaceNames[id] = (await getSpace(id)).displayName || id;
      const name = state.spaceNames[id];
      const since = state.cursors[id] || new Date(Date.now() - FIRST_SYNC_DAYS * 86_400_000).toISOString();
      const msgs = await listMessages(id, since);
      const bot = BOT_SPACES.includes(id);
      for (const m of msgs) {
        if (state.ours[m.name] && m.sender?.name) state.botUser = m.sender.name; // learn the bot's own Chat user
        // Skip everything the bot itself posted, including posts made outside this server (tests, scripts).
        if (!m.text || state.ours[m.name] || (state.botUser && m.sender?.name === state.botUser)) continue;
        if (m.sender?.type === 'HUMAN') {
          if (bot && state.posts[m.thread?.name]) asks.push(m);
          else if (bot && mentionsBot(m.text, BOT_NAME)) groupAsks.push(m); // asked in the group, not about one alert
          if (bot && m.annotations?.some((x) => x.userMention?.user?.type === 'HUMAN')) tags.push(m);
          continue;
        }
        if (m.sender?.type !== 'BOT') continue; // alerts come from webhooks
        const a = parseMessage(m.text, { id: m.name, space: id, createTime: m.createTime });
        if (a.env === 'unknown') a.env = /beta/i.test(name) ? 'beta' : /live|prod/i.test(name) ? 'live' : 'unknown';
        if (state.alerts[a.id]) continue;
        state.alerts[a.id] = a;
        if (bot && m.thread?.name && Date.now() - Date.parse(m.createTime) < POST_WITHIN_MS) fresh.push({ a, thread: m.thread.name });
      }
      if (msgs.length) state.cursors[id] = msgs.at(-1).createTime;
      delete spaceErrors[id];
    } catch (e) {
      spaceErrors[id] = e.message;
      if (!isConnected()) break;
    }
  }
  const cutoff = Date.now() - KEEP_DAYS * 86_400_000;
  for (const [id, a] of Object.entries(state.alerts)) if (a.ts < cutoff) delete state.alerts[id];
  for (const [t, p] of Object.entries(state.posts)) if (p.at < cutoff) delete state.posts[t];
  for (const [n, at] of Object.entries(state.ours)) if (at < cutoff) delete state.ours[n];
  for (const [n, at] of Object.entries(state.handled)) if (at < cutoff) delete state.handled[n];
  for (const [u, list] of Object.entries(state.notified)) state.notified[u] = list.filter((x) => x.at >= cutoff);
  state.lastSync = Date.now();
  save();
  for (const f of fresh) await announce(f).catch((e) => { botError = e.message; });
  for (const m of tags) await tagged(m).catch((e) => { botError = e.message; });
  // Claude can take a minute or two: answer in the background so syncing keeps going.
  for (const m of asks) if (claim(m.name)) answer(m).catch((e) => { botError = e.message; });
  for (const m of groupAsks) if (claim(m.name)) answerGroup(m).catch((e) => { botError = e.message; });
  await checkOwners().catch(() => {});
}

// ---------- Error Monitor bot ----------
let botError = null;
const issueOf = (key) => {
  const samples = Object.values(state.alerts).filter((a) => issueKey(a) === key).sort((x, y) => y.ts - x.ts);
  return { samples, issue: samples.length ? summarize(samples, {}, {}, {}, state.teams).issues[0] : null };
};

// Membership is checked per group: someone found in one group may not be in another, and then a tag can't reach them.
const MEMBER_TTL = 60 * 60_000;
async function memberIn(space, email) {
  const k = `${space}|${email}`, c = state.members[k];
  if (c && Date.now() - c.at < MEMBER_TTL) return c.id;
  try { state.members[k] = { id: (await getMember(space, email))?.name || null, at: Date.now() }; } catch { return c?.id || null; }
  return state.members[k].id;
}

/** Hourly: is every owner in every group the bot posts in? Feeds the dashboard warning. */
async function checkOwners() {
  for (const space of BOT_SPACES) for (const t of state.teams) for (const o of owners(t)) if (o.email) await memberIn(space, o.email);
}

const missingOwners = () => BOT_SPACES.flatMap((space) => state.teams.flatMap((t) => owners(t)
  .filter((o) => o.email && state.members[`${space}|${o.email}`]?.id === null)
  .map((o) => ({ name: o.name, team: t.team, group: state.spaceNames[space] || space }))));

async function mentions(space, owner) {
  const out = [];
  for (const o of owners(owner)) {
    const id = o.email ? await memberIn(space, o.email) : null;
    out.push({ id, text: id ? `<${id}>` : `@${o.name}` }); // not in this group: plain name, Google can't notify them
  }
  return out;
}

/** true the first time a message is seen: events and polling both see @mentions. */
const claim = (name) => !state.handled[name] && (state.handled[name] = Date.now());

const ours = (msg) => { state.ours[msg.name] = Date.now(); if (msg.sender?.name) state.botUser = msg.sender.name; };

/** DM each tagged person a link to the message. Skipped for people who haven't added Error Monitor in a DM. */
async function dmTagged(userIds, msgName, space, from, snippet) {
  const group = state.spaceNames[space] || space, link = messageLink(msgName), short = snippet.replace(/\s+/g, ' ').slice(0, 200);
  const text = `🔔 *${from}* tagged you in *${group}*\n"${short}"\n${link}`;
  for (const id of new Set(userIds)) {
    (state.notified[id] ??= []).push({ at: Date.now(), group, from, snippet: short, link }); // so they can ask the bot for their tags later
    state.notified[id] = state.notified[id].slice(-100);
    await sendDm(id, text).catch((e) => { botError = e.message; });
  }
  save();
}

/** First alert of an issue today: post owner, reason and team in its thread. */
async function announce({ a, thread }) {
  const key = issueKey(a), today = new Date().toDateString();
  if (Object.values(state.posts).some((p) => p.key === key && new Date(p.at).toDateString() === today)) return;
  const { issue } = issueOf(key);
  const tagged = await mentions(a.space, issue.owner);
  const msg = await postInThread(thread, announcement(issue, tagged.map((t) => t.text).join(' ')));
  ours(msg);
  state.posts[thread] = { key, space: a.space, at: Date.now(), team: issue.owner.team, person: issue.owner.person, replies: [] };
  botError = null;
  save();
  await dmTagged(tagged.map((t) => t.id).filter(Boolean), msg.name, a.space, BOT_NAME, `${issue.module}: ${issue.why}`);
}

/** Someone tagged teammates in a group the bot is in: DM each of them a link. */
async function tagged(m) {
  const space = m.name.split('/')[1];
  const ids = m.annotations.map((x) => x.userMention?.user).filter((u) => u?.type === 'HUMAN' && u.name !== m.sender?.name).map((u) => u.name);
  if (!ids.length) return;
  const from = m.sender?.displayName || (await getMember(space, m.sender.name.split('/')[1]).catch(() => null))?.displayName || 'Someone';
  await dmTagged(ids, m.name, space, from, m.text);
}

/** A person replied in a thread the bot posted in: fix prompt, team message, or an answer to their question. */
async function answer(m) {
  const want = replyIntent(m.text, BOT_NAME);
  if (!want) return;
  const post = state.posts[m.thread.name];
  const { issue, samples } = issueOf(post.key);
  const text = !issue ? `I no longer have the alerts for this issue (kept ${KEEP_DAYS} days).`
    : await solveIssue(issue, samples.slice(0, 3), REPO_DIRS, want.mode, want.q.slice(0, 1000))
      .then((r) => r.text, (e) => `Sorry, I couldn't answer: ${e.message}`);
  ours(await postInThread(m.thread.name, text));
  post.replies.push({ at: Date.now(), by: m.sender?.displayName || '', mode: want.mode, q: want.q.slice(0, 300), text });
  save();
}

/** @mention straight in the group: answer from today's report for that group. */
async function answerGroup(m) {
  const space = m.name.split('/')[1], tz = new Date().getTimezoneOffset();
  const today = new Date(Date.now() - tz * 60_000).toISOString().slice(0, 10);
  const s = summarize(Object.values(state.alerts).filter((a) => a.space === space), { date: today, tz }, state.spaceNames, {}, state.teams);
  const q = stripBot(m.text, BOT_NAME).slice(0, 1000);
  const text = await askGroup(q || "Give me a report of today's errors", report(s, `${state.spaceNames[space] || space}, today (${today})`), REPO_DIRS)
    .catch((e) => `Sorry, I couldn't answer: ${e.message}`);
  ours(await postInThread(m.thread.name, text));
  save();
}

/** A DM to the bot: answer from the person's tags and today's errors in every group. */
async function answerDm(m, user, space) {
  const tz = new Date().getTimezoneOffset(), today = new Date(Date.now() - tz * 60_000).toISOString().slice(0, 10);
  const when = (ts) => new Date(ts).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
  const tags = (state.notified[user?.name] || []).slice().reverse();
  const data = [
    `Times ${user?.displayName || 'this person'} was tagged (newest first, last ${KEEP_DAYS} days):`,
    ...(tags.length ? tags.map((t) => `- ${when(t.at)} in ${t.group} by ${t.from}: "${t.snippet}" ${t.link}`) : ['- none recorded']),
    '',
    report(summarize(Object.values(state.alerts), { date: today, tz }, state.spaceNames, {}, state.teams), `All monitored groups, today (${today})`),
  ].join('\n');
  const q = (m.argumentText || m.text || '').trim().slice(0, 1000) || 'Hello';
  const text = await askGroup(q, data, REPO_DIRS, 'dm').catch((e) => `Sorry, I couldn't answer: ${e.message}`);
  await postIn(space.name, text);
}

/** One Chat event from Pub/Sub: say hello on install, answer DMs, answer @mentions in bot groups right away. */
async function onEvent(raw) {
  const { type, message: m, space, user, dm } = readEvent(raw);
  if (type === 'ADDED_TO_SPACE' && dm) {
    return postIn(space.name, `Hi ${user?.displayName || ''}! I'm ${BOT_NAME}. I DM you a link whenever you're tagged in an error group I'm in.\nAsk me things like "links of the errors I'm tagged in" or "what broke today?".`);
  }
  if (type !== 'MESSAGE' || !m?.name) return;
  if (Date.now() - Date.parse(m.createTime || raw.eventTime) > 15 * 60_000) return; // queued from before the bot listened
  if (!claim(m.name)) return;
  if (dm) {
    await postIn(space.name, 'Looking into it, one moment…');
    return answerDm(m, user, space);
  }
  const id = space?.name?.split('/')[1];
  if (!BOT_SPACES.includes(id)) return; // other groups: the bot stays quiet until it's switched on there
  await postInThread(m.thread.name, 'Looking into it, I\'ll answer here in a minute or two.').then(ours);
  return state.posts[m.thread?.name] ? answer(m) : answerGroup(m);
}

let pubsubOk = null;
async function pullLoop() {
  for (;;) {
    try {
      const events = await pullEvents(PUBSUB_SUBSCRIPTION);
      pubsubOk = true;
      for (const ev of events) onEvent(ev).catch((e) => { botError = e.message; });
      if (!events.length) await new Promise((r) => setTimeout(r, 2000));
    } catch (e) {
      pubsubOk = false; botError = e.message;
      await new Promise((r) => setTimeout(r, 30_000)); // e.g. missing Subscriber role: retry slowly
    }
  }
}

function sync() {
  if (!isConnected()) return Promise.resolve();
  syncing ??= syncOnce().finally(() => { syncing = null; });
  return syncing;
}

// ---------- Claude fixes, cached per issue ----------
const solving = new Map();

function solve(key, force) {
  if (!force && state.solutions[key]) return Promise.resolve(state.solutions[key]);
  if (solving.has(key)) return solving.get(key);
  const samples = Object.values(state.alerts).filter((a) => issueKey(a) === key);
  if (!samples.length) return Promise.reject(Object.assign(new Error('That issue is no longer in the data.'), { status: 404 }));
  const [issue] = summarize(samples).issues;
  const job = solveIssue(issue, samples.sort((x, y) => y.ts - x.ts).slice(0, 3), REPO_DIRS)
    .then((r) => { state.solutions[key] = r; save(); return r; })
    .finally(() => solving.delete(key));
  solving.set(key, job);
  return job;
}

// ---------- HTTP ----------
function authorized(req) {
  if (!env.DASH_PASSWORD) return true;
  const b64 = (req.headers.authorization || '').replace(/^Basic\s+/i, '');
  const given = Buffer.from(Buffer.from(b64, 'base64').toString().split(':').slice(1).join(':'));
  const want = Buffer.from(env.DASH_PASSWORD);
  return given.length === want.length && timingSafeEqual(given, want);
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) { body += chunk; if (body.length > 100_000) throw Object.assign(new Error('Request too large'), { status: 413 }); }
  try { return JSON.parse(body || '{}'); } catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
}

const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
};

createServer(async (req, res) => {
  if (!authorized(req)) { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Error Monitor"' }); return res.end(); }
  const url = new URL(req.url, 'http://localhost');
  const route = `${req.method} ${url.pathname}`;
  // JSON-only POSTs: a cross-site form can't send this content type, so other sites can't trigger syncs or paid Claude calls.
  if (req.method === 'POST' && !String(req.headers['content-type']).startsWith('application/json')) return send(res, 415, { error: 'Use application/json' });
  try {
    switch (route) {
      case 'GET /':
        return send(res, 200, await readFile(new URL('./public/index.html', import.meta.url)), 'text/html; charset=utf-8');
      case 'GET /auth/google':
        res.writeHead(302, { Location: authUrl() });
        return res.end();
      case 'GET /auth/google/callback':
        if (url.searchParams.get('error')) throw new Error('Google sign-in was cancelled.');
        await finishAuth(url.searchParams.get('code'), url.searchParams.get('state'));
        sync().catch(() => {});
        res.writeHead(302, { Location: '/' });
        return res.end();
      case 'GET /api/status':
        return send(res, 200, {
          connected: isConnected(), syncing: Boolean(syncing), lastSync: state.lastSync,
          alerts: Object.keys(state.alerts).length, claude: env.ANTHROPIC_API_KEY ? 'api' : 'local login', repoDirs: REPO_DIRS.length,
          spaces: SPACES.map((id) => ({ id, name: state.spaceNames[id] || id, error: spaceErrors[id] || null })),
          bot: { spaces: BOT_SPACES.map((id) => state.spaceNames[id] || id), error: botError, missing: missingOwners(), events: PUBSUB_SUBSCRIPTION ? pubsubOk : 'off' },
        });
      case 'GET /api/summary': {
        const q = Object.fromEntries(url.searchParams);
        return send(res, 200, summarize(Object.values(state.alerts), { ...q, tz: Number(q.tz) || 0 }, state.spaceNames, state.solutions, state.teams, state.posts));
      }
      case 'POST /api/sync':
        await sync();
        return send(res, 200, { ok: true });
      case 'POST /api/solve': {
        const { key, force } = await readJson(req);
        if (typeof key !== 'string') return send(res, 400, { error: 'key is required' });
        return send(res, 200, await solve(key, Boolean(force)));
      }
      case 'GET /api/teams':
        return send(res, 200, state.teams);
      case 'POST /api/teams': {
        const { teams } = await readJson(req);
        const str = (v) => (typeof v === 'string' ? v.trim().slice(0, 300) : '');
        if (!Array.isArray(teams) || teams.length > 300) return send(res, 400, { error: 'teams must be a list' });
        const clean = teams.map((t) => ({ team: str(t?.team), person: str(t?.person), email: str(t?.email).toLowerCase(), match: str(t?.match) }))
          .filter((t) => t.team);
        const badEmail = clean.flatMap((t) => owners(t).map((o) => o.email)).find((e) => e && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
        if (badEmail) return send(res, 400, { error: `Not an email: ${badEmail}` });
        state.teams = clean;
        save();
        return send(res, 200, state.teams);
      }
      default:
        return send(res, 404, { error: 'Not found' });
    }
  } catch (e) {
    if (url.pathname.startsWith('/auth')) return send(res, 400, `${e.message}\n\nGo back to the dashboard: /`, 'text/plain; charset=utf-8');
    send(res, e.status || 500, { error: e.message });
  }
}).listen(PORT, HOST, () => {
  console.log(`Error Monitor on http://${HOST}:${PORT} · ${SPACES.length} group(s) · sync every ${SYNC_MS / 60_000} min · bot ${BOT_SPACES.length ? 'posts in ' + BOT_SPACES.join(', ') : 'off'}`);
  sync().catch(() => {});
  setInterval(() => sync().catch(() => {}), SYNC_MS);
  if (PUBSUB_SUBSCRIPTION) pullLoop();
});
