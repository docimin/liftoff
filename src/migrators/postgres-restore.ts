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

const SOURCE_DUMP_PATH = "/tmp/liftoff-pg-dump.sql";
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

    // Clean up any leftover dump files from a previous run
    await context.source.exec(`rm -f ${SOURCE_DUMP_PATH}`);
    await context.target.exec(`rm -f ${REMOTE_DUMP_PATH}`);

    context.onLog("Copying database dump to target server...");

    // Relay dump file through the liftoff process using SFTP
    const localTmp = join(tmpdir(), "liftoff-pg-dump.sql");
    await context.source.download(SOURCE_DUMP_PATH, localTmp);
    await context.target.upload(localTmp, REMOTE_DUMP_PATH);

    // Clean up local temp file
    try {
      const { unlinkSync } = await import("node:fs");
      unlinkSync(localTmp);
    } catch {
      // ignore cleanup errors
    }

    context.onLog(`Restoring PostgreSQL database to ${service}...`);

    const projectFlag = context.plan.source.project_name
      ? ` -p ${context.plan.source.project_name}`
      : "";

    // Restore using psql (pg_dumpall output is SQL)
    const restoreResult = await context.target.exec(
      `cd ${targetDir} && docker compose${projectFlag} exec -T ${service} psql -U postgres < ${REMOTE_DUMP_PATH}`,
    );

    // psql may return non-zero due to "already exists" errors on re-runs — that's OK
    if (restoreResult.code !== 0) {
      const hasFatalError = restoreResult.stderr
        .split("\n")
        .some(
          (l) =>
            l.includes("ERROR") &&
            !l.includes("already exists") &&
            !l.includes("current transaction is aborted"),
        );

      if (hasFatalError) {
        // Fallback: try with POSTGRES_USER
        const envRestore = await context.target.exec(
          `cd ${targetDir} && docker compose${projectFlag} exec -T ${service} sh -c 'psql -U $POSTGRES_USER' < ${REMOTE_DUMP_PATH}`,
        );
        if (envRestore.code !== 0) {
          const envHasFatal = envRestore.stderr
            .split("\n")
            .some(
              (l) =>
                l.includes("ERROR") &&
                !l.includes("already exists") &&
                !l.includes("current transaction is aborted"),
            );
          if (envHasFatal) {
            return {
              success: false,
              error: `pg_restore failed: ${envRestore.stderr || restoreResult.stderr}`,
              duration: Date.now() - start,
            };
          }
        }
      }
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
