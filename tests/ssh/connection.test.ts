import { describe, expect, test } from "bun:test";
import { parseConnectionString, SshConnection } from "../../src/ssh/connection";

describe("parseConnectionString", () => {
  test("parses user@host", () => {
    const result = parseConnectionString("root@server.de");
    expect(result).toEqual({ username: "root", host: "server.de", port: 22 });
  });

  test("parses user@host:port", () => {
    const result = parseConnectionString("deploy@10.0.0.1:2222");
    expect(result).toEqual({ username: "deploy", host: "10.0.0.1", port: 2222 });
  });

  test("defaults username to root if omitted", () => {
    const result = parseConnectionString("server.de");
    expect(result).toEqual({ username: "root", host: "server.de", port: 22 });
  });

  test("handles IPv6 in brackets", () => {
    const result = parseConnectionString("root@[::1]:22");
    expect(result).toEqual({ username: "root", host: "::1", port: 22 });
  });
});

describe("SshConnection", () => {
  test("getAuthMethods returns methods in cascade order", () => {
    const methods = SshConnection.getAuthMethods({
      username: "root",
      host: "server.de",
      port: 22,
    });
    expect(methods.length).toBeGreaterThanOrEqual(1);
    expect(["agent", "privateKey"]).toContain(methods[0].type);
  });

  test("wrapWithSudo prepends sudo when needed", () => {
    expect(SshConnection.wrapWithSudo("docker ps", "root")).toBe("docker ps");
    expect(SshConnection.wrapWithSudo("docker ps", "sudo_nopasswd")).toBe("sudo docker ps");
    expect(SshConnection.wrapWithSudo("docker ps", "sudo_passwd", "mypass")).toBe(
      "echo 'mypass' | sudo -S docker ps",
    );
    expect(SshConnection.wrapWithSudo("docker ps", "docker_group")).toBe("docker ps");
  });
});
