import type { SshClient, ServerCheck, PermissionLevel } from "../types";

export interface ValidationReport {
  checks: ServerCheck[];
  permissionLevel: PermissionLevel;
  availableDiskBytes: number;
}

export async function validateServer(ssh: SshClient): Promise<ValidationReport> {
  const checks: ServerCheck[] = [];
  let permissionLevel: PermissionLevel = "unprivileged";
  let availableDiskBytes = 0;

  // 1. Detect permission level
  const whoami = await ssh.exec("whoami");
  const username = whoami.stdout.trim();

  if (username === "root") {
    permissionLevel = "root";
  } else {
    // Try docker directly (user in docker group)
    const dockerDirect = await ssh.exec("docker ps");
    if (dockerDirect.code === 0) {
      permissionLevel = "docker_group";
    } else {
      // Try sudo without password
      const sudoNoPass = await ssh.exec("sudo -n true");
      if (sudoNoPass.code === 0) {
        permissionLevel = "sudo_nopasswd";
      } else {
        // Check if sudo exists at all
        const hasSudo = await ssh.exec("which sudo");
        if (hasSudo.code === 0) {
          permissionLevel = "sudo_passwd";
        }
      }
    }
  }

  // 2. Docker access
  const canDocker =
    permissionLevel === "root" ||
    permissionLevel === "docker_group" ||
    permissionLevel === "sudo_nopasswd";

  if (canDocker || permissionLevel === "sudo_passwd") {
    checks.push({
      name: "Docker access",
      status: canDocker ? "pass" : "warn",
      message: canDocker
        ? `Docker accessible as ${username}`
        : `Docker requires sudo password (will be prompted)`,
      fix: canDocker
        ? undefined
        : "Sudo password will be requested during migration",
    });
  } else {
    checks.push({
      name: "Docker access",
      status: "fail",
      message: `User '${username}' cannot run Docker commands`,
      fix: [
        "You need one of:",
        "  - Be in the docker group (ask your server admin)",
        "  - Connect as root",
        "  - Connect as a user with sudo access",
      ].join("\n"),
    });
  }

  // 3. Docker Compose
  const composeResult = await ssh.exec("docker compose version");
  if (composeResult.code === 0) {
    const version = composeResult.stdout.match(/v?([\d.]+)/)?.[1] ?? "unknown";
    checks.push({
      name: "Docker Compose",
      status: "pass",
      message: `Docker Compose ${version}`,
    });
  } else {
    checks.push({
      name: "Docker Compose",
      status: "fail",
      message: "Docker Compose not found",
      fix: "Install Docker Compose: https://docs.docker.com/compose/install/",
    });
  }

  // 4. rsync
  const rsyncResult = await ssh.exec("which rsync");
  if (rsyncResult.code === 0) {
    checks.push({
      name: "rsync",
      status: "pass",
      message: "rsync available",
    });
  } else {
    // Detect OS for install command
    const osRelease = await ssh.exec("cat /etc/os-release");
    const osId = osRelease.stdout.match(/^ID=(.+)$/m)?.[1]?.replace(/"/g, "") ?? "";
    let installCmd: string;

    if (["ubuntu", "debian"].includes(osId)) {
      installCmd = "apt install -y rsync";
    } else if (["centos", "rhel", "fedora", "rocky", "alma"].includes(osId)) {
      installCmd = "dnf install -y rsync";
    } else if (osId === "alpine") {
      installCmd = "apk add rsync";
    } else {
      installCmd = "Install rsync using your package manager";
    }

    checks.push({
      name: "rsync",
      status: "fail",
      message: "rsync not installed",
      fix: installCmd,
    });
  }

  // 5. Disk space
  const dfResult = await ssh.exec("df -B1 /");
  if (dfResult.code === 0) {
    const lines = dfResult.stdout.trim().split("\n");
    if (lines.length >= 2) {
      const parts = lines[1].split(/\s+/);
      availableDiskBytes = parseInt(parts[3] ?? "0", 10);
      checks.push({
        name: "Disk space",
        status: "pass",
        message: `${formatBytes(availableDiskBytes)} available`,
      });
    }
  }

  return { checks, permissionLevel, availableDiskBytes };
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}
