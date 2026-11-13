// "Error Monitor" Chat app: posts in alert threads as the app (service account, chat.bot scope).
import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

let key = null, access = null;

async function token() {
  if (access && Date.now() < access.exp) return access.token;
  key ??= JSON.parse(readFileSync(process.env.BOT_KEY_FILE, 'utf8'));
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  // pubsub: read the Chat events (DMs, @mentions) Google drops on the app's subscription.
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iss: key.client_email, scope: 'https://www.googleapis.com/auth/chat.bot https://www.googleapis.com/auth/pubsub',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  })}`;
  const sig = createSign('RSA-SHA256').update(unsigned).sign(key.private_key, 'base64url');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${sig}` }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Bot sign-in failed: ${body.error_description || body.error || res.status}`);
  access = { token: body.access_token, exp: Date.now() + (body.expires_in - 60) * 1000 };
  return access.token;
}

async function call(method, path, body) {
  const res = await fetch(`https://chat.googleapis.com/v1/${path}`, {
    method, headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(`Bot ${method === 'GET' ? 'lookup' : 'post'} failed ${res.status}: ${out.error?.message || res.statusText}`), { status: res.status });
  return out;
}

/** Chat reads app text as Markdown, where one line break is a space: double them, except inside ``` blocks. */
export const chatText = (text) => text.slice(0, 4000).split(/(```[\s\S]*?```)/)
  .map((part) => (part.startsWith('```') ? part : part.replace(/\n+/g, (n) => (n.length === 1 ? '\n\n' : n)))).join('');

/** Reply inside an existing thread ("spaces/X/threads/Y"); Chat starts a new thread if that one can't take replies. */
export const postInThread = (thread, text) =>
  call('POST', `${thread.split('/threads/')[0]}/messages?messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD`,
    { text: chatText(text), thread: { name: thread } });

/** New top-level message in a space, e.g. a reply in a DM. */
export const postIn = (space, text) => call('POST', `${space}/messages`, { text: chatText(text) });

/** Chat events waiting on the Pub/Sub subscription. Acknowledged on receipt, so a crash can't replay them in a loop. */
export async function pullEvents(sub) {
  const ps = async (verb, body) => {
    const res = await fetch(`https://pubsub.googleapis.com/v1/${sub}:${verb}`, {
      method: 'POST', headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Pub/Sub ${verb} ${res.status}: ${out.error?.message || res.statusText}`);
    return out;
  };
  const got = (await ps('pull', { maxMessages: 20 })).receivedMessages || [];
  if (got.length) await ps('acknowledge', { ackIds: got.map((m) => m.ackId) });
  return got.map((m) => { try { return JSON.parse(Buffer.from(m.message.data, 'base64').toString('utf8')); } catch { return null; } }).filter(Boolean);
}

/** Classic Chat events and the newer Workspace add-on shape, as one {type, message, space, user}. */
export function readEvent(ev) {
  const p = ev.chat?.messagePayload || ev.chat?.addedToSpacePayload;
  const message = ev.message || p?.message;
  const space = ev.space || p?.space || message?.space;
  const type = ev.type || (ev.chat?.messagePayload ? 'MESSAGE' : ev.chat?.addedToSpacePayload ? 'ADDED_TO_SPACE' : '');
  const dm = Boolean(space && (space.type === 'DM' || space.spaceType === 'DIRECT_MESSAGE' || space.singleUserBotDm));
  return { type, message, space, user: ev.user || ev.chat?.user || message?.sender, dm };
}

const dms = new Map(); // "users/123" -> their DM space with the bot
/** DM a user ("users/123"). Returns null when they haven't added Error Monitor in a DM, since only then can it write to them. */
export async function sendDm(user, text) {
  if (!dms.has(user)) {
    try { dms.set(user, (await call('GET', `spaces:findDirectMessage?name=${encodeURIComponent(user)}`)).name); }
    catch (e) { if (e.status === 404) return null; throw e; }
  }
  return call('POST', `${dms.get(user)}/messages`, { text: chatText(text) });
}

/** Browser link to a message: "spaces/S/messages/T.M" -> chat.google.com/room/S/T/M (T = thread, M = message). */
export function messageLink(name) {
  const [, space, , id] = name.split('/');
  const [thread, msg = thread] = id.split('.');
  return `https://chat.google.com/room/${space}/${thread}/${msg}`;
}

/** "Prity Purbey, Kruti Patel" + "prity@x, kruti@x" -> [{name, email}], paired by position. */
export function owners({ person = '', email = '' }) {
  const split = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);
  const names = split(person), emails = split(email);
  return Array.from({ length: Math.max(names.length, emails.length) }, (_, i) => ({ name: names[i] || emails[i], email: emails[i] || '' }));
}

/** The bot's first message in an alert thread, in the format the team agreed on. */
export function announcement(issue, mention) {
  const reason = issue.why.split(/(?<=\.)\s/)[0];
  return [
    `${mention ? mention + ' ' : ''}${reason}`,
    `*Responsible Team:* ${issue.owner.team}`,
    `*Request a Fix or Reply:* reply in this thread with \`fix\` for a fix prompt, \`reply\` for a message to the team, or @mention me with a question.`,
  ].join('\n');
}

/** What a person's thread reply asks for: fix | reply | ask, or null when they're just talking to each other. */
const atBot = (botName) => new RegExp(`@${botName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'gi');
export const mentionsBot = (text, botName) => atBot(botName).test(text);
export const stripBot = (text, botName) => text.replace(atBot(botName), '').trim();

export function replyIntent(text, botName) {
  const mentioned = mentionsBot(text, botName);
  const q = stripBot(text, botName);
  if (/^fix\b/i.test(q)) return { mode: 'fix', q };
  if (/^reply\b/i.test(q)) return { mode: 'reply', q };
  return mentioned ? { mode: 'ask', q } : null;
}
