// Development/test adapter only. Production uses the Sites-provided D1 binding.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
export function localD1(path = ':memory:') {
  const database = new DatabaseSync(path);
  database.exec('CREATE TABLE IF NOT EXISTS _qa_migrations (name TEXT PRIMARY KEY)');
  for (const name of ['0000_workspace', '0001_collaboration', '0002_gateway_credentials']) {
    if (!database.prepare('SELECT name FROM _qa_migrations WHERE name = ?').get(name)) {
      database.exec(readFileSync(new URL(`../drizzle/${name}.sql`, import.meta.url), 'utf8'));
      database.prepare('INSERT INTO _qa_migrations (name) VALUES (?)').run(name);
    }
  }
  const DB = {
    prepare(sql) {
      let args = [];
      return { bind(...values) { args = values; return this; }, async run() { const result = database.prepare(sql).run(...args); return { meta: { changes: Number(result.changes) } }; }, async first() { return database.prepare(sql).get(...args) || null; }, async all() { return { results: database.prepare(sql).all(...args) }; } };
    },
    async batch(statements) {
      database.exec('BEGIN');
      try { const results = []; for (const statement of statements) results.push(await statement.run()); database.exec('COMMIT'); return results; }
      catch (error) { database.exec('ROLLBACK'); throw error; }
    }
  };
  return { DB, database, close: () => database.close() };
}
