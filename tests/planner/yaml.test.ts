import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { parsePlanYaml, stringifyPlan } from "../../src/planner/yaml";
import type { MigrationPlan } from "../../src/types";

const fixtureYaml = readFileSync("tests/fixtures/liftoff-plan.yml", "utf-8");

describe("parsePlanYaml", () => {
  test("parses a valid plan file", () => {
    const plan = parsePlanYaml(fixtureYaml);
    expect(plan.version).toBe(1);
    expect(plan.source.host).toBe("root@old-server.de");
    expect(plan.target.host).toBe("root@new-server.de");
    expect(plan.services).toHaveLength(2);
    expect(plan.steps).toHaveLength(10);
  });

  test("preserves step types", () => {
    const plan = parsePlanYaml(fixtureYaml);
    expect(plan.steps[0].type).toBe("rsync");
    expect(plan.steps[2].type).toBe("postgres_dump");
    expect(plan.steps[9].type).toBe("http_check");
  });

  test("preserves optional step fields", () => {
    const plan = parsePlanYaml(fixtureYaml);
    expect(plan.steps[0].live).toBe(true);
    expect(plan.steps[2].service).toBe("nextcloud-db");
    expect(plan.steps[2].method).toBe("dump_restore");
    expect(plan.steps[9].url).toBe("https://cloud.example.org");
    expect(plan.steps[9].expect).toBe(200);
  });

  test("throws on invalid YAML", () => {
    expect(() => parsePlanYaml("not: valid: yaml: {{")).toThrow();
  });

  test("throws on missing version", () => {
    expect(() => parsePlanYaml("source:\n  host: foo")).toThrow(/version/i);
  });
});

describe("stringifyPlan", () => {
  test("round-trips a plan", () => {
    const plan = parsePlanYaml(fixtureYaml);
    const yaml = stringifyPlan(plan);
    const reparsed = parsePlanYaml(yaml);
    expect(reparsed.version).toBe(plan.version);
    expect(reparsed.source.host).toBe(plan.source.host);
    expect(reparsed.services).toHaveLength(plan.services.length);
    expect(reparsed.steps).toHaveLength(plan.steps.length);
  });
});
