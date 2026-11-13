// "Ask Claude for a fix": sends one issue's sample alerts plus the failing function's source to Claude.
import Anthropic from '@anthropic-ai/sdk';
import { readdir, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

const client = new Anthropic();
const SKIP = new Set(['node_modules', 'dist', 'build', 'coverage', 'www', 'tmp']);

async function* walk(dir) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP.has(e.name) && !e.name.startsWith('.')) yield* walk(p); }
    else if (/\.(ts|js|mjs)$/.test(e.name) && !/\.(d|spec|test)\.[mt]?[jt]s$/.test(e.name)) yield p;
  }
}

/** Where `fn` is defined (method, function or arrow property) in the repos, with ~80 lines of body. */
export async function findCode(fn, dirs, max = 3) {
  if (!/^[A-Za-z_$][\w$]*$/.test(fn || '')) return [];
  const def = new RegExp(`^[ \\t]*(?:(?:export|public|private|protected|static|async|function|override|readonly)\\s+)*${fn.replace(/\$/g, '\\$')}\\s*(?:[(<]|=\\s*(?:async\\s*)?\\()`, 'm');
  const files = [];
  for (const dir of dirs) for await (const f of walk(dir)) files.push(f);
  const hits = [];
  for (let i = 0; i < files.length && hits.length < max; i += 64) { // parallel batches: one-by-one reads take ~1 min on Windows
    const batch = await Promise.all(files.slice(i, i + 64).map(async (file) => {
      const src = await readFile(file, 'utf8').catch(() => '');
      const m = src.includes(fn) && def.exec(src);
      if (!m) return null;
      const at = src.slice(0, m.index).split('\n').length - 1;
      return { file, line: at + 1, code: src.split('\n').slice(Math.max(0, at - 5), at + 80).join('\n') };
    }));
    hits.push(...batch.filter(Boolean));
  }
  return hits.slice(0, max);
}

const INTRO = `You diagnose production errors for Adit, a dental practice management platform (NestJS APIs, Angular front-ends, MSSQL, Couchbase, Elasticsearch, EHR integrations).
You get one recurring error from the team's Google Chat alert groups: how often it happened, sample alerts, and the source of the failing function when it was found.`;

const CHAT = 'Use Google Chat formatting: *bold* with single asterisks, `code`, ``` blocks; no headings or tables.';
const MODES = {
  full: `Reply in Markdown with these sections:
**Root cause**: what is going wrong and why, in plain words.
**Evidence**: which details in the alerts or code point there.
**Fix**: the concrete change, with file path and a code snippet when the code is shown.
**Prevent it**: one or two follow-ups (test, guard, alert change).
Be direct and brief. If the information is not enough to be sure, say so and name exactly what to check next.`,
  fix: `Write a prompt, under 120 words, that a developer can paste into Claude Code inside the module's repo to fix this error. Name the file and function, the likely cause and the change to make, and ask for a test. Output only the prompt inside one code block. ${CHAT}`,
  reply: `Write a message, under 80 words, for the responsible team or support: what happened, who is affected, and what they need to do next. Plain words, no code. Output only the message. ${CHAT}`,
  ask: `A teammate asked a question about this error in the alert thread. Answer it in under 150 words. If the data can't tell, say what to check. ${CHAT}`,
};

/** mode: full (portal answer), fix (prompt for Claude Code), reply (message for the team), ask (answers `question`). */
export async function solveIssue(issue, samples, repoDirs, mode = 'full', question = '') {
  const code = await findCode(issue.fn, repoDirs);
  const content = [
    `Error: ${issue.module} · ${issue.title}`,
    `Occurrences: ${issue.count}, environments: ${issue.envs.join(', ')}, clients affected: ${issue.clients.length}`,
    `First seen ${new Date(issue.first).toISOString()}, last seen ${new Date(issue.last).toISOString()}`,
    `Rule-based guess: ${issue.label}`,
    '',
    'Sample alerts:',
    ...samples.map((a, i) => `--- alert ${i + 1} ---\n${a.raw}`),
    '',
    code.length ? 'Source of the failing function:' : 'The failing function was not found in the configured repos.',
    ...code.map((c) => `--- ${c.file}:${c.line} ---\n${c.code}`),
    ...(mode === 'ask' ? ['', `Question from the thread: ${question}`] : []),
  ].join('\n');
  const system = `${INTRO}\n${MODES[mode]}`;

  const text = process.env.ANTHROPIC_API_KEY ? await askApi(system, content) : await askCli(system, content, repoDirs);
  return { text, files: code.map((c) => `${c.file}:${c.line}`), at: Date.now() };
}

/** A question asked straight in the group (not about one alert), answered from the group's error report. */
export async function askGroup(question, reportText, repoDirs, where = 'group') {
  const who = where === 'dm'
    ? 'A teammate messaged you directly. The data below lists the times they were tagged (with links) and today\'s errors across the monitored groups. When they ask about their tags, list them with the links.'
    : 'A teammate @mentioned you in a Google Chat error group. Answer from the report below: totals first, then the issues that matter most and who owns them.';
  const system = `${INTRO.split('\n')[0]}
${who} Answer in under 200 words. If the data can't answer it, say what it does cover. ${CHAT}`;
  const content = `${reportText}\n\nQuestion: ${question}`;
  return process.env.ANTHROPIC_API_KEY ? askApi(system, content) : askCli(system, content, repoDirs);
}

/**
 * No API key: drive the local, logged-in Claude Code CLI (same approach as personal-dash).
 * Read-only tools inside REPO_DIRS only; web and shell are blocked because alert text is untrusted input.
 * The prompt goes in via stdin, never argv.
 */
function askCli(system, content, repoDirs, timeoutMs = 5 * 60_000) {
  const args = ['-p', '--output-format', 'json',
    '--allowedTools', 'Read', 'Grep', 'Glob',
    // Windows names its shell tool PowerShell; both must be listed or user-level allow rules (e.g. git) still run.
    '--disallowedTools', 'Bash', 'PowerShell', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch',
    ...repoDirs.flatMap((d) => ['--add-dir', d])];
  const prompt = `${system}\n\nYou can Read, Grep and Glob the repos in the added directories to check more code before answering. Reply with only the answer.\n\n${content}`;

  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { cwd: repoDirs[0] || process.cwd(), windowsHide: true, shell: process.platform === 'win32' });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Claude took longer than ${timeoutMs / 60_000} min. Try again.`)); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(e.code === 'ENOENT' ? 'The `claude` command is not on PATH. Install Claude Code and log in, or set ANTHROPIC_API_KEY.' : e.message));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      let r;
      try { r = JSON.parse(out); } catch { return reject(new Error(err.trim() || `Claude exited with code ${code}`)); }
      if (r.is_error || !r.result) return reject(new Error(r.result || err.trim() || 'Claude returned no answer. Run `claude` once in a terminal to check you are logged in.'));
      resolve(String(r.result).trim());
    });
    child.stdin.on('error', () => {}); // closed early; the close handler reports
    child.stdin.end(prompt, 'utf8');
  });
}

async function askApi(system, content) {
  let res;
  try {
    res = await client.beta.messages.create({
      model: 'claude-opus-5-5',
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default', // if the model declines, the API retries on a fallback model in the same call
      output_config: { effort: 'high' },
      system,
      messages: [{ role: 'user', content }],
    });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new Error('ANTHROPIC_API_KEY is missing or invalid.');
    if (e instanceof Anthropic.RateLimitError) throw new Error('Claude is rate limited right now. Try again in a minute.');
    if (e instanceof Anthropic.APIError) throw new Error(`Claude API error ${e.status}: ${e.message}`);
    throw e;
  }
  if (res.stop_reason === 'refusal') throw new Error('Claude declined to answer this one.');
  return res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
}
