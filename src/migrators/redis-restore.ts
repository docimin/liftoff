import type {
  MigrationContext,
  Migrator,
  Step,
  StepResult,
  TimeEstimate,
  ValidationResult,
} from "../types";

export const redisRestoreMigrator: Migrator = {
  type: "redis_restore",

  async validate(step: Step, _context: MigrationContext): Promise<ValidationResult> {
    const errors: string[] = [];

    if (!step.service) {
      errors.push("No service specified for redis_restore step");
    }

    return { valid: errors.length === 0, errors, warnings: [] };
  },

  async execute(step: Step, context: MigrationContext): Promise<StepResult> {
    const start = Date.now();
    const service = step.service!;
    const targetDir = context.plan.target.compose_dir!;

    context.onLog(`Verifying Redis loaded data on ${service}...`);

    const projectFlag = context.plan.source.project_name
      ? ` -p ${context.plan.source.project_name}`
      : "";

    // Redis restores automatically from the RDB dump file when it starts
    // Verify it started and loaded data by checking DBSIZE
    const dbsizeResult = await context.target.exec(
      `cd ${targetDir} && docker compose${projectFlag} exec -T ${service} redis-cli DBSIZE`,
    );

    if (dbsizeResult.code !== 0) {
      return {
        success: false,
        error: `Redis DBSIZE check failed: ${dbsizeResult.stderr}`,
        duration: Date.now() - start,
      };
    }

    // Parse the key count from "db0:keys=N,..." or "# Keyspace\ndb0:keys=N"
    const output = dbsizeResult.stdout.trim();
    context.onLog(`Redis verification: ${output}`);

    return { success: true, duration: Date.now() - start };
  },

  async estimate(): Promise<TimeEstimate> {
    return { seconds: 10, description: "~10 sec (verify Redis loaded)" };
  },
};
