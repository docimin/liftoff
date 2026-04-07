import type {
  MigrationContext,
  Migrator,
  Step,
  StepResult,
  TimeEstimate,
  ValidationResult,
} from "../types";

export const containerCheckMigrator: Migrator = {
  type: "container_check",

  async validate(step: Step): Promise<ValidationResult> {
    const errors: string[] = [];
    if (!step.service) errors.push("No service specified for container_check");
    return { valid: errors.length === 0, errors, warnings: [] };
  },

  async execute(step: Step, context: MigrationContext): Promise<StepResult> {
    const start = Date.now();
    const service = step.service!;
    const targetDir = context.plan.target.compose_dir!;
    const expected = String(step.expect ?? "running");

    context.onLog(`Checking container ${service}...`);

    const projectFlag = context.plan.source.project_name
      ? ` -p ${context.plan.source.project_name}`
      : "";
    const result = await context.target.exec(
      `cd ${targetDir} && docker compose${projectFlag} ps ${service} --format '{{.State}}'`,
    );

    const state = result.stdout.trim().toLowerCase();

    if (state.includes(expected)) {
      context.onLog(`Container ${service}: ${state}`);
      return { success: true, duration: Date.now() - start };
    }

    return {
      success: false,
      error: `Container ${service} is '${state}', expected '${expected}'`,
      duration: Date.now() - start,
    };
  },

  async estimate(): Promise<TimeEstimate> {
    return { seconds: 5, description: "~5 sec" };
  },
};
