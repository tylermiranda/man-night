import { DatabaseSync } from 'node:sqlite';

class FakeD1PreparedStatement {
  private readonly db: DatabaseSync;
  private readonly sql: string;
  private readonly params: unknown[];

  constructor(db: DatabaseSync, sql: string, params: unknown[] = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }

  bind(...values: unknown[]) {
    return new FakeD1PreparedStatement(this.db, this.sql, values);
  }

  private cleanParams() {
    return this.params.map((p) => (p === undefined ? null : (p as string | number | bigint | Uint8Array | null)));
  }

  async first<T = Record<string, unknown>>(colName?: string): Promise<T | null> {
    const stmt = this.db.prepare(this.sql);
    const row = stmt.get(...this.cleanParams()) as Record<string, unknown> | undefined;
    if (!row) return null;
    if (colName) return (row[colName] as T) ?? null;
    return row as T;
  }

  async all<T = Record<string, unknown>>(): Promise<{ results: T[]; success: boolean; meta: Record<string, unknown> }> {
    const stmt = this.db.prepare(this.sql);
    const rows = stmt.all(...this.cleanParams()) as T[];
    return { results: rows, success: true, meta: {} };
  }

  async run(): Promise<{ success: boolean; meta: { changes: number; last_row_id: number } }> {
    const stmt = this.db.prepare(this.sql);
    const info = stmt.run(...this.cleanParams());
    return {
      success: true,
      meta: {
        changes: Number(info.changes ?? 0),
        last_row_id: Number(info.lastInsertRowid ?? 0),
      },
    };
  }
}

export function createTestD1(schemaSql: string, seedSql?: string): D1Database {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(schemaSql);
  if (seedSql) {
    sqlite.exec(seedSql);
  }
  return {
    prepare(query: string) {
      return new FakeD1PreparedStatement(sqlite, query) as unknown as D1PreparedStatement;
    },
    async batch(statements: D1PreparedStatement[]) {
      const results = [];
      for (const s of statements) {
        results.push(await s.all());
      }
      return results;
    },
    async exec(query: string) {
      sqlite.exec(query);
      return { count: 1, duration: 1 };
    },
    async dump() {
      return new ArrayBuffer(0);
    },
  } as unknown as D1Database;
}
