import { readFileSync } from "node:fs";
import { Executor } from "../executor/index";
import { createDefaultRegistry } from "../migrators/registry";
import { parsePlanYaml } from "../planner/yaml";
import { connectServerInteractive } from "../ssh/connect";
import type { MigrationPlan, SshClient } from "../types";

function progressBar(percent: number): string {
  const width = 30;
  const filled = Math.round((percent / 100) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

// === Fallback renderer for legacy terminals ===

async function runFallback(
  plan: MigrationPlan,
  executor: Executor,
  sourceConn: SshClient,
  targetConn: SshClient,
): Promise<void> {
  console.log(`\nLiftoff Migration: ${plan.source.host} → ${plan.target.host}\n`);

  const result = await executor.execute(plan, {
    source: sourceConn,
    target: targetConn,
    onLog: (msg) => console.log(`  ${msg}`),
    onProgress: (event) => {
      process.stdout.write(
        `\r  [${progressBar(event.percent)}] ${event.percent}% — ${event.message}`,
      );
    },
    onStepStart: (i) => {
      console.log(`\n[${i + 1}/${plan.steps.length}] ${plan.steps[i].name}...`);
    },
    onStepComplete: (_i, stepResult) => {
      const icon = stepResult.success ? "✓" : "✗";
      console.log(`  ${icon} Done (${(stepResult.duration / 1000).toFixed(1)}s)`);
    },
    onStepFailed: async (_i, error) => {
      console.error(`\n  ✗ Step failed: ${error}\n`);
      const { select } = await import("@clack/prompts");
      const action = await select({
        message: "What would you like to do?",
        options: [
          { value: "retry", label: "Retry this step" },
          { value: "skip", label: "Skip and continue" },
          { value: "abort", label: "Abort migration" },
        ],
      });
      if (typeof action === "symbol") return "abort"; // user cancelled
      return action as "retry" | "skip" | "abort";
    },
  });

  await sourceConn.close();
  await targetConn.close();

  if (result.success) {
    console.log("\n✓ Migration complete!\n");
  } else {
    console.error(
      `\n✗ Migration failed at step ${(result.failedStep ?? 0) + 1}: ${result.error}\n`,
    );
    process.exit(1);
  }
}

// === Entry point ===

export async function runMigration(planPath: string): Promise<void> {
  const yamlContent = readFileSync(planPath, "utf-8");
  const plan = parsePlanYaml(yamlContent);

  console.log("Connecting to servers...");

  let sourceConn: SshClient;
  let targetConn: SshClient;

  try {
    sourceConn = await connectServerInteractive(plan.source.host);
    targetConn = await connectServerInteractive(plan.target.host);
  } catch (err) {
    console.error(`Connection failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  const registry = createDefaultRegistry();
  const executor = new Executor(registry);

  // Check for previous migration on target
  if (plan.target.compose_dir) {
    const composeDir = plan.target.compose_dir;
    const projectFlag = plan.source.project_name ? ` -p ${plan.source.project_name}` : "";

    const targetCheck = await targetConn.exec(
      `cd ${composeDir} && docker compose${projectFlag} ps -a --format '{{.Name}}' 2>/dev/null`,
    );
    const targetHasContainers = targetCheck.code === 0 && targetCheck.stdout.trim().length > 0;

    if (targetHasContainers) {
      const p = await import("@clack/prompts");
      const action = await p.select({
        message: "A previous migration was detected on the target server.",
        options: [
          { value: "continue", label: "Continue where left off" },
          {
            value: "restart",
            label: "Start fresh (removes target containers and volumes)",
          },
          { value: "cancel", label: "Cancel" },
        ],
      });

      if (p.isCancel(action) || action === "cancel") {
        await sourceConn.close();
        await targetConn.close();
        process.exit(0);
      }

      if (action === "restart") {
        console.log("Cleaning up target...");
        await targetConn.exec(`cd ${composeDir} && docker compose${projectFlag} down -v 2>&1`);
        // Re-create volumes for fresh start
        await targetConn.exec(`cd ${composeDir} && docker compose${projectFlag} create 2>&1`);
        console.log("Target cleaned up.");
      }
    }
  }

  // Pre-flight: check source stack is running
  if (plan.source.compose_file) {
    const composeDir = plan.source.compose_file.replace(/\/[^/]+$/, "");

    // Check running containers (combine stdout+stderr since docker compose
    // writes warnings to stderr even on success)
    const psResult = await sourceConn.exec(
      `cd ${composeDir} && docker compose ps --status running --format '{{.Name}}' 2>&1`,
    );

    const runningContainers = psResult.stdout
      .trim()
      .split("\n")
      .filter((l) => l && !l.startsWith("time=") && !l.includes("level=warning"));

    if (runningContainers.length === 0) {
      const p = await import("@clack/prompts");
      const start = await p.confirm({
        message: "Source stack is not running. Start it before migrating?",
      });

      if (p.isCancel(start) || !start) {
        console.log("Cannot migrate a stopped stack. Please start it and try again.");
        await sourceConn.close();
        await targetConn.close();
        process.exit(1);
      }

      console.log("Starting source stack...");
      // docker compose writes progress to stderr — only check exit code
      const upResult = await sourceConn.exec(`cd ${composeDir} && docker compose up -d 2>&1`);
      if (upResult.code !== 0) {
        // Filter out warnings, show only real errors
        const errors = upResult.stdout
          .split("\n")
          .filter((l) => l.includes("Error") || l.includes("error") || l.includes("failed"))
          .join("\n");
        console.error(`Failed to start source stack:\n${errors || upResult.stdout}`);
        await sourceConn.close();
        await targetConn.close();
        process.exit(1);
      }

      // Wait for services to be healthy
      console.log("Waiting for services to start...");
      const maxWait = 60;
      for (let i = 0; i < maxWait; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const check = await sourceConn.exec(
          `cd ${composeDir} && docker compose ps --status running --format '{{.Name}}' 2>&1`,
        );
        const states = check.stdout
          .trim()
          .split("\n")
          .filter((l) => l && !l.startsWith("time=") && !l.includes("level=warning"));
        if (states.length > 0) {
          console.log(`Source stack is running (${states.length} services).`);
          break;
        }
        if (i === maxWait - 1) {
          console.error("Timed out waiting for source stack to start.");
          await sourceConn.close();
          await targetConn.close();
          process.exit(1);
        }
      }
    } else {
      console.log(`Source stack running (${runningContainers.length} services).`);
    }
  }

  // Pre-flight validation
  console.log("Validating plan...");
  const validation = await executor.validate(plan, {
    source: sourceConn,
    target: targetConn,
    onLog: () => {},
    onProgress: () => {},
  });

  if (!validation.valid) {
    console.error("Pre-flight validation failed:");
    validation.stepErrors.forEach((err, i) => {
      if (err) console.error(`  Step ${i + 1} (${plan.steps[i].name}): ${err}`);
    });
    await sourceConn.close();
    await targetConn.close();
    process.exit(1);
  }

  // Always use fallback renderer — it supports retry/skip/abort and is more reliable.
  // The Ink dashboard can be re-enabled later when it fully supports failure handling.
  await runFallback(plan, executor, sourceConn, targetConn);
}
