import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

// Research briefs only. This database grants no model, signing or trading authority.
export class ResearchStoreError extends Error {
  constructor(message, status = 422) { super(message); this.status = status; }
}
const fail = (message, status) => { throw new ResearchStoreError(message, status); };
const uuid = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
const text = (value, max, required = true) => {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u202a-\u202e\u2066-\u2069]/u.test(value)) fail('Check the name and research brief.');
  return value.trim();
};
export function validateBrief(input, allowed) {
  if (!input || typeof input !== 'object') fail('Add a research brief.');
  const name = text(input.name, 80), objective = text(input.objective, 4000);
  const budget = text(input.budget, 20);
  if (!/^(?:0|[1-9]\d{0,8})(?:\.\d{1,2})?$/.test(budget) || Number(budget) <= 0) fail('Enter a positive USD research budget.');
  const instruments = input.instruments;
  if (!Array.isArray(instruments) || instruments.length < 1 || instruments.length > 64 || new Set(instruments).size !== instruments.length || instruments.some(x => typeof x !== 'string' || !allowed.includes(x))) fail('Choose 1–64 supported stocks.');
  const weights = input.weights ?? [], cashBps = input.cashBps ?? null;
  if (!Array.isArray(weights) || weights.length > 64) fail('Check portfolio weights.');
  if (weights.length) {
    if (weights.length !== instruments.length || new Set(weights.map(x => x?.instrument)).size !== instruments.length || weights.some(x => !x || !instruments.includes(x.instrument) || !Number.isSafeInteger(x.weightBps) || x.weightBps <= 0 || x.weightBps > 10000) || !Number.isSafeInteger(cashBps) || cashBps < 0 || cashBps > 10000 || weights.reduce((n,x) => n + x.weightBps, cashBps) !== 10000) fail('Portfolio weights must total 100%.');
  } else if (cashBps !== null) fail('Set portfolio weights before setting a cash allocation.');
  // An optional agent binding. Ownership is checked when research runs; omitted when absent.
  if (input.agentId != null && !uuid(input.agentId)) fail('Choose one of your agents.');
  return { name, objective, budget, instruments: [...instruments], weights: weights.map(x => ({instrument:x.instrument,weightBps:x.weightBps})), cashBps, ...(input.agentId != null ? { agentId: input.agentId } : {}) };
}
export class ResearchStore {
  constructor(path, allowed) {
    this.allowed = allowed;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1500;
      CREATE TABLE IF NOT EXISTS research_strategies(owner TEXT NOT NULL,id TEXT PRIMARY KEY,revision INTEGER NOT NULL,document TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS research_owner ON research_strategies(owner,updated_at);
      CREATE TABLE IF NOT EXISTS research_requests(owner TEXT NOT NULL,request_id TEXT NOT NULL,digest TEXT NOT NULL,strategy_id TEXT NOT NULL,PRIMARY KEY(owner,request_id));
      CREATE TABLE IF NOT EXISTS research_events(cursor INTEGER PRIMARY KEY AUTOINCREMENT,owner TEXT NOT NULL,strategy_id TEXT NOT NULL,revision INTEGER NOT NULL,kind TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS research_event_owner ON research_events(owner,cursor);`);
  }
  close() { this.db.close(); }
  owner(address) {
    // Solana principals, or BNB Smart Chain principals (eip155:56:<checksummed address>, verified at sign-in).
    if (typeof address !== 'string' || !(/^solana:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address) || /^eip155:56:0x[0-9a-fA-F]{40}$/.test(address))) fail('Sign in with your wallet.', 401);
    return createHash('sha256').update(address).digest('hex');
  }
  get(owner, id) {
    if (!uuid(id)) fail('Strategy not found.', 404);
    const row = this.db.prepare('SELECT document FROM research_strategies WHERE owner=? AND id=?').get(owner, id);
    if (!row) fail('Strategy not found.', 404);
    return JSON.parse(row.document);
  }
  read(address, id = null, after = 0) {
    const owner = this.owner(address);
    if (!Number.isSafeInteger(after) || after < 0) fail('Invalid event cursor.');
    const strategies = this.db.prepare("SELECT json_remove(document,'$.messages') AS document FROM research_strategies WHERE owner=? ORDER BY updated_at DESC LIMIT 100").all(owner).map(row => JSON.parse(row.document));
    const events = this.db.prepare('SELECT cursor,strategy_id AS strategyId,revision,kind,created_at AS createdAt FROM research_events WHERE owner=? AND cursor>? ORDER BY cursor LIMIT 200').all(owner, after);
    // Never expose another account's cursor or events. Pagination is lossless.
    return { owner: address, strategies, strategy: id ? this.get(owner,id) : null, events, cursor: events.at(-1)?.cursor ?? after };
  }
  mutate(address, body) {
    const owner = this.owner(address);
    if (!body || !uuid(body.requestId) || !['CREATE','UPDATE','NOTE'].includes(body.operation)) fail('Invalid research request.');
    const digest = createHash('sha256').update(JSON.stringify(body)).digest('hex');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.db.prepare('SELECT digest,strategy_id FROM research_requests WHERE owner=? AND request_id=?').get(owner,body.requestId);
      if (previous) {
        if (previous.digest !== digest) fail('This request identifier was already used.',409);
        const doc = this.get(owner, previous.strategy_id); this.db.exec('COMMIT'); return doc;
      }
      const recent = new Date(Date.now()-60_000).toISOString();
      if (this.db.prepare('SELECT count(*) AS n FROM research_events WHERE owner=? AND created_at>?').get(owner,recent).n >= 30) fail('You are saving quickly. Try again in a minute.',429);
      const now = new Date().toISOString();
      let doc;
      if (body.operation === 'CREATE') {
        if (this.db.prepare('SELECT count(*) AS n FROM research_strategies WHERE owner=?').get(owner).n >= 100) fail('You have 100 strategies. Continue an existing strategy.',409);
        doc = {...validateBrief(body.brief,this.allowed),id:randomUUID(),revision:1,status:'DRAFT',createdAt:now,updatedAt:now,messages:[]};
      } else {
        doc = this.get(owner,body.id);
        if (doc.revision !== body.revision) fail('This strategy changed in another tab. Reload the latest version before saving.',409);
        if (doc.revision >= 500) fail('This strategy reached its revision limit. Start a new strategy.',409);
        if (body.operation === 'UPDATE') { doc = {...doc,...validateBrief(body.brief,this.allowed)}; if (body.brief?.agentId == null) delete doc.agentId; }
        else {
          if (doc.messages.length >= 200) fail('This strategy has 200 notes. Start a new strategy.',409);
          doc.messages.push({id:body.requestId,text:text(body.text,4000),createdAt:now,revision:doc.revision+1});
        }
        doc.revision++; doc.updatedAt = now;
      }
      this.db.prepare('INSERT INTO research_strategies(owner,id,revision,document,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,document=excluded.document,updated_at=excluded.updated_at').run(owner,doc.id,doc.revision,JSON.stringify(doc),now);
      this.db.prepare('INSERT INTO research_requests VALUES(?,?,?,?)').run(owner,body.requestId,digest,doc.id);
      this.db.prepare('INSERT INTO research_events(owner,strategy_id,revision,kind,created_at) VALUES(?,?,?,?,?)').run(owner,doc.id,doc.revision,body.operation,now);
      this.db.exec('COMMIT'); return doc;
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
}
