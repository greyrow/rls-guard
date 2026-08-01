import { readFile } from "node:fs/promises";
import yaml from "js-yaml";
import type { AppSpec } from "../types.js";

/** Loads and does light validation on a rls-guard YAML spec file. */
export async function loadSpec(specPath: string): Promise<AppSpec> {
  const raw = await readFile(specPath, "utf8");
  const parsed = yaml.load(raw) as AppSpec;

  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Spec at ${specPath} did not parse to an object.`);
  }
  if (!Array.isArray(parsed.roles) || parsed.roles.length === 0) {
    throw new Error(`Spec at ${specPath} must define at least one role under "roles:".`);
  }
  if (!parsed.tables || Object.keys(parsed.tables).length === 0) {
    throw new Error(`Spec at ${specPath} must define at least one table under "tables:".`);
  }

  return parsed;
}
