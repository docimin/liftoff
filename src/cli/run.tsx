import { readFileSync } from "node:fs";
import { Box, render, Text, useApp } from "ink";
import { useEffect, useState } from "react";
import { Executor } from "../executor/index";
import { createDefaultRegistry } from "../migrators/registry";
import { parsePlanYaml } from "../planner/yaml";
import { connectServerInteractive } from "../ssh/connect";
import type { MigrationPlan, ProgressEvent, SshClient, StepResult } from "../types";
import { detectTerminal } from "./terminal";

// === Ink Dashboard Component ===

interface DashboardProps {
  plan: MigrationPlan;
  executor: Executor;
  sourceConn: SshClient;
  targetConn: SshClient;
}

interface StepStatus {
  state: "pending" | "running" | "done" | "failed";
  result?: StepResult;
}

function Dashboard({ plan, executor, sourceConn, targetConn }: DashboardProps) {
  const { exit } = useApp();
  const [stepStatuses, setStepStatuses] = useState<StepStatus[]>(
    plan.steps.map(() => ({ state: "pending" })),
  );
  const [logs, setLogs] = useState<string[]>([]);
  const [progress, setProgress] = useState<ProgressEvent | null>(null);
  const [result, setResult] = useState<{ success: boolean; error?: string } | null>(null);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    (async () => {
      const execResult = await executor.execute(plan, {
        source: sourceConn,
        target: targetConn,
        onLog: (msg) => setLogs((prev) => [...prev.slice(-50), msg]),
        onProgress: (event) => setProgress(event),
        onStepStart: (i) => {
          setStepStatuses((prev) => {
            const next = [...prev];
            next[i] = { state: "running" };
            return next;
          });
        },
        onStepComplete: (i, stepResult) => {
          setStepStatuses((prev) => {
            const next = [...prev];
            next[i] = {
              state: stepResult.success ? "done" : "failed",
              result: stepResult,
            };
            return next;
          });
        },
      });

      setResult({ success: execResult.success, error: execResult.error });

      // Clean up SSH connections
      await sourceConn.close();
      await targetConn.close();

      // Exit after showing result for a moment
      setTimeout(() => exit(), 1000);
    })();
  }, [targetConn.close, sourceConn, plan, targetConn, exit, executor.execute]);

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`;
  };

  const statusIcon = (state: StepStatus["state"]) => {
    switch (state) {
      case "pending":
        return "○";
      case "running":
        return "●";
      case "done":
        return "✓";
      case "failed":
        return "✗";
    }
  };

  const statusColor = (state: StepStatus["state"]) => {
    switch (state) {
      case "pending":
        return "gray";
      case "running":
        return "yellow";
      case "done":
        return "green";
      case "failed":
        return "red";
    }
  };

  return (
    <Box flexDirection="column" padding={1}>
      {/* Header */}
      <Box marginBottom={1}>
        <Text bold color="magenta">
          ⚡ Liftoff Migration
        </Text>
        <Text color="gray">
          {" "}
          — {plan.source.host} → {plan.target.host} —{" "}
        </Text>
        <Text color="cyan">{formatTime(elapsed)}</Text>
      </Box>

      {/* Steps */}
      <Box flexDirection="column" marginBottom={1}>
        {plan.steps.map((step, i) => (
          <Box key={i}>
            <Text color={statusColor(stepStatuses[i].state)}>
              {" "}
              {statusIcon(stepStatuses[i].state)} {step.name}
            </Text>
            {stepStatuses[i].result && (
              <Text color="gray"> ({(stepStatuses[i].result!.duration / 1000).toFixed(1)}s)</Text>
            )}
          </Box>
        ))}
      </Box>

      {/* Progress bar */}
      {progress && (
        <Box marginBottom={1}>
          <Text color="yellow">
            {" "}
            [{progressBar(progress.percent)}] {progress.percent}% — {progress.message}
          </Text>
        </Box>
      )}

      {/* Log */}
      <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
        <Text color="gray" dimColor>
          Log:
        </Text>
        {logs.slice(-8).map((log, i) => (
          <Text key={i} color="gray" wrap="truncate">
            {log}
          </Text>
        ))}
      </Box>

      {/* Result */}
      {result && (
        <Box marginTop={1}>
          {result.success ? (
            <Text bold color="green">
              ✓ Migration complete!
            </Text>
          ) : (
            <Text bold color="red">
              ✗ Migration failed: {result.error}
            </Text>
          )}
        </Box>
      )}
    </Box>
  );
}

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

  // Choose renderer based on terminal capabilities
  const terminal = detectTerminal();

  if (terminal.isModernTerminal && process.stdout.isTTY) {
    const { waitUntilExit } = render(
      <Dashboard plan={plan} executor={executor} sourceConn={sourceConn} targetConn={targetConn} />,
    );
    await waitUntilExit();
  } else {
    await runFallback(plan, executor, sourceConn, targetConn);
  }
}
