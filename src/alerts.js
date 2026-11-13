// Turns alerts posted to GChat by @adittech/logger-nest (buildErrorMessage) into grouped, diagnosed issues.

const HDR = /(\d{2})-(\d{2})-(\d{4})\s+(\d{1,2}):(\d{2})\s*([AP]M)\s*\[([^\]]+)\]\s*\[([A-Z]+)\]/;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

function field(body, label) {
  const m = body.match(new RegExp(label + ':[ \\t]*([^\\n]*)'));
  return m ? m[1].trim() : '';
}

/** One GChat message -> one alert. Messages without the alert template still count, with less detail. */
export function parseMessage(text, { id, space = '', createTime } = {}) {
  const t = String(text).replace(/\r/g, '').replace(/\*/g, '');
  const hdr = t.match(HDR);
  const body = hdr ? t.slice(hdr.index + hdr[0].length) : t;
  const isAlert = /Error Alert:/.test(body);

  const payload = {};
  const pm = body.match(/Input Payload Summary:([\s\S]*?)(?:\n[^\n]*Expected Behavior:|$)/);
  if (pm) for (const line of pm[1].split('\n')) {
    const x = line.match(/^\s*-\s*([^:]+):\s*(.*)$/);
    if (x) payload[x[1].trim()] = x[2].trim();
  }

  const title = isAlert
    ? body.match(/Error Alert:\s*([^\n]*)/)[1].trim()
    : (body.split('\n').map((s) => s.trim()).find(Boolean) || 'Empty message').slice(0, 120);
  let ts = Date.parse(field(body, 'Timestamp'));
  if (isNaN(ts)) ts = Date.parse(createTime);
  const clientKey = Object.keys(payload)
    .find((k) => /location|org|clinic|practice|account/i.test(k) && payload[k] && payload[k] !== '-');

  return {
    id: field(body, 'Error ID') || id,
    ts,
    space,
    title,
    payload,
    raw: t.slice(0, 2500),
    module: hdr ? hdr[7].trim() : 'Unknown module',
    env: (field(body, 'Env') || 'unknown').toLowerCase(),
    severity: field(body, 'Severity') || (hdr ? hdr[8] : ''),
    feature: isAlert ? field(body, 'Feature') : '',
    fn: isAlert ? field(body, 'Function') || title.split('.').pop() : '',
    actual: isAlert ? field(body, 'Actual Behavior').replace(/^Failed with error:\s*/i, '') : body.trim().slice(0, 500),
    stack: field(body, 'Error Stack'),
    impact: field(body, 'Customer Impact'),
    client: clientKey ? `${clientKey}: ${payload[clientKey]}` : '',
  };
}

const normalize = (s) => s.replace(UUID, '<id>').replace(/\b[0-9a-f]{24}\b/gi, '<id>')
  .replace(/"[^"]*"|'[^']*'/g, '"…"').replace(/\d+/g, 'N');

/** Same function failing with the same message (IDs and numbers ignored) = one issue. */
export const issueKey = (a) => `${a.module}|${a.title}|${normalize(a.actual)}`;

const who = (a) => a.fn || 'the failing code';

// First match wins. Keep the cheap, common causes here; Claude handles the rest on request.
const RULES = [
  { re: /ehr/i, and: /time ?out|timed out/i, cat: 'dep', label: 'EHR timeout', team: 'EHR issue',
    why: (a) => `The practice's EHR bridge didn't answer in time while running ${a.payload.spName || who(a)}. Usually the office server or bridge is offline or slow, or the query is heavy for that practice's data.`,
    fix: ['Look at the affected clients. One location points at that office; many at once points at the shared EHR gateway.',
      "One location: check that location's EHR connection and ask support to contact the office (server on, bridge running).",
      'Many locations at the same time: check EHR gateway health and latency in Grafana for that window.',
      'Always the same stored procedure: have the EHR team profile it, or raise the timeout for this call / show cached data instead of failing.'] },
  { re: /time ?out|timed out|ETIMEDOUT|ESOCKETTIMEDOUT/i, cat: 'dep', label: 'Timeout',
    why: (a) => `A downstream call made by ${who(a)} took longer than its time limit.`,
    fix: ['Find which service it calls and check its latency in Grafana at the alert times.',
      'If it clusters at certain hours it is load: add caching or move the work to a background job.',
      'Add a retry with backoff if the call is safe to repeat.'] },
  { re: /ECONNREFUSED|ENOTFOUND|ECONNRESET|EAI_AGAIN|socket hang up|getaddrinfo/i, cat: 'dep', label: 'Service unreachable', team: 'DevOps issue',
    why: (a) => `${who(a)} couldn't connect to a service it depends on: it was down, restarting, or the host name is wrong.`,
    fix: ['Check whether the target service was deploying or restarting at that time.',
      'Confirm the host/URL env variable is right for this environment.',
      'If it keeps happening, add a health check and a retry.'] },
  { re: /\b40[13]\b|unauthori[sz]ed|forbidden|jwt|invalid token|token expired/i, cat: 'auth', label: 'Auth or session', team: 'Auth issue',
    why: (a) => `The request in ${who(a)} was rejected for missing, expired or insufficient credentials.`,
    fix: ['Check whether the user session or service token had expired.',
      'Service-to-service call: confirm the API key/secret for this environment.',
      'If users hit it often, refresh the token in the front-end before it expires.'] },
  { re: /Cannot read propert|of undefined|of null|is not a function|is not defined|is not iterable|undefined is not/i, cat: 'code', label: 'Code bug',
    why: (a) => `${who(a)} used a value that was missing (null/undefined). The code assumes data that isn't always there, so this is a bug in our code.`,
    fix: ['Open the function and find the property named in the error.',
      'Reproduce it with the IDs from the example payload.',
      'Add a guard or default for the missing value, plus a test for that case.',
      'Check upstream: if that data should never be empty, fix where it is created.'] },
  { re: /status code 5\d\d|\b50[0234]\b|Service Unavailable|Bad Gateway|Internal Server Error/i, cat: 'dep', label: 'Downstream 5xx',
    why: (a) => `A service called by ${who(a)} returned a server error.`,
    fix: ["Look up that service's own error logs at the alert time; the real cause is there.",
      'If it was deploying this stops by itself; otherwise raise it with the owner.'] },
  { re: /status code 404|not found|DocumentNotFound|does not exist/i, cat: 'input', label: 'Record not found',
    why: (a) => `${who(a)} looked up a record that doesn't exist: wrong or stale ID, or data deleted elsewhere.`,
    fix: ['Check the IDs in the payload against the database.',
      'If the record can legitimately be missing, treat it as "no data" instead of an error.'] },
  { re: /status code 4(00|22)|validation|is required|invalid|must be|Bad Request/i, cat: 'input', label: 'Bad request data',
    why: (a) => `The data sent to ${who(a)} failed validation.`,
    fix: ['Compare the payload with what the API expects.',
      'Fix the screen or job that sends it, and validate earlier so the user sees a clear message.'] },
  { re: /RequestError|ConnectionError|deadlock|Invalid object name|stored procedure|mssql|\bSQL\b/i, cat: 'dep', label: 'Database error', team: 'DB connection issue',
    why: (a) => `A SQL query or stored procedure used by ${who(a)} failed.`,
    fix: ['Run the same procedure with the payload values against that environment.',
      'Deadlock: look for jobs running at the same time. Missing object: check the migration was applied.'] },
  { re: /couchbase|CasMismatch|elasticsearch|index_not_found|search_phase/i, cat: 'dep', label: 'Datastore error', team: 'DB connection issue',
    why: (a) => `Couchbase or Elasticsearch rejected a call from ${who(a)}.`,
    fix: ['Check cluster health in Grafana at that time.',
      'index_not_found: check the index name for this environment. CAS mismatch: retry the write.'] },
  { re: /heap out of memory|ENOMEM|payload too large|\b413\b/i, cat: 'dep', label: 'Resource limit', team: 'DevOps issue',
    why: (a) => `${who(a)} hit a memory or size limit.`,
    fix: ['Check the memory figures in the alerts against the pod limits.',
      'Page or stream large results instead of loading them all at once.'] },
];
const FALLBACK = { cat: 'unknown', label: 'Needs a look',
  why: (a) => `No known pattern matched. Read the error and stack for ${who(a)}.`,
  fix: ['Reproduce it with the example payload.', 'Or ask Claude for a fix below.'] };

export function diagnose(a) {
  const s = `${a.actual} ${a.stack}`;
  return RULES.find((r) => r.re.test(s) && (!r.and || r.and.test(s))) || FALLBACK;
}

/** "ADIT SETTING API" -> "Setting issue": the team name used when no team rule matches. */
export const moduleTeam = (m = '') => {
  const w = m.replace(/\b(ADIT|APP|API|SERVICE|SVC|MS|NEST|SERVER|BACKEND)\b/gi, ' ').replace(/[\s_-]+/g, ' ').trim()
    .toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  return `${w && w !== 'Unknown Module' ? w : 'Unassigned'} issue`;
};

/**
 * Who owns an issue. teams = [{team, person, email, match: "kw1, kw2"}] from the portal; first match wins.
 * Keywords are matched against the module, error type, title, feature and message.
 */
export function owner(issue, teams = []) {
  const hay = `${issue.module} ${issue.label} ${issue.title} ${issue.feature} ${issue.actual}`.toLowerCase();
  const t = teams.find((t) => String(t.match || '').split(',').map((k) => k.trim().toLowerCase()).filter(Boolean).some((k) => hay.includes(k)));
  return t ? { team: t.team, person: t.person || '', email: t.email || '', auto: false }
    : { team: issue.autoTeam, person: '', email: '', auto: true };
}

/** Plain-text report of a summarize() result, for Claude to answer group questions from. */
export function report(s, title) {
  const t = (ts) => (isNaN(ts) ? 'unknown time' : new Date(ts).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }));
  return [
    `${title}: ${s.total} alerts, ${s.issues.length} distinct issues, ${s.clients} clients affected.`,
    ...s.issues.slice(0, 30).map((i, n) => `${n + 1}. ${i.count}× ${i.module} · ${i.title} — ${i.actual.slice(0, 160)} | type: ${i.label} | team: ${i.owner.team}`
      + `${i.owner.person ? ` (${i.owner.person})` : ''} | ${i.count > 1 ? `first ${t(i.first)}, last ${t(i.last)}` : `at ${t(i.last)}`} | env ${i.envs.join('/')} | ${i.clients.length} clients`),
    ...(s.issues.length > 30 ? [`…and ${s.issues.length - 30} more issues.`] : []),
  ].join('\n');
}

const countBy = (items, keyFn) => {
  const m = new Map();
  for (const it of items) { const k = keyFn(it); if (k) m.set(k, (m.get(k) || 0) + 1); }
  return [...m].sort((x, y) => y[1] - x[1]);
};
const uniq = (xs) => [...new Set(xs)];

/** Everything the dashboard shows for one filter. tz = browser getTimezoneOffset() in minutes. */
export function summarize(alerts, { date = 'all', env = 'all', space = 'all', module = 'all', tz = 0 } = {}, spaceNames = {}, solutions = {}, teams = [], posts = {}) {
  const local = (ts) => new Date(ts - tz * 60000);
  const day = (ts) => (isNaN(ts) ? 'unknown' : local(ts).toISOString().slice(0, 10));
  const options = {
    dates: uniq(alerts.map((a) => day(a.ts))).sort().reverse(),
    envs: uniq(alerts.map((a) => a.env)).sort(),
    spaces: uniq(alerts.map((a) => a.space)).map((id) => ({ id, name: spaceNames[id] || id })),
    modules: uniq(alerts.map((a) => a.module)).sort(),
  };
  const list = alerts.filter((a) => (date === 'all' || day(a.ts) === date) && (env === 'all' || a.env === env)
    && (space === 'all' || a.space === space) && (module === 'all' || a.module === module));

  const hours = Array(24).fill(0);
  for (const a of list) if (!isNaN(a.ts)) hours[local(a.ts).getUTCHours()]++;

  const groups = new Map();
  for (const a of list) {
    const k = issueKey(a);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(a);
  }
  const issues = [...groups].map(([key, items]) => {
    items.sort((x, y) => y.ts - x.ts);
    const a = items[0];
    const r = diagnose(a);
    const issue = {
      key, count: items.length, module: a.module, title: a.title, actual: a.actual, fn: a.fn, feature: a.feature,
      impact: a.impact, payload: a.payload, cat: r.cat, label: r.label, why: r.why(a), fix: r.fix,
      first: items.at(-1).ts, last: a.ts, envs: uniq(items.map((x) => x.env)),
      clients: countBy(items, (x) => x.client), bundled: /dist\/main\.js/.test(a.stack),
      ids: items.slice(0, 50).map((x) => ({ id: x.id, ts: x.ts })),
      solution: solutions[key] || null,
      autoTeam: r.team || moduleTeam(a.module),
      bot: Object.values(posts).filter((p) => p.key === key).sort((x, y) => y.at - x.at),
    };
    issue.owner = owner(issue, teams);
    return issue;
  }).sort((x, y) => y.count - x.count);

  return {
    total: list.length,
    clients: uniq(list.map((a) => a.client).filter(Boolean)).length,
    hours,
    byGroup: countBy(list, (a) => spaceNames[a.space] || a.space || 'Unknown group'),
    issues,
    options,
  };
}
