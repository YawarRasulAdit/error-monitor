import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moduleTeam, owner, summarize, parseMessage, report } from '../src/alerts.js';
import { replyIntent, announcement, owners, messageLink, chatText } from '../src/bot.js';

const alert = (module, actual) => parseMessage(`04-11-2026 06:23 AM [${module}] [ERROR]\nError Alert: Svc.run\nFunction: run\nActual Behavior: ${actual}`, { id: module + actual });

test('team names are made up when no rule matches', () => {
  assert.equal(moduleTeam('ADIT SETTING API'), 'Setting issue');
  assert.equal(moduleTeam('TREATMENT PLAN API'), 'Treatment Plan issue');
  assert.equal(moduleTeam('Unknown module'), 'Unassigned issue');
  const [ehr] = summarize([alert('TREATMENT PLAN API', 'EHR request timed out after 10000ms')]).issues;
  assert.deepEqual(ehr.owner, { team: 'EHR issue', person: '', email: '', auto: true });
  const [setting] = summarize([alert('ADIT SETTING API', "Cannot read properties of undefined (reading 'x')")]).issues;
  assert.equal(setting.owner.team, 'Setting issue');
});

test('portal team rules win, first match first, keywords are case-insensitive', () => {
  const teams = [
    { team: 'Tx Plan', person: 'Ravi', email: 'ravi@adit.com', match: 'treatment plan, pdf' },
    { team: 'EHR', person: 'Asha', email: '', match: 'EHR timeout' },
  ];
  const [i] = summarize([alert('TREATMENT PLAN API', 'EHR request timed out')], {}, {}, {}, teams).issues;
  assert.equal(i.owner.team, 'Tx Plan');
  assert.equal(owner({ ...i, module: 'FORMS API', title: 'x', actual: 'x' }, teams).team, 'EHR'); // matched on label "EHR timeout"
  assert.equal(owner({ ...i, module: 'FORMS API', title: 'x', actual: 'x', label: 'Code bug' }, teams).auto, true);
});

test('thread replies: fix / reply / @mention question / ignore chatter', () => {
  assert.deepEqual(replyIntent('@Error Monitor fix', 'Error Monitor'), { mode: 'fix', q: 'fix' });
  assert.equal(replyIntent('Fix please', 'Error Monitor').mode, 'fix');
  assert.equal(replyIntent('reply for support', 'Error Monitor').mode, 'reply');
  assert.deepEqual(replyIntent('@Error Monitor is this only one clinic?', 'Error Monitor'), { mode: 'ask', q: 'is this only one clinic?' });
  assert.equal(replyIntent('looking into it', 'Error Monitor'), null);
  assert.equal(replyIntent('the fix is deployed', 'Error Monitor'), null);
});

test('announcement follows the agreed format', () => {
  const [i] = summarize([alert('TREATMENT PLAN API', 'EHR request timed out')], {}, {}, {}, [{ team: 'Tx Plan', match: 'treatment' }]).issues;
  const lines = announcement(i, '<users/123>').split('\n');
  assert.match(lines[0], /^<users\/123> The practice's EHR bridge didn't answer in time while running run\.$/);
  assert.equal(lines[1], '*Responsible Team:* Tx Plan');
  assert.match(lines[2], /^\*Request a Fix or Reply:\*/);
});

test('several owners per team pair names and emails by position', () => {
  assert.deepEqual(owners({ person: 'Prity Purbey, Kruti Patel', email: 'prity@adit.com, kruti@adit.com' }),
    [{ name: 'Prity Purbey', email: 'prity@adit.com' }, { name: 'Kruti Patel', email: 'kruti@adit.com' }]);
  assert.deepEqual(owners({ person: 'Asha', email: '' }), [{ name: 'Asha', email: '' }]);
  assert.deepEqual(owners({}), []);
});

test('message links point at the thread and message', () => {
  assert.equal(messageLink('spaces/AAQA2fFVOHQ/messages/ekTlrNZmVG8.ekTlrNZmVG8'), 'https://chat.google.com/room/AAQA2fFVOHQ/ekTlrNZmVG8/ekTlrNZmVG8');
  assert.equal(messageLink('spaces/S/messages/T1.M2'), 'https://chat.google.com/room/S/T1/M2');
});

test('chat text: single line breaks doubled, code blocks and blank lines kept', () => {
  assert.equal(chatText('a\nb\n\nc'), 'a\n\nb\n\nc');
  assert.equal(chatText('Fix:\n```\nline1\nline2\n```\nend'), 'Fix:\n\n```\nline1\nline2\n```\n\nend');
});

test('group report lists totals and each issue with its team', () => {
  const s = summarize([alert('TREATMENT PLAN API', 'EHR request timed out'), alert('TREATMENT PLAN API', 'EHR request timed out after 5'), alert('ADIT SETTING API', 'x is not a function')],
    {}, {}, {}, [{ team: 'Tx Plan', person: 'Yawar Rasul', match: 'treatment' }]);
  const r = report(s, 'Error Moniter, today').split('\n');
  assert.equal(r[0], 'Error Moniter, today: 3 alerts, 3 distinct issues, 0 clients affected.');
  assert.match(r.find((l) => l.includes('SETTING')), /type: Code bug \| team: Setting issue/);
  assert.match(r.find((l) => l.includes('TREATMENT')), /team: Tx Plan \(Yawar Rasul\)/);
});

test('reads classic and add-on shaped Chat events', async () => {
  const { readEvent } = await import('../src/bot.js');
  const classic = readEvent({ type: 'MESSAGE', message: { name: 'spaces/D/messages/1', text: 'hi' }, space: { name: 'spaces/D', type: 'DM' }, user: { name: 'users/1' } });
  assert.deepEqual([classic.type, classic.dm, classic.user.name, classic.message.text], ['MESSAGE', true, 'users/1', 'hi']);
  const addon = readEvent({ chat: { user: { name: 'users/2' }, messagePayload: { space: { name: 'spaces/G', spaceType: 'SPACE' }, message: { name: 'spaces/G/messages/2', text: '@Error Monitor hi' } } } });
  assert.deepEqual([addon.type, addon.dm, addon.user.name, addon.space.name], ['MESSAGE', false, 'users/2', 'spaces/G']);
  assert.equal(readEvent({ chat: { addedToSpacePayload: { space: { name: 'spaces/D', spaceType: 'DIRECT_MESSAGE' } } } }).type, 'ADDED_TO_SPACE');
});
