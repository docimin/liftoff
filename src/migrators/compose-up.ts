import type {
  MigrationContext,
  Migrator,
  Step,
  StepResult,
  TimeEstimate,
  ValidationResult,
} from "../types";

export const composeUpMigrator: Migrator = {
  type: "compose_up",

  async validate(_step: Step, context: MigrationContext): Promise<ValidationResult> {
    const errors: string[] = [];
    if (!context.plan.target.compose_dir) {
      errors.push("No target directory in plan");
    }
    return { valid: errors.length === 0, errors, warnings: [] };
  },

  async execute(step: Step, context: MigrationContext): Promise<StepResult> {
    const start = Date.now();
    const targetDir = context.plan.target.compose_dir!;
    const serviceArg = step.service ? ` ${step.service}` : "";

    context.onLog(
      step.service
        ? `Starting service ${step.service} on target...`
        : "Starting full stack on target...",
    );

    // Use source project name so volume names match the source server
    const projectFlag = context.plan.source.project_name
      ? ` -p ${context.plan.source.project_name}`
      : "";
    const result = await context.target.exec(
      `cd ${targetDir} && docker compose${projectFlag} up -d${serviceArg}`,
    );

    if (result.code !== 0) {
      return {
        success: false,
        error: `docker compose up failed: ${result.stderr}`,
        duration: Date.now() - start,
      };
    }

    // Wait briefly for container to initialize
    if (step.service) {
      await new Promise((resolve) => setTimeout(resolve, 3000));

      // Check container is running
      const check = await context.target.exec(
        `cd ${targetDir} && docker compose${projectFlag} ps ${step.service} --format '{{.State}}'`,
      );
      if (check.code === 0 && !check.stdout.includes("running")) {
        return {
          success: false,
          error: `Service ${step.service} did not start properly. State: ${check.stdout}`,
          duration: Date.now() - start,
        };
      }
    }

    context.onLog(step.service ? `Service ${step.service} started` : "Target stack started");
    return { success: true, duration: Date.now() - start };
  },

  async estimate(): Promise<TimeEstimate> {
    return { seconds: 30, description: "~30 sec" };
  },
};
