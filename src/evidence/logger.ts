import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { redactDeep } from "../policy/redact.js";

export interface LogEvent {
  kind: string;
  [key: string]: unknown;
}

export class RunLogger {
  private readonly file: string;

  constructor(private readonly runId: string, dir = "evidence") {
    const runDir = join(dir, runId);
    mkdirSync(runDir, { recursive: true });
    this.file = join(runDir, "run.jsonl");
  }

  /**
   * Redaction lives in `policy/redact`, not here. What counts as a secret and
   * how many shapes it comes in is a policy question, and the sink's job is to
   * apply that answer to every write without exception.
   */
  log(event: LogEvent): void {
    const record = { ...event, runId: this.runId, at: new Date().toISOString() };
    appendFileSync(this.file, `${JSON.stringify(redactDeep(record))}\n`, "utf8");
  }

  path(): string {
    return this.file;
  }
}
