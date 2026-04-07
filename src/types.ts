// === Server & Plan ===

export interface ServerConfig {
  host: string; // user@hostname
  compose_file?: string; // source only
  compose_dir?: string; // target only
  project_name?: string; // Docker Compose project name (ensures matching volume names)
}

export interface Service {
  name: string;
  image: string;
  type?: "postgres" | "mysql" | "redis" | "mongo";
  version?: string;
  volumes: string[];
}

export interface Step {
  name: string;
  type:
    | "rsync"
    | "postgres_dump"
    | "postgres_restore"
    | "mysql_dump"
    | "mysql_restore"
    | "redis_dump"
    | "redis_restore"
    | "mongo_dump"
    | "mongo_restore"
    | "compose_down"
    | "compose_up"
    | "compose_copy"
    | "http_check"
    | "container_check";
  // Optional fields used by specific step types
  service?: string;
  method?: string;
  live?: boolean;
  url?: string;
  expect?: string | number;
}

export interface MigrationPlan {
  version: number;
  source: ServerConfig;
  target: ServerConfig;
  services: Service[];
  steps: Step[];
}

// === SSH ===

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface SshClient {
  exec(command: string): Promise<ExecResult>;
  execStream(
    command: string,
    onStdout: (chunk: string) => void,
    onStderr?: (chunk: string) => void,
  ): Promise<ExecResult>;
  upload(localPath: string, remotePath: string): Promise<void>;
  download(remotePath: string, localPath: string): Promise<void>;
  readFile(remotePath: string): Promise<string>;
  writeFile(remotePath: string, content: string): Promise<void>;
  close(): Promise<void>;
}

// === Migrators ===

export interface MigrationContext {
  source: SshClient;
  target: SshClient;
  plan: MigrationPlan;
  sudoPassword?: string;
  onProgress: (event: ProgressEvent) => void;
  onLog: (message: string) => void;
}

export interface ProgressEvent {
  stepIndex: number;
  percent: number;
  message: string;
  bytesTransferred?: number;
  bytesTotal?: number;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export interface StepResult {
  success: boolean;
  error?: string;
  duration: number;
}

export interface TimeEstimate {
  seconds: number;
  description: string;
}

export interface Migrator {
  type: Step["type"];
  validate(step: Step, context: MigrationContext): Promise<ValidationResult>;
  execute(step: Step, context: MigrationContext): Promise<StepResult>;
  estimate(step: Step, context: MigrationContext): Promise<TimeEstimate>;
}

// === Analysis ===

export interface AnalysisResult {
  composePath: string;
  projectName: string;
  services: Service[];
  volumes: VolumeInfo[];
  databases: DatabaseInfo[];
}

export interface VolumeInfo {
  name: string;
  driver: string;
  mountpoint: string;
  sizeBytes: number;
}

export interface DatabaseInfo {
  serviceName: string;
  type: "postgres" | "mysql" | "redis" | "mongo";
  version: string;
  containerName: string;
}

// === Server Validation ===

export interface ServerCheck {
  name: string;
  status: "pass" | "fail" | "warn";
  message: string;
  fix?: string;
}

export type PermissionLevel =
  | "root"
  | "docker_group"
  | "sudo_nopasswd"
  | "sudo_passwd"
  | "unprivileged";
