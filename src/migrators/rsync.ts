import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  MigrationContext,
  Migrator,
  Step,
  StepResult,
  TimeEstimate,
  ValidationResult,
} from "../types";

export const rsyncMigrator: Migrator = {
  type: "rsync",

  async validate(_step: Step, context: MigrationContext): Promise<ValidationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];

    const sourceCheck = await context.source.exec("which rsync");
    if (sourceCheck.code !== 0) errors.push("rsync not installed on source server");

    const targetCheck = await context.target.exec("which rsync");
    if (targetCheck.code !== 0) errors.push("rsync not installed on target server");

    return { valid: errors.length === 0, errors, warnings };
  },

  async execute(_step: Step, context: MigrationContext): Promise<StepResult> {
    const start = Date.now();

    const volumes = context.plan.volumes;

    // Clean up any leftover temp files from a previous run
    await context.source.exec("rm -f /tmp/liftoff-vol-*.tar.gz");
    await context.target.exec("rm -f /tmp/liftoff-vol-*.tar.gz");

    if (volumes.length === 0) {
      context.onLog("No volumes to sync");
      return { success: true, duration: Date.now() - start };
    }

    for (let vi = 0; vi < volumes.length; vi++) {
      const vol = volumes[vi];
      const sourcePath = vol.mountpoint;

      context.onLog(`Syncing volume ${vol.name} (${vi + 1}/${volumes.length}): ${sourcePath}`);

      // Resolve target mountpoint — may differ from source if project names differ
      const targetMountResult = await context.target.exec(
        `docker volume inspect ${vol.name} --format '{{.Mountpoint}}'`,
      );
      const targetPath =
        targetMountResult.code === 0 && targetMountResult.stdout.trim()
          ? targetMountResult.stdout.trim()
          : sourcePath; // fallback to same path

      // Transfer via tar+SFTP relay through the liftoff process.
      // This uses the already-authenticated SSH connections — no extra SSH keys,
      // passphrases, or host key prompts needed.
      const remoteTar = `/tmp/liftoff-vol-${vol.name}.tar.gz`;
      const localTmp = join(tmpdir(), `liftoff-vol-${vol.name}.tar.gz`);

      // Archive volume on source
      context.onLog(`  Archiving ${vol.name}...`);
      const archiveResult = await context.source.exec(`tar czf ${remoteTar} -C ${sourcePath} .`);
      if (archiveResult.code !== 0) {
        return {
          success: false,
          error: `Failed to archive volume ${vol.name}: ${archiveResult.stderr}`,
          duration: Date.now() - start,
        };
      }

      // Get archive size for progress reporting
      const sizeResult = await context.source.exec(
        `stat -c%s ${remoteTar} 2>/dev/null || stat -f%z ${remoteTar}`,
      );
      const archiveSize = Number.parseInt(sizeResult.stdout.trim(), 10) || 0;
      const sizeMb = (archiveSize / 1024 / 1024).toFixed(1);
      context.onLog(`  Transferring ${sizeMb} MB...`);

      // Download from source → upload to target
      await context.source.download(remoteTar, localTmp);

      context.onProgress({
        stepIndex: 0,
        percent: Math.round(((vi + 0.5) / volumes.length) * 100),
        message: `Uploading ${vol.name} to target`,
      });

      await context.target.upload(localTmp, remoteTar);

      // Extract on target
      context.onLog(`  Extracting on target...`);
      const extractResult = await context.target.exec(
        `mkdir -p ${targetPath} && tar xzf ${remoteTar} -C ${targetPath}`,
      );
      if (extractResult.code !== 0) {
        return {
          success: false,
          error: `Failed to extract volume ${vol.name} on target: ${extractResult.stderr}`,
          duration: Date.now() - start,
        };
      }

      // Clean up
      await context.source.exec(`rm -f ${remoteTar}`);
      await context.target.exec(`rm -f ${remoteTar}`);
      try {
        const { unlinkSync } = await import("node:fs");
        unlinkSync(localTmp);
      } catch {}

      context.onProgress({
        stepIndex: 0,
        percent: Math.round(((vi + 1) / volumes.length) * 100),
        message: `Volume ${vol.name} synced`,
      });

      context.onLog(`  Volume ${vol.name} synced`);
    }

    return { success: true, duration: Date.now() - start };
  },

  async estimate(_step: Step, context: MigrationContext): Promise<TimeEstimate> {
    const totalBytes = context.plan.volumes.reduce((sum, v) => sum + v.sizeBytes, 0);
    const seconds = Math.max(30, Math.ceil(totalBytes / (10 * 1024 * 1024))); // assume 10MB/s
    return { seconds, description: `~${Math.ceil(seconds / 60)} min` };
  },
};
