# Liftoff

Migrate Docker Compose stacks between servers with minimal downtime.

Liftoff analyzes your existing stack, creates an editable migration plan, and executes it with a live dashboard — handling volume sync, database dumps, service orchestration, and health checks automatically.

## Features

- **Interactive wizard** — guided setup via `liftoff plan`, no config files to write manually
- **Editable YAML plan** — review and customize every step before execution
- **Live dashboard** — real-time progress with step tracking, progress bars, and logs
- **PostgreSQL support** — automatic dump and restore via `pg_dumpall`
- **Volume sync** — rsync-based with pre-sync (live) and final delta sync for minimal downtime
- **Server validation** — checks Docker, Compose, rsync, disk space, and permissions before starting
- **Graceful failure handling** — retry, skip, or abort on any step failure
- **Plugin-ready architecture** — adding new database or service migrators is a single file

## Requirements

- [Bun](https://bun.sh) runtime (for development)
- SSH access to both source and target servers
- Docker and Docker Compose on both servers
- rsync on both servers

## Install

**Linux / macOS:**

```bash
curl -fsSL https://raw.githubusercontent.com/docimin/liftoff/main/scripts/install.sh | bash
```

**Windows:**

Download `liftoff-windows-x64.exe` from the [latest release](https://github.com/docimin/liftoff/releases) and add it to your PATH.

**From source (requires [Bun](https://bun.sh)):**

```bash
git clone https://github.com/docimin/liftoff.git
cd liftoff
bun install
bun build --compile src/index.ts --outfile liftoff
mv liftoff /usr/local/bin/
```

## Usage

### 1. Create a migration plan

```bash
liftoff plan
```

The wizard walks you through:
- Connecting to source and target servers (validates SSH, Docker, permissions)
- Finding your `docker-compose.yml`
- Analyzing services, volumes, and databases
- Generating an optimized migration plan

The plan is saved to `liftoff-plan.yml` — you can edit it before running.

### 2. Review the plan

```yaml
# liftoff-plan.yml
version: 1
source:
  host: root@old-server.de
  compose_file: /opt/nextcloud/docker-compose.yml
target:
  host: root@new-server.de
  compose_dir: /opt/nextcloud

steps:
  - name: Pre-sync volumes
    type: rsync
    live: true
  - name: Dump PostgreSQL
    type: postgres_dump
    service: nextcloud-db
  # ... more steps
```

### 3. Execute the migration

```bash
liftoff run
```

A live dashboard shows progress for each step. If anything fails, you choose: retry, skip, or abort.

### 4. Verify (optional)

```bash
liftoff verify
```

Re-runs the health checks from your plan to confirm everything is working.

## How it works

```
Your machine
  └── liftoff CLI
        ├── SSH → Source server (analyze, dump, stop)
        └── SSH → Target server (restore, start, verify)
```

Liftoff is agentless — nothing is installed on your servers. All operations happen over SSH.

**Migration phases:**

1. **Pre-sync** — rsync volumes while the source stack is still running
2. **Database dump** — `pg_dumpall` via `docker exec`
3. **Cutover** — stop source, final delta sync, start database on target, restore dump
4. **Start** — bring up the full stack on target
5. **Verify** — container and HTTP health checks

## Development

```bash
bun install
bun test          # run all tests
bun run dev       # run the CLI in dev mode
```

## Adding a new database migrator

All migrators implement the same interface and are registered in a central registry:

1. Create `src/migrators/mysql-dump.ts` implementing the `Migrator` interface
2. Register it in `src/migrators/registry.ts`
3. Add detection logic in `src/analyzer/database-detector.ts`

## License

MIT
