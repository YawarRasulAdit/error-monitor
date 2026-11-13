import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMessage, summarize, diagnose, issueKey } from '../src/alerts.js';
import { findCode } from '../src/solve.js';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Exactly what the webhook posts (bold markers included), from the TX Plan live group.
const ALERT = `*04-11-2026 06:23 AM [TREATMENT PLAN API] [ERROR]*

*🚨 Error Alert: TreatmentPlanService.fetchTreatmentCodesForLocation*

*🆔 Error ID:* 835bd4f5-3012-4041-aa65-328a65c69364
*📅 Timestamp:* 2026-11-04T06:23:10.943Z
*📍 Context:*
\t- Page: treatment-plan
\t- Component: TreatmentPlanService
\t- Feature: Planned treatments stored procedure
\t- Function: fetchTreatmentCodesForLocation

*👤 User Action:* System attempted to load planned treatment codes
*🔢 User ID:* -
*🪪 Session ID:* -

*📝 Input Payload Summary:*
\t- locationId: fe254e7b-0baf-4a5a-99ca-a9e309b34e84
\t- spName: PACV.Patient_Planned_Tx

*✅ Expected Behavior:* Stored procedure returns planned treatments for the location
*❌ Actual Behavior:* Failed with error: EHR call timeout after 10000ms
*🔗 Error Stack:* {"message":"EHR call timeout after 10000ms","fileName":"/app/dist/main.js","lineNumber":1,"columnNumber":404631}

*⚙️ System State:*
\t- Memory Usage: RSS: 222.8MB | Heap Used: 116.4MB
\t- Env: live

*📉 Severity:* ERROR
*👥 Customer Impact:* Planned codes missing from the picker; unplanned codes still load
*💬 Suggested Response:* Please try again later
`;

test('parses the logger-nest alert template', () => {
  const a = parseMessage(ALERT, { id: 'spaces/X/messages/1', space: 'X' });
  assert.equal(a.id, '835bd4f5-3012-4041-aa65-328a65c69364');
  assert.equal(a.module, 'TREATMENT PLAN API');
  assert.equal(a.title, 'TreatmentPlanService.fetchTreatmentCodesForLocation');
  assert.equal(a.fn, 'fetchTreatmentCodesForLocation');
  assert.equal(a.env, 'live');
  assert.equal(a.actual, 'EHR call timeout after 10000ms');
  assert.equal(a.ts, Date.parse('2026-11-04T06:23:10.943Z'));
  assert.deepEqual(a.payload, { locationId: 'fe254e7b-0baf-4a5a-99ca-a9e309b34e84', spName: 'PACV.Patient_Planned_Tx' });
  assert.equal(a.client, 'locationId: fe254e7b-0baf-4a5a-99ca-a9e309b34e84');
  assert.equal(diagnose(a).label, 'EHR timeout');
});

test('plain error logs without the template still count', () => {
  const a = parseMessage('*04-11-2026 07:00 AM [CATALOG API] [ERROR]*\nRequest failed with status code 503', { id: 'm2', createTime: '2026-11-04T07:00:00Z' });
  assert.equal(a.id, 'm2');
  assert.equal(a.module, 'CATALOG API');
  assert.equal(a.fn, '');
  assert.equal(a.ts, Date.parse('2026-11-04T07:00:00Z'));
  assert.equal(diagnose(a).label, 'Downstream 5xx');
});

test('groups repeats with different IDs/numbers into one issue and filters by local day', () => {
  const other = ALERT.replace('835bd4f5-3012-4041-aa65-328a65c69364', 'aaaaaaaa-3012-4041-aa65-328a65c69364')
    .replace('fe254e7b-0baf-4a5a-99ca-a9e309b34e84', '11111111-0baf-4a5a-99ca-a9e309b34e84')
    .replace(/10000ms/g, '15000ms').replace('2026-11-04T06:23:10.943Z', '2026-11-04T20:00:00.000Z');
  const bug = ALERT.replace('835bd4f5', 'bbbbbbbb').replace(/EHR call timeout after 10000ms/g, "Cannot read properties of undefined (reading 'procedures')");
  const alerts = [ALERT, other, bug].map((t, i) => parseMessage(t, { id: String(i), space: 'S1' }));
  assert.equal(issueKey(alerts[0]), issueKey(alerts[1]));

  const all = summarize(alerts, {}, { S1: 'TX Plan Live Errors' });
  assert.equal(all.total, 3);
  assert.equal(all.issues.length, 2);
  assert.equal(all.issues[0].count, 2);
  assert.equal(all.issues[0].clients.length, 2);
  assert.equal(all.issues[1].cat, 'code');
  assert.deepEqual(all.byGroup, [['TX Plan Live Errors', 3]]);

  // IST (UTC+5:30, offset -330): 20:00Z is 01:30 on Nov 5, so Nov 4 holds only the two 06:23Z alerts.
  const ist = summarize(alerts, { date: '2026-11-04', tz: -330 });
  assert.equal(ist.total, 2);
  assert.equal(ist.hours[11], 2); // 06:23Z = 11:53 IST
  assert.deepEqual(ist.options.dates, ['2026-11-05', '2026-11-04']);
});

test('findCode finds the method definition, not its callers', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'em-'));
  mkdirSync(path.join(dir, 'src'));
  mkdirSync(path.join(dir, 'node_modules'));
  writeFileSync(path.join(dir, 'src', 'caller.ts'), 'await this.svc.fetchTreatmentCodesForLocation(id);\n');
  writeFileSync(path.join(dir, 'node_modules', 'x.ts'), 'async fetchTreatmentCodesForLocation(id) {}\n');
  writeFileSync(path.join(dir, 'src', 'svc.ts'), 'class S {\n  async fetchTreatmentCodesForLocation(locationId: string) {\n    return 1;\n  }\n}\n');
  const hits = await findCode('fetchTreatmentCodesForLocation', [dir]);
  assert.equal(hits.length, 1);
  assert.equal(path.basename(hits[0].file), 'svc.ts');
  assert.equal(hits[0].line, 2);
  assert.deepEqual(await findCode('bad name(', [dir]), []);
});
