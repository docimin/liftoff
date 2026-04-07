import type {
  MigrationContext,
  Migrator,
  Step,
  StepResult,
  TimeEstimate,
  ValidationResult,
} from "../types";

export const redisDumpMigrator: Migrator = {
  type: "redis_dump",

  async validate(step: Step, context: MigrationContext): Promise<ValidationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];
    const service = step.service;

    if (!service) {
      errors.push("No service specified for redis_dump step");
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

    context.onLog(`Triggering Redis BGSAVE on ${service}...`);

    // Check if Redis container is running before attempting BGSAVE
    const psCheck = await context.source.exec(
      `docker compose -f ${composePath} ps --status running --format '{{.Name}}' ${service} 2>&1`,
    );
    const isRunning = psCheck.stdout
      .trim()
      .split("\n")
      .filter((l) => l && !l.startsWith("time=") && !l.includes("level=warning"));
    if (isRunning.length === 0) {
      context.onLog(
        `Redis container ${service} is not running — skipping BGSAVE (volume data will still be synced)`,
      );
      return { success: true, duration: Date.now() - start };
    }

    // Get LASTSAVE timestamp before triggering save
    const beforeSave = await context.source.exec(
      `docker compose -f ${composePath} exec -T ${service} redis-cli LASTSAVE`,
    );
    const lastSaveBefore = beforeSave.stdout.trim();

    // Trigger background save
    const bgsaveResult = await context.source.exec(
      `docker compose -f ${composePath} exec -T ${service} redis-cli BGSAVE`,
    );

    if (bgsaveResult.code !== 0) {
      return {
        success: false,
        error: `Redis BGSAVE failed: ${bgsaveResult.stderr}`,
        duration: Date.now() - start,
      };
    }

    // Wait for save to complete by polling LASTSAVE
    let saveComplete = false;
    for (let i = 0; i < 30; i++) {
      const afterSave = await context.source.exec(
        `docker compose -f ${composePath} exec -T ${service} redis-cli LASTSAVE`,
      );
      if (afterSave.stdout.trim() !== lastSaveBefore) {
        saveComplete = true;
        break;
      }
      // Brief wait between checks
      await context.source.exec("sleep 1");
    }

    if (!saveComplete) {
      return {
        success: false,
        error: "Redis BGSAVE did not complete within timeout",
        duration: Date.now() - start,
      };
    }

    context.onLog("Redis save complete — RDB file will be copied via volume sync");
    return { success: true, duration: Date.now() - start };
  },

  async estimate(): Promise<TimeEstimate> {
    return { seconds: 15, description: "~15 sec (triggers RDB save)" };
  },
};
