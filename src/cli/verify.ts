import { readFileSync } from "node:fs";
import { createDefaultRegistry } from "../migrators/registry";
import { parsePlanYaml } from "../planner/yaml";
import { connectServerInteractive } from "../ssh/connect";
import type { SshClient, Step } from "../types";

export async function runVerify(planPath: string): Promise<void> {
  const yamlContent = readFileSync(planPath, "utf-8");
  const plan = parsePlanYaml(yamlContent);

  // Filter to only health check steps
  const checkSteps = plan.steps.filter(
    (s): s is Step => s.type === "http_check" || s.type === "container_check",
  );

  if (checkSteps.length === 0) {
    console.log("No health checks found in the plan.");
    return;
  }

  console.log(`Running ${checkSteps.length} health check(s)...\n`);

  // Connect to target server
  let targetConn: SshClient;
  try {
    targetConn = await connectServerInteractive(plan.target.host);
  } catch (err) {
    console.error(`Could not connect to target: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  const registry = createDefaultRegistry();
  let allPassed = true;

  // Run checks manually (not through executor, since we only want check steps)
  for (const step of checkSteps) {
    const migrator = registry.resolve(step.type);
    const context = {
      source: targetConn, // source not needed for checks, but interface requires it
      target: targetConn,
      plan,
      onProgress: () => {},
      onLog: (msg: string) => console.log(`  ${msg}`),
    };

    const result = await migrator.execute(step, context);

    if (result.success) {
      console.log(`  ✓ ${step.name}`);
    } else {
      console.log(`  ✗ ${step.name}: ${result.error}`);
      allPassed = false;
    }
  }

  await targetConn.close();

  console.log();
  if (allPassed) {
    console.log("All checks passed!");
  } else {
    console.log("Some checks failed. Review the output above.");
    process.exit(1);
  }
}
