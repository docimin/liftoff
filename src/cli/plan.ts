import { writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import * as p from "@clack/prompts";
import { analyzeStack } from "../analyzer/index";
import { generatePlan, stringifyPlan } from "../planner/index";
import { SshConnection } from "../ssh/connection";
import { LocalClient } from "../ssh/local";
import { validateServer } from "../ssh/validation";
import type { PermissionLevel, ServerConfig, SshClient } from "../types";

/** Detect current user and hostname for the local machine */
function detectLocalServer(): { user: string; host: string; display: string } {
  const user = process.env.USER || process.env.USERNAME || "root";
  const host = hostname();
  return { user, host, display: `${user}@${host}` };
}

/** Prompt the user for a server connection, with an option to use the current machine */
async function promptServer(
  role: "source" | "target",
): Promise<{ conn: SshClient; host: string; permissionLevel: PermissionLevel } | null> {
  const local = detectLocalServer();
  const label =
    role === "source"
      ? "Source server (where your stack is now)"
      : "Target server (where you want to migrate to)";

  const useLocal =
    role === "source"
      ? await p.confirm({ message: `Use this server as ${role}? (${local.display})` })
      : null;

  if (p.isCancel(useLocal)) {
    handleCancel();
    return null;
  }

  // Local mode — run commands directly, no SSH
  if (useLocal === true) {
    const spinner = p.spinner();
    spinner.start("Validating local server...");

    const conn = new LocalClient();
    const validation = await validateServer(conn);

    const failures = validation.checks.filter((c) => c.status === "fail");
    if (failures.length > 0) {
      spinner.stop("Local server has issues");
      for (const check of failures) {
        p.log.error(`${check.name}: ${check.message}`);
        if (check.fix) p.log.info(`  Fix: ${check.fix}`);
      }
      const continueAnyway = await p.confirm({ message: "Continue anyway?" });
      if (p.isCancel(continueAnyway) || !continueAnyway) {
        handleCancel();
        return null;
      }
    } else {
      spinner.stop("Local server validated");
    }

    return { conn, host: local.display, permissionLevel: validation.permissionLevel };
  }

  // Remote mode — SSH connection
  const hostInput = await p.text({
    message: `${label} — IP address or hostname`,
    placeholder: "10.0.0.1 or server.example.com",
    validate: (v) => {
      if (!v?.trim()) return "Please enter a hostname or IP";
    },
  });
  if (p.isCancel(hostInput)) {
    handleCancel();
    return null;
  }

  const userInput = await p.text({
    message: "SSH user",
    initialValue: "root",
  });
  if (p.isCancel(userInput)) {
    handleCancel();
    return null;
  }

  const connectionString = `${userInput}@${hostInput}`;

  const spinner = p.spinner();
  spinner.start(`Connecting to ${role} server...`);

  let conn: SshConnection;
  let permissionLevel: PermissionLevel;

  try {
    conn = new SshConnection(connectionString);
    await conn.connect();

    const validation = await validateServer(conn);
    permissionLevel = validation.permissionLevel;

    const failures = validation.checks.filter((c) => c.status === "fail");
    if (failures.length > 0) {
      spinner.stop(`${role.charAt(0).toUpperCase() + role.slice(1)} server has issues`);
      for (const check of failures) {
        p.log.error(`${check.name}: ${check.message}`);
        if (check.fix) p.log.info(`  Fix: ${check.fix}`);
      }

      const continueAnyway = await p.confirm({ message: "Continue anyway?" });
      if (p.isCancel(continueAnyway) || !continueAnyway) {
        handleCancel();
        return null;
      }
    } else {
      spinner.stop(
        `${role.charAt(0).toUpperCase() + role.slice(1)} server connected and validated`,
      );
    }
  } catch (err) {
    spinner.stop("Connection failed");

    // If SSH failed, offer to enter credentials manually
    if (connectionString !== "localhost") {
      p.log.error(err instanceof Error ? err.message : String(err));

      const authMethod = await p.select({
        message: "How would you like to authenticate?",
        options: [
          { value: "key", label: "Specify SSH key path" },
          { value: "password", label: "Enter password" },
          { value: "cancel", label: "Cancel" },
        ],
      });
      if (p.isCancel(authMethod) || authMethod === "cancel") {
        handleCancel();
        return null;
      }

      let overrides: { keyPath?: string; password?: string } = {};

      if (authMethod === "key") {
        const keyPath = await p.text({
          message: "Path to SSH private key",
          placeholder: "~/.ssh/id_ed25519",
        });
        if (p.isCancel(keyPath)) {
          handleCancel();
          return null;
        }
        overrides = { keyPath: keyPath.replace(/^~/, process.env.HOME || "") };
      } else {
        const pass = await p.password({ message: "SSH password" });
        if (p.isCancel(pass)) {
          handleCancel();
          return null;
        }
        overrides = { password: pass };
      }

      const retrySpinner = p.spinner();
      retrySpinner.start("Retrying connection...");
      try {
        conn = new SshConnection(connectionString, overrides);
        await conn.connect();
        const validation = await validateServer(conn);
        permissionLevel = validation.permissionLevel;
        retrySpinner.stop(`${role.charAt(0).toUpperCase() + role.slice(1)} server connected`);
      } catch (retryErr) {
        retrySpinner.stop("Connection failed again");
        p.log.error(retryErr instanceof Error ? retryErr.message : String(retryErr));
        p.outro("Please check the connection and try again.");
        return null;
      }
    } else {
      p.log.error(err instanceof Error ? err.message : String(err));
      p.outro("Please check the connection and try again.");
      return null;
    }
  }

  // Handle sudo password if needed
  if (permissionLevel! === "sudo_passwd") {
    const passwd = await p.password({
      message: `Sudo password for ${role} server`,
    });
    if (p.isCancel(passwd)) {
      handleCancel();
      return null;
    }
    conn!.setPermissionLevel("sudo_passwd", passwd);
  } else {
    conn!.setPermissionLevel(permissionLevel!);
  }

  return { conn: conn!, host: connectionString, permissionLevel: permissionLevel! };
}

export async function runPlanWizard(): Promise<void> {
  p.intro("Liftoff — Migration Planner");

  // Step 1: Source server
  const sourceResult = await promptServer("source");
  if (!sourceResult) return;
  const { conn: sourceConn, host: sourceHost } = sourceResult;

  // Step 2: Target server
  const targetResult = await promptServer("target");
  if (!targetResult) {
    await sourceConn.close();
    return;
  }
  const { conn: targetConn, host: targetHost } = targetResult;

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
