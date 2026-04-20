/**
 * GitHub operations via gh and git CLI (subprocess calls).
 * All paths are relative to projectRoot (user's project, not plugin cache).
 */

import { join } from "node:path";

function run(cmd: string[], cwd?: string): { stdout: string; exitCode: number } {
  const result = Bun.spawnSync(cmd, cwd ? { cwd } : undefined);
  return {
    stdout: result.stdout.toString().trim(),
    exitCode: result.exitCode,
  };
}

export class GitHubOps {
  private projectRoot: string;

  constructor(projectRoot?: string) {
    this.projectRoot = projectRoot ?? process.env.REINS_PROJECT_ROOT ?? process.cwd();
  }

  createPr(branch: string, title: string, body: string): string {
    const { stdout } = run(["gh", "pr", "create", "--head", branch, "--title", title, "--body", body], this.projectRoot);
    return stdout;
  }

  mergePr(prNumber: number): boolean {
    const { exitCode } = run(["gh", "pr", "merge", String(prNumber), "--squash", "--delete-branch"], this.projectRoot);
    return exitCode === 0;
  }

  postComment(prNumber: number, body: string): void {
    const maxSize = 60000;
    if (body.length <= maxSize) {
      run(["gh", "pr", "comment", String(prNumber), "--body", body], this.projectRoot);
    } else {
      for (let i = 0; i < body.length; i += maxSize) {
        run(["gh", "pr", "comment", String(prNumber), "--body", body.slice(i, i + maxSize)], this.projectRoot);
      }
    }
  }

  getPrComments(prNumber: number): Record<string, unknown>[] {
    const { stdout } = run(["gh", "pr", "view", String(prNumber), "--json", "comments"], this.projectRoot);
    try {
      const data = JSON.parse(stdout);
      return Array.isArray(data) ? data : [];
    } catch {
      return [];
    }
  }

  createWorktree(branch: string, base = "main"): string {
    const path = join(this.projectRoot, ".worktrees", branch);
    run(["git", "worktree", "add", "-b", branch, path, base], this.projectRoot);
    return path;
  }

  removeWorktree(branch: string): void {
    const path = join(this.projectRoot, ".worktrees", branch);
    run(["git", "worktree", "remove", path, "--force"], this.projectRoot);
  }

  rebaseBranch(branch: string, onto = "main"): boolean {
    const path = join(this.projectRoot, ".worktrees", branch);
    const { exitCode } = run(["git", "-C", path, "rebase", onto]);
    return exitCode === 0;
  }
}
