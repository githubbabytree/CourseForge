import { execFileSync } from "node:child_process";

try {
  execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { stdio: "ignore" });
  execFileSync("git", ["config", "core.hooksPath", ".githooks"], { stdio: "ignore" });
  process.stdout.write("CourseForge Git hooks enabled.\n");
} catch {
  process.stdout.write("Git hooks not configured outside a Git worktree.\n");
}
