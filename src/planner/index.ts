import type { MigrationPlan, ServerConfig, AnalysisResult, Step } from "../types";

export function generatePlan(
  source: ServerConfig,
  target: ServerConfig,
  analysis: AnalysisResult,
): MigrationPlan {
  const steps: Step[] = [];

  // 1. Pre-sync volumes (live, while stack is still running)
  if (analysis.volumes.length > 0) {
    steps.push({
      name: "Pre-sync volumes",
      type: "rsync",
      live: true,
    });
  }

  // 2. Copy compose files to target
  steps.push({
    name: "Copy compose files",
    type: "compose_copy",
  });

  // 3. Dump databases (while stack is still running)
  for (const db of analysis.databases) {
    steps.push({
      name: `Dump PostgreSQL (${db.serviceName})`,
      type: "postgres_dump",
      service: db.serviceName,
      method: "dump_restore",
    });
  }

  // 4. Stop source stack
  steps.push({
    name: "Stop source stack",
    type: "compose_down",
  });

  // 5. Final delta sync (after stop)
  if (analysis.volumes.length > 0) {
    steps.push({
      name: "Final delta sync",
      type: "rsync",
      live: false,
    });
  }

  // 6. Start database containers on target + restore
  for (const db of analysis.databases) {
    steps.push({
      name: `Start target database (${db.serviceName})`,
      type: "compose_up",
      service: db.serviceName,
    });

    steps.push({
      name: `Restore PostgreSQL (${db.serviceName})`,
      type: "postgres_restore",
      service: db.serviceName,
    });
  }

  // 7. Start full target stack
  steps.push({
    name: "Start target stack",
    type: "compose_up",
  });

  // 8. Health checks — container check for each service
  for (const service of analysis.services) {
    steps.push({
      name: `Container check (${service.name})`,
      type: "container_check",
      service: service.name,
      expect: "running",
    });
  }

  return {
    version: 1,
    source,
    target,
    services: analysis.services,
    steps,
  };
}

export { parsePlanYaml, stringifyPlan } from "./yaml";
