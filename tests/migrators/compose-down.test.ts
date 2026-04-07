import { describe, expect, test } from "bun:test";
import { composeDownMigrator } from "../../src/migrators/compose-down";
import type { MigrationContext, MigrationPlan } from "../../src/types";
import { MockSshClient } from "../helpers/mock-ssh";

function makeContext(source: MockSshClient): MigrationContext {
  const plan: MigrationPlan = {
    version: 1,
    source: {
      host: "root@old.de",
      compose_file: "/opt/app/docker-compose.yml",
    },
    target: { host: "root@new.de", compose_dir: "/opt/app" },
    services: [],
    volumes: [],
    steps: [],
  };
  return {
    source,
    target: new MockSshClient(),
    plan,
    onProgress: () => {},
    onLog: () => {},
  };
}

describe("composeDownMigrator", () => {
  test("runs docker compose down on source", async () => {
    const source = new MockSshClient((cmd) => {
      if (cmd.includes("ps --status running")) {
        return { stdout: "app-1", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    });
    const result = await composeDownMigrator.execute(
      { name: "stop", type: "compose_down" },
      makeContext(source),
    );
    expect(result.success).toBe(true);
    expect(source.commands.some((c) => c.includes("docker compose") && c.includes("down"))).toBe(
      true,
    );
  });

  test("uses correct compose file path", async () => {
    const source = new MockSshClient((cmd) => {
      if (cmd.includes("ps --status running")) {
        return { stdout: "app-1", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    });
    await composeDownMigrator.execute({ name: "stop", type: "compose_down" }, makeContext(source));
    expect(source.commands.some((c) => c.includes("-f /opt/app/docker-compose.yml"))).toBe(true);
  });
});
