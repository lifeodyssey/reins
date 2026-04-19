"""Permission hooks for controlling tool and command execution.

5 pure functions that return {"allowed": True/False, "reason": "..."} to gate operations:
1. check_test_tampering - blocks .skip() and .only() in test files (Write/Edit only)
2. check_hollow_impl - warns if >5 "return {" in source files (Write/Edit only)
3. check_bash_whitelist - allows only specific commands
4. check_source_read - blocks .py/.ts/.tsx/.js/.jsx files (with exceptions)
5. check_force_push - blocks force push (--force or -f with push)
"""

from typing import Dict


def check_test_tampering(tool_name: str, file_path: str, content: str) -> Dict[str, object]:
    """Block .skip() and .only() in test files for Write/Edit tools only.

    Args:
        tool_name: Name of the tool (Write, Edit, Read, etc.)
        file_path: Path to the file being modified
        content: Content being written/edited

    Returns:
        {"allowed": bool, "reason": str}
    """
    # Only restrict for Write and Edit tools
    if tool_name not in ("Write", "Edit"):
        return {"allowed": True, "reason": "Tool not restricted"}

    # Only restrict test files
    is_test_file = "test" in file_path.lower() and (
        file_path.endswith(".py") or
        file_path.endswith(".ts") or
        file_path.endswith(".tsx") or
        file_path.endswith(".js") or
        file_path.endswith(".jsx")
    )

    if not is_test_file:
        return {"allowed": True, "reason": "Not a test file"}

    # Check for .skip() or .only()
    if ".skip()" in content or ".only()" in content:
        return {
            "allowed": False,
            "reason": "Test tampering detected: .skip() or .only() not allowed in test files"
        }

    return {"allowed": True, "reason": "No test tampering detected"}


def check_hollow_impl(tool_name: str, file_path: str, content: str) -> Dict[str, object]:
    """Warn if content has >5 'return {' in non-test files (Write/Edit only).

    Args:
        tool_name: Name of the tool (Write, Edit, Read, etc.)
        file_path: Path to the file being modified
        content: Content being written/edited

    Returns:
        {"allowed": True, "reason": str} with warning if hollow implementation detected
    """
    # Only restrict for Write and Edit tools
    if tool_name not in ("Write", "Edit"):
        return {"allowed": True, "reason": "Tool not restricted"}

    # Skip test files (they can have many return statements)
    is_test_file = "test" in file_path.lower()
    if is_test_file:
        return {"allowed": True, "reason": "Test file allowed to have many return statements"}

    # Count occurrences of "return {"
    return_brace_count = content.count("return {")

    if return_brace_count > 5:
        return {
            "allowed": True,
            "reason": f"Possible hollow implementation: {return_brace_count} 'return {{' statements found (>5 threshold)"
        }

    return {"allowed": True, "reason": "Implementation appears complete"}


def check_bash_whitelist(command: str) -> Dict[str, object]:
    """Allow only whitelisted bash commands.

    Whitelist:
    - gh pr diff/view/review/checks/comment
    - make test/serve/check
    - pytest
    - curl
    - wget

    Args:
        command: The bash command to execute

    Returns:
        {"allowed": bool, "reason": str}
    """
    command_stripped = command.strip()

    # Whitelist patterns
    whitelisted = [
        ("gh pr diff", "GitHub PR diff"),
        ("gh pr view", "GitHub PR view"),
        ("gh pr review", "GitHub PR review"),
        ("gh pr checks", "GitHub PR checks"),
        ("gh pr comment", "GitHub PR comment"),
        ("make test", "Make test"),
        ("make serve", "Make serve"),
        ("make check", "Make check"),
        ("pytest", "Pytest"),
        ("curl ", "Curl"),
        ("wget ", "Wget"),
    ]

    for pattern, description in whitelisted:
        if command_stripped.startswith(pattern):
            return {"allowed": True, "reason": f"Allowed: {description}"}

    return {
        "allowed": False,
        "reason": f"Command '{command}' is not allowed. Whitelist: gh pr (diff/view/review/checks/comment), make (test/serve/check), pytest, curl, wget"
    }


def check_source_read(file_path: str) -> Dict[str, object]:
    """Block reading source code files (.py/.ts/.tsx/.js/.jsx).

    Exceptions: docs/, CLAUDE.md, AGENTS.md, README, testing-strategy

    Args:
        file_path: Path to the file being read

    Returns:
        {"allowed": bool, "reason": str}
    """
    source_extensions = (".py", ".ts", ".tsx", ".js", ".jsx")

    # Check if file has a source extension
    has_source_ext = any(file_path.endswith(ext) for ext in source_extensions)

    if not has_source_ext:
        return {"allowed": True, "reason": "Not a source code file"}

    # Allowed paths/files
    allowed_patterns = [
        "docs/",
        "CLAUDE.md",
        "AGENTS.md",
        "README",
        "testing-strategy",
    ]

    for pattern in allowed_patterns:
        if pattern in file_path:
            return {"allowed": True, "reason": f"Allowed exception: contains '{pattern}'"}

    return {
        "allowed": False,
        "reason": "Cannot read source code files. Exceptions: docs/, CLAUDE.md, AGENTS.md, README, testing-strategy"
    }


def check_force_push(command: str) -> Dict[str, object]:
    """Block force push commands (push + --force or -f).

    Args:
        command: The git command to execute

    Returns:
        {"allowed": bool, "reason": str}
    """
    command_stripped = command.strip()

    # Must contain "push" to be a force push violation
    if "push" not in command_stripped:
        return {"allowed": True, "reason": "Not a push command"}

    # Check for force flags
    has_force_flag = " --force" in command_stripped or " -f" in command_stripped

    if has_force_flag:
        return {
            "allowed": False,
            "reason": "Force push (--force or -f) is not allowed"
        }

    return {"allowed": True, "reason": "Normal push allowed"}
