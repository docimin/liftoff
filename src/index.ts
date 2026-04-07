// Version is injected at build time via --define, falls back to package.json for dev
declare const LIFTOFF_VERSION: string | undefined;
const version: string =
  typeof LIFTOFF_VERSION !== "undefined"
    ? LIFTOFF_VERSION
    : (() => {
        const { readFileSync } = require("node:fs");
        const { join } = require("node:path");
        return JSON.parse(readFileSync(join(import.meta.dirname, "../package.json"), "utf-8"))
          .version;
      })();

const command = process.argv[2];
const args = process.argv.slice(3);

switch (command) {
  case "plan": {
    const { runPlanWizard } = await import("./cli/plan");
    await runPlanWizard();
    break;
  }
  case "run": {
    const planPath = args[0] ?? "liftoff-plan.yml";
    const { runMigration } = await import("./cli/run");
    await runMigration(planPath);
    break;
  }
  case "verify": {
    const planPath = args[0] ?? "liftoff-plan.yml";
    const { runVerify } = await import("./cli/verify");
    await runVerify(planPath);
    break;
  }
  case "--version":
  case "-v":
    console.log(`liftoff ${version}`);
    break;
  default:
    console.log(`
  Liftoff — Migrate Docker Compose stacks between servers

  Usage:
    liftoff plan                  Create a migration plan interactively
    liftoff run [plan.yml]        Execute a migration plan (default: liftoff-plan.yml)
    liftoff verify [plan.yml]     Run health checks from a plan

  Options:
    --version, -v                 Show version
    --help                        Show this help
    `);
}
