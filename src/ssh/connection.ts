import { Client } from "ssh2";
import { readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { SshClient, ExecResult, PermissionLevel } from "../types";

export interface ParsedConnection {
  username: string;
  host: string;
  port: number;
}

interface AuthMethod {
  type: "agent" | "privateKey" | "password";
  value?: string;
}

export function parseConnectionString(input: string): ParsedConnection {
  let username = "root";
  let host: string;
  let port = 22;
  let remainder = input;

  if (remainder.includes("@")) {
    const atIndex = remainder.indexOf("@");
    username = remainder.slice(0, atIndex);
    remainder = remainder.slice(atIndex + 1);
  }

  if (remainder.startsWith("[")) {
    const closeBracket = remainder.indexOf("]");
    host = remainder.slice(1, closeBracket);
    const afterBracket = remainder.slice(closeBracket + 1);
    if (afterBracket.startsWith(":")) {
      port = parseInt(afterBracket.slice(1), 10);
    }
  } else if (remainder.includes(":")) {
    const colonIndex = remainder.lastIndexOf(":");
    host = remainder.slice(0, colonIndex);
    port = parseInt(remainder.slice(colonIndex + 1), 10);
  } else {
    host = remainder;
  }

  return { username, host, port };
}

export class SshConnection implements SshClient {
  private client: Client | null = null;
  private parsed: ParsedConnection;
  private permissionLevel: PermissionLevel = "unprivileged";
  private sudoPassword?: string;

  constructor(
    private connectionString: string,
    private authOverrides?: { keyPath?: string; password?: string },
  ) {
    this.parsed = parseConnectionString(connectionString);
  }

  static getAuthMethods(parsed: ParsedConnection, overrides?: { keyPath?: string }): AuthMethod[] {
    const methods: AuthMethod[] = [];
    const home = homedir();

    if (process.env.SSH_AUTH_SOCK) {
      methods.push({ type: "agent" });
    }

    if (overrides?.keyPath && existsSync(overrides.keyPath)) {
      methods.push({ type: "privateKey", value: overrides.keyPath });
    }

    const defaultKeys = ["id_ed25519", "id_rsa", "id_ecdsa"];
    for (const keyName of defaultKeys) {
      const keyPath = join(home, ".ssh", keyName);
      if (existsSync(keyPath)) {
        methods.push({ type: "privateKey", value: keyPath });
      }
    }

    return methods;
  }

  static wrapWithSudo(command: string, permissionLevel: PermissionLevel, sudoPassword?: string): string {
    switch (permissionLevel) {
      case "root":
      case "docker_group":
        return command;
      case "sudo_nopasswd":
        return `sudo ${command}`;
      case "sudo_passwd":
        if (!sudoPassword) throw new Error("Sudo password required but not provided");
        return `echo '${sudoPassword}' | sudo -S ${command}`;
      case "unprivileged":
        return command;
    }
  }

  async connect(): Promise<void> {
    const methods = SshConnection.getAuthMethods(this.parsed, this.authOverrides);
    for (const method of methods) {
      try {
        await this.tryConnect(method);
        return;
      } catch {
        continue;
      }
    }
    if (this.authOverrides?.password) {
      await this.tryConnect({ type: "password", value: this.authOverrides.password });
      return;
    }
    throw new Error(
      `Could not authenticate to ${this.parsed.host} as ${this.parsed.username}. Tried: ${methods.map((m) => m.type).join(", ")}`,
    );
  }

  private tryConnect(method: AuthMethod): Promise<void> {
    return new Promise((resolve, reject) => {
      const client = new Client();
      const config: Record<string, unknown> = {
        host: this.parsed.host,
        port: this.parsed.port,
        username: this.parsed.username,
        readyTimeout: 10000,
      };
      switch (method.type) {
        case "agent":
          config.agent = process.env.SSH_AUTH_SOCK;
          break;
        case "privateKey":
          config.privateKey = readFileSync(method.value!);
          break;
        case "password":
          config.password = method.value;
          break;
      }
      client
        .on("ready", () => {
          this.client = client;
          resolve();
        })
        .on("error", (err) => {
          client.end();
          reject(err);
        })
        .connect(config as Parameters<Client["connect"]>[0]);
    });
  }

  setPermissionLevel(level: PermissionLevel, sudoPassword?: string): void {
    this.permissionLevel = level;
    this.sudoPassword = sudoPassword;
  }

  private wrapCmd(command: string): string {
    return SshConnection.wrapWithSudo(command, this.permissionLevel, this.sudoPassword);
  }

  async exec(command: string): Promise<ExecResult> {
    if (!this.client) throw new Error("Not connected");
    const wrappedCmd = this.wrapCmd(command);
    return new Promise((resolve, reject) => {
      this.client!.exec(wrappedCmd, (err, stream) => {
        if (err) return reject(err);
        let stdout = "";
        let stderr = "";
        stream.on("data", (data: Buffer) => { stdout += data.toString(); });
        stream.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
        stream.on("close", (code: number) => {
          resolve({ stdout: stdout.trimEnd(), stderr: stderr.trimEnd(), code: code ?? 0 });
        });
      });
    });
  }

  async execStream(command: string, onStdout: (chunk: string) => void, onStderr?: (chunk: string) => void): Promise<ExecResult> {
    if (!this.client) throw new Error("Not connected");
    const wrappedCmd = this.wrapCmd(command);
    return new Promise((resolve, reject) => {
      this.client!.exec(wrappedCmd, (err, stream) => {
        if (err) return reject(err);
        let stdout = "";
        let stderr = "";
        stream.on("data", (data: Buffer) => { const chunk = data.toString(); stdout += chunk; onStdout(chunk); });
        stream.stderr.on("data", (data: Buffer) => { const chunk = data.toString(); stderr += chunk; onStderr?.(chunk); });
        stream.on("close", (code: number) => { resolve({ stdout, stderr, code: code ?? 0 }); });
      });
    });
  }

  async upload(localPath: string, remotePath: string): Promise<void> {
    if (!this.client) throw new Error("Not connected");
    return new Promise((resolve, reject) => {
      this.client!.sftp((err, sftp) => {
        if (err) return reject(err);
        sftp.fastPut(localPath, remotePath, (err) => { sftp.end(); if (err) return reject(err); resolve(); });
      });
    });
  }

  async download(remotePath: string, localPath: string): Promise<void> {
    if (!this.client) throw new Error("Not connected");
    return new Promise((resolve, reject) => {
      this.client!.sftp((err, sftp) => {
        if (err) return reject(err);
        sftp.fastGet(remotePath, localPath, (err) => { sftp.end(); if (err) return reject(err); resolve(); });
      });
    });
  }

  async readFile(remotePath: string): Promise<string> {
    if (!this.client) throw new Error("Not connected");
    return new Promise((resolve, reject) => {
      this.client!.sftp((err, sftp) => {
        if (err) return reject(err);
        let content = "";
        const stream = sftp.createReadStream(remotePath);
        stream.on("data", (chunk: Buffer) => { content += chunk.toString(); });
        stream.on("end", () => { sftp.end(); resolve(content); });
        stream.on("error", (err) => { sftp.end(); reject(err); });
      });
    });
  }

  async writeFile(remotePath: string, content: string): Promise<void> {
    if (!this.client) throw new Error("Not connected");
    return new Promise((resolve, reject) => {
      this.client!.sftp((err, sftp) => {
        if (err) return reject(err);
        const stream = sftp.createWriteStream(remotePath);
        stream.on("close", () => { sftp.end(); resolve(); });
        stream.on("error", (err) => { sftp.end(); reject(err); });
        stream.end(content);
      });
    });
  }

  async close(): Promise<void> {
    if (this.client) {
      this.client.end();
      this.client = null;
    }
  }
}
