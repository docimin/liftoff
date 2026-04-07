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

const SOURCE_DUMP_PATH = "/tmp/liftoff-mongo-dump.gz";
const REMOTE_DUMP_PATH = "/tmp/liftoff-mongo-dump.gz";

export const mongoRestoreMigrator: Migrator = {
  type: "mongo_restore",

  async validate(step: Step, _context: MigrationContext): Promise<ValidationResult> {
    const errors: string[] = [];

    if (!step.service) {
      errors.push("No service specified for mongo_restore step");
    }

    return { valid: errors.length === 0, errors, warnings: [] };
  },

  async execute(step: Step, context: MigrationContext): Promise<StepResult> {
    const start = Date.now();
    const service = step.service!;
    const targetDir = context.plan.target.compose_dir!;

    // Clean up any leftover dump files from a previous run
    await context.source.exec(`rm -f ${SOURCE_DUMP_PATH}`);
    await context.target.exec(`rm -f ${REMOTE_DUMP_PATH}`);

    context.onLog("Copying database dump to target server...");

    // Relay dump file through the liftoff process using SFTP
    const localTmp = join(tmpdir(), "liftoff-mongo-dump.gz");
    await context.source.download(SOURCE_DUMP_PATH, localTmp);
    await context.target.upload(localTmp, REMOTE_DUMP_PATH);

    // Clean up local temp file
    try {
      const { unlinkSync } = await import("node:fs");
      unlinkSync(localTmp);
    } catch {
      // ignore cleanup errors
    }

    context.onLog(`Restoring MongoDB to ${service}...`);

    const projectFlag = context.plan.source.project_name
      ? ` -p ${context.plan.source.project_name}`
      : "";

    // Restore using mongorestore — pipe from stdin so the archive stays on host filesystem
    const restoreResult = await context.target.exec(
      `cd ${targetDir} && docker compose${projectFlag} exec -T ${service} sh -c 'mongorestore --archive --gzip --drop' < ${REMOTE_DUMP_PATH}`,
    );

    if (restoreResult.code !== 0) {
      return {
        success: false,
        error: `mongorestore failed: ${restoreResult.stderr}`,
        duration: Date.now() - start,
      };
    }

    // Clean up dump files
    await context.source.exec(`rm -f ${SOURCE_DUMP_PATH}`);
    await context.target.exec(`rm -f ${REMOTE_DUMP_PATH}`);

    context.onLog("Database restored successfully");
    return { success: true, duration: Date.now() - start };
  },

  async estimate(): Promise<TimeEstimate> {
    return { seconds: 120, description: "~2 min (depends on DB size)" };
  },
};
