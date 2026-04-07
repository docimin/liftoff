import { describe, expect, test } from "bun:test";
import { validateServer } from "../../src/ssh/validation";
import { MockSshClient } from "../helpers/mock-ssh";
import type { PermissionLevel } from "../../src/types";

function makeHandler(responses: Record<string, { stdout: string; stderr: string; code: number }>) {
  return (cmd: string) => {
    for (const [pattern, result] of Object.entries(responses)) {
      if (cmd.includes(pattern)) return result;
    }
    return { stdout: "", stderr: "command not found", code: 127 };
  };
}

describe("validateServer", () => {
  test("all checks pass on a well-configured server", async () => {
    const ssh = new MockSshClient(
      makeHandler({
        whoami: { stdout: "root", stderr: "", code: 0 },
        "docker ps": { stdout: "CONTAINER ID", stderr: "", code: 0 },
        "docker compose version": {
          stdout: "Docker Compose version v2.27.0",
          stderr: "",
          code: 0,
        },
        "which rsync": { stdout: "/usr/bin/rsync", stderr: "", code: 0 },
        "df -B1": {
          stdout: "Filesystem     1B-blocks      Used Available\n/dev/sda1 100000000000 50000000000 50000000000",
          stderr: "",
          code: 0,
        },
      }),
    );

    const result = await validateServer(ssh);
    expect(result.checks.every((c) => c.status === "pass")).toBe(true);
    expect(result.permissionLevel).toBe("root");
  });

  test("detects missing docker", async () => {
    const ssh = new MockSshClient(
      makeHandler({
        whoami: { stdout: "deploy", stderr: "", code: 0 },
        "docker ps": { stdout: "", stderr: "permission denied", code: 1 },
        "sudo -n true": { stdout: "", stderr: "", code: 1 },
        "which sudo": { stdout: "", stderr: "", code: 1 },
        "docker compose version": { stdout: "", stderr: "not found", code: 127 },
        "which rsync": { stdout: "/usr/bin/rsync", stderr: "", code: 0 },
        "df -B1": { stdout: "Filesystem 1B-blocks Used Available\n/dev/sda1 100000000000 50000000000 50000000000", stderr: "", code: 0 },
      }),
    );

    const result = await validateServer(ssh);
    const dockerCheck = result.checks.find((c) => c.name === "Docker access");
    expect(dockerCheck?.status).toBe("fail");
    expect(dockerCheck?.fix).toBeDefined();
  });

  test("detects sudo with password", async () => {
    const ssh = new MockSshClient(
      makeHandler({
        whoami: { stdout: "deploy", stderr: "", code: 0 },
        "docker ps": { stdout: "", stderr: "permission denied", code: 1 },
        "sudo -n true": { stdout: "", stderr: "password required", code: 1 },
        "which sudo": { stdout: "/usr/bin/sudo", stderr: "", code: 0 },
        "docker compose version": { stdout: "Docker Compose version v2.27.0", stderr: "", code: 0 },
        "which rsync": { stdout: "/usr/bin/rsync", stderr: "", code: 0 },
        "df -B1": { stdout: "Filesystem 1B-blocks Used Available\n/dev/sda1 100000000000 50000000000 50000000000", stderr: "", code: 0 },
      }),
    );

    const result = await validateServer(ssh);
    expect(result.permissionLevel).toBe("sudo_passwd");
  });

  test("detects missing rsync and suggests install", async () => {
    const ssh = new MockSshClient(
      makeHandler({
        whoami: { stdout: "root", stderr: "", code: 0 },
        "docker ps": { stdout: "CONTAINER ID", stderr: "", code: 0 },
        "docker compose version": { stdout: "Docker Compose version v2.27.0", stderr: "", code: 0 },
        "which rsync": { stdout: "", stderr: "", code: 1 },
        "df -B1": { stdout: "Filesystem 1B-blocks Used Available\n/dev/sda1 100000000000 50000000000 50000000000", stderr: "", code: 0 },
        "cat /etc/os-release": { stdout: 'ID=ubuntu', stderr: "", code: 0 },
      }),
    );

    const result = await validateServer(ssh);
    const rsyncCheck = result.checks.find((c) => c.name === "rsync");
    expect(rsyncCheck?.status).toBe("fail");
    expect(rsyncCheck?.fix).toContain("apt");
  });
});
