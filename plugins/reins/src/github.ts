/**
 * GitHub operations via gh and git CLI (subprocess calls).
 */

function run(cmd: string[]): { stdout: string; exitCode: number } {
  const result = Bun.spawnSync(cmd);
  return {
    stdout: result.stdout.toString().trim(),
    exitCode: result.exitCode,
  };
}

export class GitHubOps {
  createPr(branch: string, title: string, body: string): string {
    const { stdout } = run(["gh", "pr", "create", "--head", branch, "--title", title, "--body", body]);
    return stdout;
  }

  mergePr(prNumber: number): boolean {
    const { exitCode } = run(["gh", "pr", "merge", String(prNumber), "--squash", "--delete-branch"]);
    return exitCode === 0;
  }

  postComment(prNumber: number, body: string): void {
    const maxSize = 60000;
    if (body.length <= maxSize) {
      run(["gh", "pr", "comment", String(prNumber), "--body", body]);
    } else {
      for (let i = 0; i < body.length; i += maxSize) {
        run(["gh", "pr", "comment", String(prNumber), "--body", body.slice(i, i + maxSize)]);
      }
    }
  }

  getPrComments(prNumber: number): Record<string, unknown>[] {
    const { stdout } = run(["gh", "pr", "view", String(prNumber), "--json", "comments"]);
    try {
      const data = JSON.parse(stdout);
      return Array.isArray(data) ? data : [];
    } catch {
      return [];
    }
  }

  createWorktree(branch: string, base = "main"): string {
    const path = `.worktrees/${branch}`;
    run(["git", "worktree", "add", "-b", branch, path, base]);
    return path;
  }

  removeWorktree(branch: string): void {
    run(["git", "worktree", "remove", `.worktrees/${branch}`, "--force"]);
  }

  rebaseBranch(branch: string, onto = "main"): boolean {
    const path = `.worktrees/${branch}`;
    const { exitCode } = run(["git", "-C", path, "rebase", onto]);
    return exitCode === 0;
  }
}
