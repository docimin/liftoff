import type {
  MigrationContext,
  Migrator,
  Step,
  StepResult,
  TimeEstimate,
  ValidationResult,
} from "../types";
import { DUMP_PATH } from "./mysql-dump";

const REMOTE_DUMP_PATH = "/tmp/liftoff-mysql-dump.sql";

export const mysqlRestoreMigrator: Migrator = {
  type: "mysql_restore",

  async validate(step: Step, _context: MigrationContext): Promise<ValidationResult> {
    const errors: string[] = [];

    if (!step.service) {
      errors.push("No service specified for mysql_restore step");
    }

    return { valid: errors.length === 0, errors, warnings: [] };
  },

  async execute(step: Step, context: MigrationContext): Promise<StepResult> {
    const start = Date.now();
    const service = step.service!;
    const targetDir = context.plan.target.compose_dir!;
    const sourceHost = context.plan.source.host;

    context.onLog(`Copying database dump to target server...`);

    // Copy dump file from source to target via rsync/scp
    const copyResult = await context.target.exec(
      `rsync -az ${sourceHost}:${DUMP_PATH} ${REMOTE_DUMP_PATH}`,
    );

    if (copyResult.code !== 0) {
      // Fallback: try scp
      const scpResult = await context.target.exec(
        `scp ${sourceHost}:${DUMP_PATH} ${REMOTE_DUMP_PATH}`,
      );
      if (scpResult.code !== 0) {
        return {
          success: false,
          error: `Failed to copy dump file: ${scpResult.stderr}`,
          duration: Date.now() - start,
        };
      }
    }

    context.onLog(`Restoring MySQL database to ${service}...`);

    const projectFlag = context.plan.source.project_name
      ? ` -p ${context.plan.source.project_name}`
      : "";

    // Restore using mysql client
    const restoreResult = await context.target.exec(
      `cd ${targetDir} && docker compose${projectFlag} exec -T ${service} mysql -u root -p$MYSQL_ROOT_PASSWORD < ${REMOTE_DUMP_PATH}`,
    );

    if (restoreResult.code !== 0) {
      return {
        success: false,
        error: `mysql restore failed: ${restoreResult.stderr}`,
        duration: Date.now() - start,
      };
    }

    // Clean up dump files
    await context.source.exec(`rm -f ${DUMP_PATH}`);
    await context.target.exec(`rm -f ${REMOTE_DUMP_PATH}`);

    context.onLog("Database restored successfully");
    return { success: true, duration: Date.now() - start };
  },

  async estimate(): Promise<TimeEstimate> {
    return { seconds: 120, description: "~2 min (depends on DB size)" };
  },
};
