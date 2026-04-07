import { describe, expect, test } from "bun:test";
import { redisDumpMigrator } from "../../src/migrators/redis-dump";
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
    services: [
      {
        name: "cache",
        image: "redis:7-alpine",
        type: "redis",
        version: "7",
        volumes: [],
      },
    ],
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

describe("redisDumpMigrator", () => {
  test("type is redis_dump", () => {
    expect(redisDumpMigrator.type).toBe("redis_dump");
  });

  test("validate fails with missing service", async () => {
    const source = new MockSshClient();
    const result = await redisDumpMigrator.validate(
      { name: "dump", type: "redis_dump" },
      makeContext(source),
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("No service specified");
  });

  test("execute runs redis-cli BGSAVE via docker compose exec", async () => {
    let lastsaveCall = 0;
    const source = new MockSshClient((cmd) => {
      if (cmd.includes("ps --status running")) {
        return { stdout: "cache-1", stderr: "", code: 0 };
      }
      if (cmd.includes("redis-cli LASTSAVE")) {
        lastsaveCall++;
        // Return different timestamp on second+ call to indicate save complete
        const ts = lastsaveCall <= 1 ? "1700000000" : "1700000001";
        return { stdout: ts, stderr: "", code: 0 };
      }
      if (cmd.includes("redis-cli BGSAVE")) {
        return { stdout: "Background saving started", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    });

    const result = await redisDumpMigrator.execute(
      {
        name: "dump",
        type: "redis_dump",
        service: "cache",
      },
      makeContext(source),
    );
    expect(result.success).toBe(true);
    expect(source.commands.some((c) => c.includes("redis-cli"))).toBe(true);
  });
});
