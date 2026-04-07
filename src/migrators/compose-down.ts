import type {
  MigrationContext,
  Migrator,
  Step,
  StepResult,
  TimeEstimate,
  ValidationResult,
} from "../types";

export const composeDownMigrator: Migrator = {
  type: "compose_down",

  async validate(_step: Step, context: MigrationContext): Promise<ValidationResult> {
    const errors: string[] = [];
    if (!context.plan.source.compose_file) {
      errors.push("No compose file path in plan");
    }
    return { valid: errors.length === 0, errors, warnings: [] };
  },

  async execute(_step: Step, context: MigrationContext): Promise<StepResult> {
    const start = Date.now();
    const composePath = context.plan.source.compose_file!;

    const projectFlag = context.plan.source.project_name
      ? ` -p ${context.plan.source.project_name}`
      : "";

    // Check if stack is already stopped
    const psResult = await context.source.exec(
      `docker compose -f ${composePath}${projectFlag} ps --status running --format '{{.Name}}' 2>&1`,
    );
    const running = psResult.stdout
      .trim()
      .split("\n")
      .filter((l) => l && !l.startsWith("time=") && !l.includes("level=warning"));
    if (running.length === 0) {
      context.onLog("Source stack already stopped");
      return { success: true, duration: Date.now() - start };
    }

    context.onLog("Stopping source stack...");

    const result = await context.source.exec(`docker compose -f ${composePath}${projectFlag} down`);

    if (result.code !== 0) {
      return {
        success: false,
        error: `docker compose down failed: ${result.stderr}`,
        duration: Date.now() - start,
      };
    }

    context.onLog("Source stack stopped");
    return { success: true, duration: Date.now() - start };
  },

  async estimate(): Promise<TimeEstimate> {
    return { seconds: 30, description: "~30 sec" };
  },
};
