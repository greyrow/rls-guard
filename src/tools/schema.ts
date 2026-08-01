import pg from "pg";
import type { LiveSchema, LiveTable, LiveColumn, LiveForeignKey, LivePolicy } from "../types.js";

const { Pool } = pg;

/**
 * Introspects a live Postgres database: tables, columns, RLS status,
 * existing policies, and foreign key ON DELETE behavior.
 *
 * This is the "ground truth" rls-guard compares a spec against during `audit`,
 * and the context it hands to Claude during `generate`.
 */
export async function introspectSchema(databaseUrl: string, schemaName = "public"): Promise<LiveSchema> {
  const pool = new Pool({ connectionString: databaseUrl });

  try {
    const tablesResult = await pool.query<{ tablename: string; rowsecurity: boolean }>(
      `select tablename, rowsecurity
       from pg_tables
       where schemaname = $1
       order by tablename`,
      [schemaName]
    );

    const tables: LiveTable[] = [];

    for (const row of tablesResult.rows) {
      const [columns, foreignKeys, policies] = await Promise.all([
        getColumns(pool, schemaName, row.tablename),
        getForeignKeys(pool, schemaName, row.tablename),
        getPolicies(pool, schemaName, row.tablename),
      ]);

      tables.push({
        name: row.tablename,
        rlsEnabled: row.rowsecurity,
        columns,
        foreignKeys,
        policies,
      });
    }

    return { tables };
  } finally {
    await pool.end();
  }
}

async function getColumns(pool: pg.Pool, schemaName: string, tableName: string): Promise<LiveColumn[]> {
  const result = await pool.query<{ column_name: string; data_type: string; is_nullable: string }>(
    `select column_name, data_type, is_nullable
     from information_schema.columns
     where table_schema = $1 and table_name = $2
     order by ordinal_position`,
    [schemaName, tableName]
  );

  return result.rows.map((r) => ({
    name: r.column_name,
    dataType: r.data_type,
    isNullable: r.is_nullable === "YES",
  }));
}

async function getForeignKeys(pool: pg.Pool, schemaName: string, tableName: string): Promise<LiveForeignKey[]> {
  const result = await pool.query<{
    constraint_name: string;
    column_name: string;
    references_table: string;
    references_column: string;
    confdeltype: string;
  }>(
    `select
       con.conname as constraint_name,
       att.attname as column_name,
       cl2.relname as references_table,
       att2.attname as references_column,
       con.confdeltype as confdeltype
     from pg_constraint con
     join pg_class cl on cl.oid = con.conrelid
     join pg_namespace ns on ns.oid = cl.relnamespace
     join pg_class cl2 on cl2.oid = con.confrelid
     join unnest(con.conkey) with ordinality as a(attnum, ord) on true
     join pg_attribute att on att.attrelid = con.conrelid and att.attnum = a.attnum
     join unnest(con.confkey) with ordinality as b(attnum, ord) on b.ord = a.ord
     join pg_attribute att2 on att2.attrelid = con.confrelid and att2.attnum = b.attnum
     where con.contype = 'f' and ns.nspname = $1 and cl.relname = $2`,
    [schemaName, tableName]
  );

  const actionMap: Record<string, string> = {
    a: "no_action",
    r: "restrict",
    c: "cascade",
    n: "set_null",
    d: "set_default",
  };

  return result.rows.map((r) => ({
    constraintName: r.constraint_name,
    column: r.column_name,
    referencesTable: r.references_table,
    referencesColumn: r.references_column,
    onDelete: actionMap[r.confdeltype] ?? r.confdeltype,
  }));
}

async function getPolicies(pool: pg.Pool, schemaName: string, tableName: string): Promise<LivePolicy[]> {
  const result = await pool.query<{
    policyname: string;
    cmd: string;
    roles: string[];
    qual: string | null;
    with_check: string | null;
  }>(
    `select policyname, cmd, roles::text[] as roles, qual, with_check
     from pg_policies
     where schemaname = $1 and tablename = $2`,
    [schemaName, tableName]
  );

  return result.rows.map((r) => ({
    policyName: r.policyname,
    command: r.cmd,
    roles: r.roles,
    usingExpr: r.qual,
    withCheckExpr: r.with_check,
  }));
}
