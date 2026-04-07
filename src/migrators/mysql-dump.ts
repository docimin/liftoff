import type {
  MigrationContext,
  Migrator,
  Step,
  StepResult,
  TimeEstimate,
  ValidationResult,
} from "../types";

const DUMP_PATH = "/tmp/liftoff-mysql-dump.sql";

export const mysqlDumpMigrator: Migrator = {
  type: "mysql_dump",

  async validate(step: Step, context: MigrationContext): Promise<ValidationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];
    const service = step.service;

    if (!service) {
      errors.push("No service specified for mysql_dump step");
      return { valid: false, errors, warnings };
    }

    // Check the service exists in the plan
    const svc = context.plan.services.find((s) => s.name === service);
    if (!svc) {
      errors.push(`Service '${service}' not found in plan`);
    }

    return { valid: errors.length === 0, errors, warnings };
  },

  async execute(step: Step, context: MigrationContext): Promise<StepResult> {
    const start = Date.now();
    const service = step.service!;
    const composePath = context.plan.source.compose_file!;

    // Clean up any leftover dump file from a previous run
    await context.source.exec(`rm -f ${DUMP_PATH}`);

    context.onLog(`Dumping MySQL database from ${service}...`);

    // Run mysqldump inside the container — captures all databases
    // Wrap in sh -c with quoted $MYSQL_ROOT_PASSWORD to avoid shell expansion issues
    const dumpResult = await context.source.exec(
      `docker compose -f ${composePath} exec -T ${service} sh -c 'mysqldump --all-databases -u root -p"$MYSQL_ROOT_PASSWORD"' > ${DUMP_PATH}`,
    );

    if (dumpResult.code !== 0) {
      return {
        success: false,
        error: `mysqldump failed: ${dumpResult.stderr}`,
        duration: Date.now() - start,
      };
    }

    // Check dump file size
    const sizeResult = await context.source.exec(
      `stat -c%s ${DUMP_PATH} 2>/dev/null || stat -f%z ${DUMP_PATH}`,
    );
    const sizeBytes = parseInt(sizeResult.stdout.trim(), 10);
    context.onLog(`Database dump complete: ${(sizeBytes / 1024 / 1024).toFixed(1)} MB`);

    return { success: true, duration: Date.now() - start };
  },

  async estimate(): Promise<TimeEstimate> {
    return { seconds: 60, description: "~1 min (depends on DB size)" };
  },
};

export { DUMP_PATH };
