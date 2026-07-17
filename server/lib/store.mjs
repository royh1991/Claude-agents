import fs from 'node:fs';
import path from 'node:path';
import { newEventId } from './ids.mjs';

const DATA_DIR = process.env.GANTRY_DATA_DIR
  || path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'data');

const COLLECTIONS = [
  'agents',            // current agent objects
  'agent_versions',    // every historical version
  'environments',
  'sessions',
  'deployments',
  'deployment_runs',
  'provider_keys',
];

export class Store {
  constructor(dataDir = DATA_DIR) {
    this.dataDir = dataDir;
    this.eventsDir = path.join(dataDir, 'events');
    fs.mkdirSync(this.eventsDir, { recursive: true });
    this.cache = {};
    for (const name of COLLECTIONS) this.cache[name] = this.#load(name);
    this.subscribers = new Map(); // sessionId -> Set<fn>
  }

  #file(name) {
    return path.join(this.dataDir, `${name}.json`);
  }

  #load(name) {
    const file = this.#file(name);
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      // Only a missing file means empty. Anything else (corrupt JSON, bad
      // permissions) must fail fast — returning [] here would let the next
      // save() permanently overwrite a recoverable file.
      if (err.code === 'ENOENT') return [];
      throw new Error(`failed to load ${file}: ${err.message} — fix or remove the file to start`);
    }
  }

  save(name) {
    const file = this.#file(name);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.cache[name], null, 2));
    fs.renameSync(tmp, file);
  }

  all(name) {
    return this.cache[name];
  }

  find(name, id) {
    return this.cache[name].find((item) => item.id === id) ?? null;
  }

  insert(name, item) {
    this.cache[name].push(item);
    this.save(name);
    return item;
  }

  update(name, id, patch) {
    const item = this.find(name, id);
    if (!item) return null;
    Object.assign(item, patch);
    this.save(name);
    return item;
  }

  remove(name, id) {
    const before = this.cache[name].length;
    this.cache[name] = this.cache[name].filter((item) => item.id !== id);
    if (this.cache[name].length !== before) this.save(name);
    return this.cache[name].length !== before;
  }

  isEmpty() {
    return COLLECTIONS.every((name) => this.cache[name].length === 0);
  }

  // ---- Events: append-only JSONL per session ----

  #eventsFile(sessionId) {
    return path.join(this.eventsDir, `${sessionId}.jsonl`);
  }

  appendEvent(sessionId, event) {
    const full = {
      id: newEventId(),
      created_at: new Date().toISOString(),
      ...event,
    };
    fs.appendFileSync(this.#eventsFile(sessionId), `${JSON.stringify(full)}\n`);
    const subs = this.subscribers.get(sessionId);
    if (subs) for (const fn of subs) fn(full);
    return full;
  }

  readEvents(sessionId) {
    let raw;
    try {
      raw = fs.readFileSync(this.#eventsFile(sessionId), 'utf8');
    } catch {
      return [];
    }
    const events = [];
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        // One truncated line (e.g. a crash mid-append) must not hide the
        // rest of the log.
        console.warn(`[gantry] skipping corrupt event line in ${sessionId}`);
      }
    }
    return events;
  }

  subscribe(sessionId, fn) {
    if (!this.subscribers.has(sessionId)) this.subscribers.set(sessionId, new Set());
    this.subscribers.get(sessionId).add(fn);
    return () => {
      const subs = this.subscribers.get(sessionId);
      if (subs) {
        subs.delete(fn);
        if (subs.size === 0) this.subscribers.delete(sessionId);
      }
    };
  }
}
