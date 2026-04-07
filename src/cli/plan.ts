import { writeFileSync } from "node:fs";
import { join } from "node:path";
import * as p from "@clack/prompts";
import { analyzeStack } from "../analyzer/index";
import { generatePlan, stringifyPlan } from "../planner/index";
import { SshConnection } from "../ssh/connection";
import { validateServer } from "../ssh/validation";
import type { PermissionLevel, ServerConfig } from "../types";

export async function runPlanWizard(): Promise<void> {
  p.intro("Liftoff — Migration Planner");

  // Step 1: Source server
  const sourceHost = await p.text({
    message: "Source server (where your stack is now)",
    placeholder: "root@old-server.de",
    validate: (value) => {
      if (!value?.trim()) return "Please enter a connection string";
    },
  });
  if (p.isCancel(sourceHost)) return handleCancel();

  const sourceSpinner = p.spinner();
  sourceSpinner.start("Connecting to source server...");

  let sourceConn: SshConnection;
  let sourcePermission: PermissionLevel;

  try {
    sourceConn = new SshConnection(sourceHost);
    await sourceConn.connect();

    const validation = await validateServer(sourceConn);
    sourcePermission = validation.permissionLevel;

    const failures = validation.checks.filter((c) => c.status === "fail");
    if (failures.length > 0) {
      sourceSpinner.stop("Source server has issues");
      for (const check of failures) {
        p.log.error(`${check.name}: ${check.message}`);
        if (check.fix) p.log.info(`  Fix: ${check.fix}`);
      }

      const continueAnyway = await p.confirm({
        message: "Continue anyway?",
      });
      if (p.isCancel(continueAnyway) || !continueAnyway) return handleCancel();
    } else {
      sourceSpinner.stop("Source server connected and validated");
    }
  } catch (err) {
    sourceSpinner.stop("Connection failed");
    p.log.error(err instanceof Error ? err.message : String(err));
    p.outro("Please check the connection and try again.");
    return;
  }

  // Handle sudo password if needed
  let sudoPassword: string | undefined;
  if (sourcePermission! === "sudo_passwd") {
    const passwd = await p.password({
      message: "Sudo password required for source server",
    });
    if (p.isCancel(passwd)) return handleCancel();
    sudoPassword = passwd;
    sourceConn!.setPermissionLevel("sudo_passwd", sudoPassword);
  } else {
    sourceConn!.setPermissionLevel(sourcePermission!);
  }

  // Step 2: Target server
  const targetHost = await p.text({
    message: "Target server (where you want to migrate to)",
    placeholder: "root@new-server.de",
    validate: (value) => {
      if (!value?.trim()) return "Please enter a connection string";
    },
  });
  if (p.isCancel(targetHost)) return handleCancel();

  const targetSpinner = p.spinner();
  targetSpinner.start("Connecting to target server...");

  let targetConn: SshConnection;

  try {
    targetConn = new SshConnection(targetHost);
    await targetConn.connect();

    const validation = await validateServer(targetConn);

    const failures = validation.checks.filter((c) => c.status === "fail");
    if (failures.length > 0) {
      targetSpinner.stop("Target server has issues");
      for (const check of failures) {
        p.log.error(`${check.name}: ${check.message}`);
        if (check.fix) p.log.info(`  Fix: ${check.fix}`);
      }

      const continueAnyway = await p.confirm({
        message: "Continue anyway?",
      });
      if (p.isCancel(continueAnyway) || !continueAnyway) return handleCancel();
    } else {
      targetSpinner.stop("Target server connected and validated");
    }

    // Handle target sudo
    if (validation.permissionLevel === "sudo_passwd") {
      const passwd = await p.password({
        message: "Sudo password required for target server",
      });
      if (p.isCancel(passwd)) return handleCancel();
      targetConn.setPermissionLevel("sudo_passwd", passwd);
    } else {
      targetConn.setPermissionLevel(validation.permissionLevel);
    }
  } catch (err) {
    targetSpinner.stop("Connection failed");
    p.log.error(err instanceof Error ? err.message : String(err));
    p.outro("Please check the connection and try again.");
    await sourceConn!.close();
    return;
  }

  // Step 3: Find Docker Compose files
  const findSpinner = p.spinner();
  findSpinner.start("Looking for Docker Compose files...");

  const findResult = await sourceConn!.exec(
    "find / -maxdepth 4 -name 'docker-compose.yml' -o -name 'compose.yml' 2>/dev/null | head -20",
  );
  const foundFiles = findResult.stdout.trim().split("\n").filter(Boolean);

  findSpinner.stop(`Found ${foundFiles.length} compose file(s)`);

  let composePath: string;

  if (foundFiles.length === 0) {
    const manualPath = await p.text({
      message: "No compose files found. Enter the path manually:",
      placeholder: "/opt/myapp/docker-compose.yml",
    });
    if (p.isCancel(manualPath)) return handleCancel();
    composePath = manualPath;
  } else if (foundFiles.length === 1) {
    const confirmed = await p.confirm({
      message: `Found: ${foundFiles[0]}. Use this file?`,
    });
    if (p.isCancel(confirmed)) return handleCancel();
    composePath = confirmed ? foundFiles[0] : "";
    if (!composePath) {
      const manualPath = await p.text({
        message: "Enter the compose file path:",
        placeholder: "/opt/myapp/docker-compose.yml",
      });
      if (p.isCancel(manualPath)) return handleCancel();
      composePath = manualPath;
    }
  } else {
    const selected = await p.select({
      message: "Multiple compose files found. Which one?",
      options: [
        ...foundFiles.map((f) => ({ value: f, label: f })),
        { value: "__manual__", label: "Enter path manually" },
      ],
    });
    if (p.isCancel(selected)) return handleCancel();
    if (selected === "__manual__") {
      const manualPath = await p.text({
        message: "Enter the compose file path:",
      });
      if (p.isCancel(manualPath)) return handleCancel();
      composePath = manualPath;
    } else {
      composePath = selected;
    }
  }

  // Step 4: Analyze stack
  const analyzeSpinner = p.spinner();
  analyzeSpinner.start("Analyzing Docker Compose stack...");

  const analysis = await analyzeStack(sourceConn!, composePath!);
  analyzeSpinner.stop("Stack analyzed");

  // Display findings
  p.log.info("Detected services:");
  for (const service of analysis.services) {
    const dbLabel = service.type ? ` (${service.type} ${service.version})` : "";
    p.log.success(`  ${service.name} — ${service.image}${dbLabel}`);
  }

  if (analysis.volumes.length > 0) {
    p.log.info("Volumes:");
    for (const vol of analysis.volumes) {
      const size = (vol.sizeBytes / 1024 / 1024).toFixed(1);
      p.log.message(`  ${vol.name}: ${size} MB`);
    }
  }

  if (analysis.databases.length > 0) {
    p.log.info("Databases:");
    for (const db of analysis.databases) {
      p.log.message(`  ${db.serviceName}: ${db.type} ${db.version}`);
    }
  }

  const confirmAnalysis = await p.confirm({
    message: "Does this look correct?",
  });
  if (p.isCancel(confirmAnalysis) || !confirmAnalysis) return handleCancel();

  // Step 5: Set target directory
  const sourceDir = composePath!.replace(/\/[^/]+$/, "");
  const targetDir = await p.text({
    message: "Target directory on the new server",
    initialValue: sourceDir,
  });
  if (p.isCancel(targetDir)) return handleCancel();

  // Step 6: Generate plan
  const source: ServerConfig = { host: sourceHost, compose_file: composePath! };
  const target: ServerConfig = { host: targetHost, compose_dir: targetDir };
  const plan = generatePlan(source, target, analysis);

  // Display plan
  p.log.info("Migration plan:");
  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    p.log.message(`  ${i + 1}. ${step.name} (${step.type})`);
  }

  const confirmPlan = await p.confirm({
    message: "Save this plan?",
  });
  if (p.isCancel(confirmPlan) || !confirmPlan) return handleCancel();

  // Step 7: Write plan file
  const planPath = join(process.cwd(), "liftoff-plan.yml");
  const yamlContent = stringifyPlan(plan);
  writeFileSync(planPath, yamlContent);

  p.log.success(`Plan saved to ${planPath}`);

  const runNow = await p.confirm({
    message: "Run the migration now?",
  });

  // Clean up connections
  await sourceConn!.close();
  await targetConn!.close();

  if (p.isCancel(runNow) || !runNow) {
    p.outro("Review the plan, then run: liftoff run");
  } else {
    p.outro("Starting migration...");
    // Dynamic import to avoid loading Ink upfront
    const { runMigration } = await import("./run");
    await runMigration(planPath);
  }
}

function handleCancel(): void {
  p.cancel("Operation cancelled.");
  process.exit(0);
}
