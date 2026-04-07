import { hostname } from "node:os";
import type { SshClient } from "../types";
import { SshConnection } from "./connection";
import { LocalClient } from "./local";

/** Check if a host string refers to the local machine */
export function isLocalHost(host: string): boolean {
  const h = host.replace(/^[^@]*@/, ""); // strip user@
  const localNames = ["localhost", "127.0.0.1", "::1", hostname()];
  return localNames.includes(h);
}

/** Connect to a server — returns LocalClient for local, SshConnection for remote */
export async function connectServer(
  host: string,
  overrides?: { keyPath?: string; password?: string },
): Promise<SshClient> {
  if (isLocalHost(host)) {
    return new LocalClient();
  }
  const conn = new SshConnection(host, overrides);
  await conn.connect();
  return conn;
}

/**
 * Connect to a server with interactive fallback.
 * Tries auto-connect first, then prompts for credentials if it fails.
 */
export async function connectServerInteractive(host: string): Promise<SshClient> {
  if (isLocalHost(host)) {
    return new LocalClient();
  }

  // Try auto-connect first
  try {
    return await connectServer(host);
  } catch {
    // Auto-connect failed — prompt for credentials
    const p = await import("@clack/prompts");

    const authMethod = await p.select({
      message: `Could not connect to ${host}. How would you like to authenticate?`,
      options: [
        { value: "key", label: "Specify SSH key path" },
        { value: "password", label: "Enter password" },
        { value: "cancel", label: "Cancel" },
      ],
    });
    if (p.isCancel(authMethod) || authMethod === "cancel") {
      throw new Error("Connection cancelled");
    }

    if (authMethod === "key") {
      const keyPath = await p.text({
        message: "Path to SSH private key",
        placeholder: "~/.ssh/id_ed25519",
      });
      if (p.isCancel(keyPath)) throw new Error("Connection cancelled");
      const resolved = keyPath.replace(/^~/, process.env.HOME || "");
      return await connectServer(host, { keyPath: resolved });
    }

    const pass = await p.password({ message: "SSH password" });
    if (p.isCancel(pass)) throw new Error("Connection cancelled");
    return await connectServer(host, { password: pass });
  }
}
