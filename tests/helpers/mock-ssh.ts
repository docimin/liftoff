import type { SshClient, ExecResult } from "../../src/types";

export type MockExecHandler = (command: string) => ExecResult | Promise<ExecResult>;

export class MockSshClient implements SshClient {
  public commands: string[] = [];
  public uploadedFiles: Array<{ local: string; remote: string }> = [];
  public downloadedFiles: Array<{ remote: string; local: string }> = [];
  public writtenFiles: Map<string, string> = new Map();
  public fileContents: Map<string, string> = new Map();
  private execHandler: MockExecHandler;

  constructor(handler?: MockExecHandler) {
    this.execHandler = handler ?? (() => ({ stdout: "", stderr: "", code: 0 }));
  }

  async exec(command: string): Promise<ExecResult> {
    this.commands.push(command);
    return this.execHandler(command);
  }

  async execStream(
    command: string,
    onStdout: (chunk: string) => void,
    _onStderr?: (chunk: string) => void,
  ): Promise<ExecResult> {
    this.commands.push(command);
    const result = await this.execHandler(command);
    if (result.stdout) onStdout(result.stdout);
    return result;
  }

  async upload(localPath: string, remotePath: string): Promise<void> {
    this.uploadedFiles.push({ local: localPath, remote: remotePath });
  }

  async download(remotePath: string, localPath: string): Promise<void> {
    this.downloadedFiles.push({ remote: remotePath, local: localPath });
  }

  async readFile(remotePath: string): Promise<string> {
    const content = this.fileContents.get(remotePath);
    if (content === undefined) throw new Error(`File not found: ${remotePath}`);
    return content;
  }

  async writeFile(remotePath: string, content: string): Promise<void> {
    this.writtenFiles.set(remotePath, content);
  }

  async close(): Promise<void> {}
}
