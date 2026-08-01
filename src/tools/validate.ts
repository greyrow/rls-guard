import pg from "pg";

const { Pool } = pg;

/**
 * Runs generated SQL inside BEGIN/ROLLBACK against a live database to catch broken
 * SQL before it's trusted, without actually changing anything. Postgres DDL (ALTER
 * TABLE, CREATE/DROP POLICY, ADD CONSTRAINT — everything `generate` produces) is
 * fully transactional, so the rollback is clean.
 *
 * This only proves the SQL applies to the database it was run against, right now.
 * It's not a portable guarantee for a different target's roles/functions/schema.
 */
export interface DryRunResult {
  ok: boolean;
  databaseName?: string;
  error?: string;
  errorCode?: string;
  insufficientPrivilege?: boolean;
}

export async function dryRunSql(databaseUrl: string, sql: string): Promise<DryRunResult> {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const client = await pool.connect();
    let databaseName: string | undefined;
    try {
      const dbNameResult = await client.query<{ current_database: string }>("select current_database()");
      databaseName = dbNameResult.rows[0]?.current_database;

      await client.query("BEGIN");
      await client.query(sql);
      return { ok: true, databaseName };
    } catch (err) {
      const pgErr = err as { message?: string; code?: string };
      return {
        ok: false,
        databaseName,
        error: pgErr.message ?? String(err),
        errorCode: pgErr.code,
        insufficientPrivilege: pgErr.code === "42501",
      };
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  } finally {
    await pool.end();
  }
}
