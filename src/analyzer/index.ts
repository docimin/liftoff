import type { AnalysisResult, SshClient, VolumeInfo } from "../types";
import { parseComposeFile } from "./compose-parser";
import { detectDatabases } from "./database-detector";

export async function analyzeStack(ssh: SshClient, composePath: string): Promise<AnalysisResult> {
  const yamlContent = await ssh.readFile(composePath);
  const parsed = parseComposeFile(yamlContent);

  const databases = detectDatabases(parsed.services);

  const services = parsed.services.map((service) => {
    const db = databases.find((d) => d.serviceName === service.name);
    if (db) {
      return { ...service, type: db.type as "postgres", version: db.version };
    }
    return service;
  });

  // Resolve Docker Compose project name to find prefixed volume names
  // Docker Compose names volumes as <project>_<volume> (e.g. root_nextcloud_data)
  const composeDir = composePath.replace(/\/[^/]+$/, "");
  let projectName = "";
  try {
    const result = await ssh.exec(
      `cd ${composeDir} && docker compose config --format json 2>/dev/null`,
    );
    if (result.code === 0) {
      const config = JSON.parse(result.stdout);
      projectName = config.name ?? "";
    }
  } catch {
    // Fallback: Docker Compose defaults to the directory name
    projectName = composeDir.split("/").pop() ?? "";
  }

  const volumes: VolumeInfo[] = [];
  for (const volName of parsed.volumeNames) {
    // Try prefixed name first (most common), then unprefixed
    const candidates = projectName ? [`${projectName}_${volName}`, volName] : [volName];

    for (const candidate of candidates) {
      const inspectResult = await ssh.exec(
        `docker volume inspect ${candidate} --format '{{.Driver}} {{.Mountpoint}}'`,
      );
      if (inspectResult.code === 0) {
        const [driver, mountpoint] = inspectResult.stdout.trim().split(" ");
        const duResult = await ssh.exec(`du -sb ${mountpoint} 2>/dev/null`);
        const sizeBytes =
          duResult.code === 0 ? Number.parseInt(duResult.stdout.split("\t")[0], 10) : 0;

        volumes.push({
          name: candidate,
          driver: driver ?? "local",
          mountpoint: mountpoint ?? "",
          sizeBytes,
        });
        break;
      }
    }
  }

  return { composePath, services, volumes, databases };
}

export { parseComposeFile } from "./compose-parser";
export { detectDatabases } from "./database-detector";
