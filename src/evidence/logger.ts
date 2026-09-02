import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { redactDeep } from "../policy/redact.js";

export interface LogEvent {
  kind: string;
  [key: string]: unknown;
}

export class RunLogger {
  private readonly file: string;

  /**
   * Public because a `ReplayResult` carries `evidence.runId` — the key that
   * ties a returned result back to the trail that explains it. A correlation
   * id is not a secret, and `path()` beside it is already public.
   */
  constructor(readonly runId: string, dir = "evidence") {
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
