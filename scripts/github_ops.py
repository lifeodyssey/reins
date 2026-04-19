"""GitHub operations via gh and git CLI."""

import json
import subprocess
from typing import Optional


class GitHubOps:
    """Manages GitHub operations using gh and git CLI tools."""

    def create_pr(self, branch: str, title: str, body: str) -> str:
        """
        Create a pull request on GitHub.

        Args:
            branch: Source branch name for the PR.
            title: Title of the PR.
            body: Body/description of the PR.

        Returns:
            The PR URL from stdout.
        """
        result = subprocess.run(
            ["gh", "pr", "create", "--head", branch, "--title", title, "--body", body],
            capture_output=True,
            text=True,
        )
        return result.stdout.strip()

    def merge_pr(self, pr_number: int) -> bool:
        """
        Merge a pull request using squash merge and delete the branch.

        Args:
            pr_number: The PR number to merge.

        Returns:
            True if merge succeeded (returncode == 0), False otherwise.
        """
        result = subprocess.run(
            ["gh", "pr", "merge", str(pr_number), "--squash", "--delete-branch"],
            capture_output=True,
            text=True,
        )
        return result.returncode == 0

    def post_comment(self, pr_number: int, body: str) -> None:
        """
        Post a comment on a PR, splitting into multiple comments if needed.

        GitHub has a comment size limit (~60000 chars). If body exceeds this,
        split into multiple comments.

        Args:
            pr_number: The PR number to comment on.
            body: The comment body text.
        """
        max_comment_size = 60000

        if len(body) <= max_comment_size:
            subprocess.run(
                ["gh", "pr", "comment", str(pr_number), "--body", body],
                capture_output=True,
                text=True,
            )
        else:
            # Split into multiple comments
            chunks = []
            for i in range(0, len(body), max_comment_size):
                chunks.append(body[i : i + max_comment_size])

            for chunk in chunks:
                subprocess.run(
                    ["gh", "pr", "comment", str(pr_number), "--body", chunk],
                    capture_output=True,
                    text=True,
                )

    def get_pr_comments(self, pr_number: int) -> list[dict]:
        """
        Retrieve all comments from a PR.

        Args:
            pr_number: The PR number.

        Returns:
            List of comment dictionaries parsed from JSON.
        """
        result = subprocess.run(
            ["gh", "pr", "view", str(pr_number), "--json", "comments"],
            capture_output=True,
            text=True,
        )
        comments_data = json.loads(result.stdout)
        return comments_data if isinstance(comments_data, list) else []

    def create_worktree(self, branch: str, base: str = "main") -> str:
        """
        Create a git worktree for a branch.

        Args:
            branch: The branch name for the worktree.
            base: The base branch to create from (default: "main").

        Returns:
            The path to the created worktree.
        """
        worktree_path = f".worktrees/{branch}"
        subprocess.run(
            ["git", "worktree", "add", "-b", branch, worktree_path, base],
            capture_output=True,
            text=True,
        )
        return worktree_path

    def remove_worktree(self, branch: str) -> None:
        """
        Remove a git worktree.

        Args:
            branch: The branch name associated with the worktree.
        """
        worktree_path = f".worktrees/{branch}"
        subprocess.run(
            ["git", "worktree", "remove", worktree_path, "--force"],
            capture_output=True,
            text=True,
        )

    def rebase_branch(self, branch: str, onto: str = "main") -> bool:
        """
        Rebase a branch in its worktree onto another branch.

        Args:
            branch: The branch name to rebase.
            onto: The target branch to rebase onto (default: "main").

        Returns:
            True if rebase succeeded (returncode == 0), False otherwise.
        """
        worktree_path = f".worktrees/{branch}"
        result = subprocess.run(
            ["git", "-C", worktree_path, "rebase", onto],
            capture_output=True,
            text=True,
        )
        return result.returncode == 0
