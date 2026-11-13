import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// shortcut: whole state in one JSON file, rewritten on each save; move to SQLite if alerts pass ~50k.
const DIR = fileURLToPath(new URL('../data/', import.meta.url));
const FILE = DIR + 'state.json';

function load() {
  try {
    return JSON.parse(readFileSync(FILE, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`Can't read ${FILE} (${e.message}). Fix or move it; refusing to start empty and overwrite it.`);
    return { alerts: {}, cursors: {}, spaceNames: {}, solutions: {}, google: null, lastSync: null };
  }
}

export const state = load();

export function save() {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(FILE + '.tmp', JSON.stringify(state));
  renameSync(FILE + '.tmp', FILE); // atomic replace, so a crash mid-write can't corrupt the file
}
