import type {
  MigrationContext,
  Migrator,
  Step,
  StepResult,
  TimeEstimate,
  ValidationResult,
} from "../types";
import { DUMP_PATH } from "./postgres-dump";

const REMOTE_DUMP_PATH = "/tmp/liftoff-pg-dump.sql";

export const postgresRestoreMigrator: Migrator = {
  type: "postgres_restore",

  async validate(step: Step, _context: MigrationContext): Promise<ValidationResult> {
    const errors: string[] = [];

    if (!step.service) {
      errors.push("No service specified for postgres_restore step");
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

    context.onLog(`Restoring PostgreSQL database to ${service}...`);

    const projectFlag = context.plan.source.project_name
      ? ` -p ${context.plan.source.project_name}`
      : "";

    // Restore using psql (pg_dumpall output is SQL)
    const restoreResult = await context.target.exec(
      `cd ${targetDir} && docker compose${projectFlag} exec -T ${service} psql -U postgres < ${REMOTE_DUMP_PATH}`,
    );

    if (restoreResult.code !== 0) {
      // Fallback: try with POSTGRES_USER
      const envRestore = await context.target.exec(
        `cd ${targetDir} && docker compose${projectFlag} exec -T ${service} sh -c 'psql -U $POSTGRES_USER' < ${REMOTE_DUMP_PATH}`,
      );
      if (envRestore.code !== 0) {
        return {
          success: false,
          error: `pg_restore failed: ${envRestore.stderr || restoreResult.stderr}`,
          duration: Date.now() - start,
        };
      }
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
