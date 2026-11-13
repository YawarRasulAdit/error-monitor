// Reads Google Chat as the signed-in user (OAuth), so it sees every group that user is a member of.
import { randomBytes } from 'node:crypto';
import { state, save } from './store.js';

const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI } = process.env;
// memberships.readonly: turns a teammate's email into their Chat user ID so the bot can @mention them.
const SCOPES = ['chat.spaces.readonly', 'chat.messages.readonly', 'chat.memberships.readonly']
  .map((s) => `https://www.googleapis.com/auth/${s}`).join(' ');
const pending = new Set(); // OAuth state values, to reject forged callbacks
let access = null;

export const isConnected = () => Boolean(state.google?.refresh_token);

export function authUrl() {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_REDIRECT_URI) throw new Error('Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI in .env first.');
  const s = randomBytes(16).toString('hex');
  pending.add(s);
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID, redirect_uri: GOOGLE_REDIRECT_URI, response_type: 'code',
    scope: SCOPES, access_type: 'offline', prompt: 'consent', state: s,
  });
}

async function tokenRequest(params) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({ client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET, ...params }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(`Google sign-in failed: ${body.error_description || body.error || res.status}`), { code: body.error });
  access = { token: body.access_token, exp: Date.now() + (body.expires_in - 60) * 1000 };
  return body;
}

export async function finishAuth(code, s) {
  if (!pending.delete(s)) throw new Error('This sign-in link expired. Start again from the dashboard.');
  const body = await tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: GOOGLE_REDIRECT_URI });
  state.google = { refresh_token: body.refresh_token };
  save();
}

async function token() {
  if (access && Date.now() < access.exp) return access.token;
  if (!isConnected()) throw new Error('Google is not connected. Click "Connect Google" on the dashboard.');
  try {
    await tokenRequest({ refresh_token: state.google.refresh_token, grant_type: 'refresh_token' });
  } catch (e) {
    if (e.code === 'invalid_grant') { state.google = null; save(); } // revoked or expired: show "Connect Google" again
    throw e;
  }
  return access.token;
}

async function chat(path, params = {}) {
  const res = await fetch(`https://chat.googleapis.com/v1/${path}?${new URLSearchParams(params)}`, {
    headers: { Authorization: `Bearer ${await token()}` },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google Chat ${res.status}: ${body.error?.message || res.statusText}`);
  return body;
}

export const getSpace = (id) => chat(`spaces/${encodeURIComponent(id)}`);

/** A member of the space ({name: "users/123", displayName, email}) by email or user ID; undefined if not a member. */
export const getMember = async (space, who) =>
  (await chat(`spaces/${encodeURIComponent(space)}/members/${encodeURIComponent(who)}`)).member;

/** All messages in a space created after sinceIso, oldest first. */
export async function listMessages(id, sinceIso) {
  const out = [];
  let pageToken;
  do {
    const body = await chat(`spaces/${encodeURIComponent(id)}/messages`, {
      pageSize: 1000, filter: `createTime > "${sinceIso}"`, ...(pageToken && { pageToken }),
    });
    out.push(...(body.messages || []));
    pageToken = body.nextPageToken;
  } while (pageToken);
  return out;
}
