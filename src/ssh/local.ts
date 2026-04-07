import { execSync, spawn } from "node:child_process";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import type { ExecResult, SshClient } from "../types";

/**
 * Local client that implements SshClient but runs commands on the local machine.
 * Used when the source server is the machine running liftoff.
 */
export class LocalClient implements SshClient {
  async exec(command: string): Promise<ExecResult> {
    try {
      const stdout = execSync(command, {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 60000,
      }).trimEnd();
      return { stdout, stderr: "", code: 0 };
    } catch (err: any) {
      return {
        stdout: (err.stdout ?? "").toString().trimEnd(),
        stderr: (err.stderr ?? "").toString().trimEnd(),
        code: err.status ?? 1,
      };
    }
  }

  async execStream(
    command: string,
    onStdout: (chunk: string) => void,
    onStderr?: (chunk: string) => void,
  ): Promise<ExecResult> {
    return new Promise((resolve) => {
      const child = spawn("sh", ["-c", command], { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (data: Buffer) => {
        const chunk = data.toString();
        stdout += chunk;
        onStdout(chunk);
      });

      child.stderr.on("data", (data: Buffer) => {
        const chunk = data.toString();
        stderr += chunk;
        onStderr?.(chunk);
      });

      child.on("close", (code) => {
        resolve({ stdout: stdout.trimEnd(), stderr: stderr.trimEnd(), code: code ?? 0 });
      });
    });
  }

  async upload(localPath: string, remotePath: string): Promise<void> {
    copyFileSync(localPath, remotePath);
  }

  async download(remotePath: string, localPath: string): Promise<void> {
    copyFileSync(remotePath, localPath);
  }

  async readFile(remotePath: string): Promise<string> {
    return readFileSync(remotePath, "utf-8");
  }

  async writeFile(remotePath: string, content: string): Promise<void> {
    writeFileSync(remotePath, content);
  }

  async close(): Promise<void> {}
}
