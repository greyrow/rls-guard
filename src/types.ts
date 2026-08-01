/**
 * Types for the rls-guard permission/RLS spec format.
 *
 * A spec describes, in plain terms, who is allowed to select/insert/update/delete
 * rows in each table, and what should happen when a parent row is deleted
 * (cascade / restrict / set_null). rls-guard turns this into real Postgres
 * RLS policies + FK constraints, and can also audit a live database against it.
 */

export type CrudAction = "select" | "insert" | "update" | "delete";

export type CascadeAction = "cascade" | "restrict" | "set_null" | "no_action";

export interface RoleDef {
  /** Postgres role name, or a logical name resolved via auth.uid()-style checks (e.g. "owner"). */
  name: string;
  description?: string;
}

export interface CascadeRule {
  /** The parent table whose deletion triggers this behavior. */
  on_delete_of: string;
  /** What happens to this table's rows when the parent row is deleted. */
  action: CascadeAction;
}

export interface TableSpec {
  /** Column that identifies the "owning" user, if row-level ownership applies (e.g. "user_id"). */
  owner_column?: string;
  /**
   * Which roles can perform each CRUD action. "owner" is a reserved role name meaning
   * "the row's owner_column matches the current user".
   */
  rules: Partial<Record<CrudAction, string[]>>;
  /** Optional cascade-delete behavior relative to a parent table. */
  cascade?: CascadeRule;
}

export interface AppSpec {
  roles: RoleDef[];
  tables: Record<string, TableSpec>;
}

/** What we learn by introspecting a live Postgres database. */
export interface LiveColumn {
  name: string;
  dataType: string;
  isNullable: boolean;
}

export interface LiveForeignKey {
  constraintName: string;
  column: string;
  referencesTable: string;
  referencesColumn: string;
  onDelete: string; // raw pg_constraint confdeltype mapped to a readable action
}

export interface LivePolicy {
  policyName: string;
  command: string; // SELECT | INSERT | UPDATE | DELETE | ALL
  roles: string[];
  usingExpr: string | null;
  withCheckExpr: string | null;
}

export interface LiveTable {
  name: string;
  rlsEnabled: boolean;
  columns: LiveColumn[];
  foreignKeys: LiveForeignKey[];
  policies: LivePolicy[];
}

export interface LiveSchema {
  tables: LiveTable[];
}
