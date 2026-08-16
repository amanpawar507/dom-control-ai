// Shared test doubles. Not a *.test.ts file, so vitest collects nothing here.
import type { LogEvent, RunLogger } from "../../src/evidence/logger.js";

/** Records what was logged without writing anything to disk. */
export class StubLogger {
  readonly events: LogEvent[] = [];

  log(event: LogEvent): void {
    this.events.push(event);
  }

  path(): string {
    return "<stub>";
  }

  get kinds(): string[] {
    return this.events.map((e) => e.kind);
  }

  asLogger(): RunLogger {
    return this as unknown as RunLogger;
  }
}
