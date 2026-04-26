// state_operations.ts — AIMFP runtime-state CRUD helpers.
// Location: packages/.state/state_operations.ts
// Generated from AIMFP Python template; preserves the five CRUD function
// names (set_var, get_var, delete_var, increment_var, list_vars) and the
// Result type so AIMFP tooling can recognize them.
//
// FP discipline: pure logic where possible; SQLite I/O is the only effect
// and is confined to withDb. No mutations of arguments. Result is the
// explicit error-handling type — no thrown exceptions cross the boundary.

import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

export const STATE_DB_PATH: string = join(here, "runtime.db");

export type VarType = "int" | "float" | "str" | "bool" | "dict" | "list";

export type Result<T = unknown> = Readonly<{
  success: boolean;
  data?: T;
  error?: string;
}>;

const ok = <T>(data?: T): Result<T> => ({ success: true, data });
const fail = <T = never>(message: string): Result<T> => ({ success: false, error: message });

const inferType = (value: unknown): VarType => {
  if (Array.isArray(value)) return "list";
  if (value !== null && typeof value === "object") return "dict";
  if (typeof value === "boolean") return "bool";
  if (typeof value === "number") return Number.isInteger(value) ? "int" : "float";
  return "str";
};

const serialize = (value: unknown): string => {
  if (typeof value === "object" || typeof value === "boolean") return JSON.stringify(value);
  return String(value);
};

const deserialize = (raw: string, varType: string): unknown => {
  switch (varType) {
    case "int":
      return parseInt(raw, 10);
    case "float":
      return parseFloat(raw);
    case "bool":
    case "dict":
    case "list":
      return JSON.parse(raw);
    default:
      return raw;
  }
};

const withDb = <T>(fn: (db: Database.Database) => T): T => {
  const db = new Database(STATE_DB_PATH);
  try {
    return fn(db);
  } finally {
    db.close();
  }
};

export const set_var = (varName: string, value: unknown, varType?: VarType): Result => {
  try {
    return withDb((db) => {
      const finalType = varType ?? inferType(value);
      db.prepare(
        "INSERT OR REPLACE INTO variables (var_name, var_value, var_type, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)",
      ).run(varName, serialize(value), finalType);
      return ok();
    });
  } catch (e) {
    return fail(`Failed to set variable: ${(e as Error).message}`);
  }
};

export const get_var = <T = unknown>(varName: string): Result<T> => {
  try {
    return withDb((db) => {
      const row = db
        .prepare("SELECT var_value, var_type FROM variables WHERE var_name = ?")
        .get(varName) as { var_value: string; var_type: string } | undefined;
      if (!row) return fail<T>(`Variable '${varName}' not found`);
      return ok(deserialize(row.var_value, row.var_type) as T);
    });
  } catch (e) {
    return fail<T>(`Failed to get variable: ${(e as Error).message}`);
  }
};

export const delete_var = (varName: string): Result => {
  try {
    return withDb((db) => {
      const info = db.prepare("DELETE FROM variables WHERE var_name = ?").run(varName);
      if (info.changes === 0) return fail(`Variable '${varName}' not found`);
      return ok();
    });
  } catch (e) {
    return fail(`Failed to delete variable: ${(e as Error).message}`);
  }
};

export const increment_var = (varName: string, amount: number = 1): Result<number> => {
  const current = get_var<number>(varName);
  const baseValue: number = current.success && typeof current.data === "number" ? current.data : 0;
  if (current.success && typeof current.data !== "number") {
    return fail<number>(`Variable '${varName}' is not numeric`);
  }
  const next = baseValue + amount;
  const setResult = set_var(varName, next, Number.isInteger(next) ? "int" : "float");
  if (!setResult.success) {
    return fail<number>(setResult.error ?? "Failed to set incremented value");
  }
  return ok(next);
};

export const list_vars = (varType?: VarType): Result<string[]> => {
  try {
    return withDb((db) => {
      const rows = (
        varType
          ? db
              .prepare("SELECT var_name FROM variables WHERE var_type = ? ORDER BY var_name")
              .all(varType)
          : db.prepare("SELECT var_name FROM variables ORDER BY var_name").all()
      ) as { var_name: string }[];
      return ok(rows.map((r) => r.var_name));
    });
  } catch (e) {
    return fail<string[]>(`Failed to list variables: ${(e as Error).message}`);
  }
};
