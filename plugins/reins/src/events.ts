/**
 * Append-only JSONL event logger for agent actions.
 */

import { existsSync, mkdirSync, appendFileSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export class EventLog {
  private path: string;

  constructor(path: string) {
    this.path = path;
  }

  append(agent: string, action: string, extra: Record<string, unknown> = {}): void {
    const dir = dirname(this.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const event = {
      ts: new Date().toISOString(),
      agent,
      action,
      ...extra,
    };
    appendFileSync(this.path, JSON.stringify(event) + "\n");
  }

  readAll(): Record<string, unknown>[] {
    if (!existsSync(this.path)) return [];

    const content = readFileSync(this.path, "utf-8");
    return content
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
  }
}
