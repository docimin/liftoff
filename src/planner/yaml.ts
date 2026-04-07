import { parse, stringify } from "yaml";
import type { MigrationPlan } from "../types";

export function parsePlanYaml(yamlContent: string): MigrationPlan {
  const raw = parse(yamlContent) as Record<string, unknown>;

  if (!raw || typeof raw !== "object") {
    throw new Error("Invalid plan file: could not parse YAML");
  }

  if (!("version" in raw) || raw.version === undefined) {
    throw new Error("Invalid plan file: missing version field");
  }

  return raw as unknown as MigrationPlan;
}

export function stringifyPlan(plan: MigrationPlan): string {
  return stringify(plan, {
    lineWidth: 120,
    defaultStringType: "PLAIN",
    defaultKeyType: "PLAIN",
  });
}
