import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runCommand } from "../core/git.mjs";
import { POLICY_PATH } from "../core/policy.mjs";
import { createProjectPorts, registerOperation } from "../integrate/ports.mjs";
import { createIntegrationRun } from "../integrate/engine.mjs";

export const PASS_COMMAND = { name: "pass", command: "node", args: ["-e", "process.exit(0)"], timeoutSeconds: 120 };
export const FAIL_COMMAND = { name: "fail", command: "node", args: ["-e", "process.exit(3)"], timeoutSeconds: 120 };
export const MUTATE_COMMAND = {
  name: "mutate",
  command: "node",
  args: ["-e", "require('fs').appendFileSync('src/base.txt','mutated')"],
  timeoutSeconds: 120,
};

export function defaultPolicy(overrides = {}) {
  return {
    version: 1,
    lock: { waitSeconds: 0, staleMinutes: 1 },
    verify: [PASS_COMMAND],
    guardPaths: [POLICY_PATH],
    ...overrides,
  };
}

export async function makeTempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** Windows では削除直後に子プロセスがディレクトリを掴んでいることがあるため、数回試す。 */
export async function removeTree(target, attempts = 8) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await fs.rm(target, { recursive: true, force: true });
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  return false;
}

export async function runGit(args, cwd) {
  const outcome = await runCommand("git", args, { cwd });
  if (outcome.code !== 0) {
    throw new Error(`git ${args.join(" ")} が失敗しました (exit=${outcome.code}): ${outcome.stderr}`);
  }
  return String(outcome.stdout ?? "").trim();
}

export async function runGitAllow(args, cwd) {
  return runCommand("git", args, { cwd });
}

export async function writeFile(root, relative, content) {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, "utf8");
  return file;
}

export async function commitAll(cwd, message) {
  await runGit(["-C", cwd, "add", "-A"], cwd);
  await runGit(
    ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "-m", message],
    cwd,
  );
  return runGit(["-C", cwd, "rev-parse", "HEAD"], cwd);
}

export async function createFixture(options = {}) {
  const repoRoot = await makeTempDir("integrate-task-repo-");
  const home = await makeTempDir("integrate-task-home-");
  const outer = path.dirname(repoRoot);
  const env = { ...process.env, INTEGRATE_TASK_HOME: home };

  await runGit(["init", "-q", "-b", "main", repoRoot], outer);
  await runGit(["-C", repoRoot, "config", "core.autocrlf", "false"], outer);
  await runGit(["-C", repoRoot, "config", "core.safecrlf", "false"], outer);
  await writeFile(repoRoot, POLICY_PATH, `${JSON.stringify(options.policy ?? defaultPolicy(), null, 2)}\n`);
  await writeFile(repoRoot, "src/base.txt", "base\n");
  await writeFile(repoRoot, "src/guarded.txt", "guarded\n");
  await commitAll(repoRoot, "initial");

  await runGit(["-C", repoRoot, "checkout", "-q", "-b", "child"], outer);
  const childFiles = options.childFiles ?? { "src/child.txt": "child\n" };
  for (const [relative, content] of Object.entries(childFiles)) {
    await writeFile(repoRoot, relative, content);
  }
  const submittedHead = await commitAll(repoRoot, options.childMessage ?? "child work");

  await runGit(["-C", repoRoot, "checkout", "-q", "main"], outer);
  const mainFiles = options.mainFiles ?? {};
  for (const [relative, content] of Object.entries(mainFiles)) {
    await writeFile(repoRoot, relative, content);
  }
  if (Object.keys(mainFiles).length > 0) {
    await commitAll(repoRoot, options.mainMessage ?? "main work");
  }
  const expectedTargetHead = await runGit(["-C", repoRoot, "rev-parse", "HEAD"], outer);

  return {
    repoRoot,
    home,
    env,
    submittedHead,
    expectedTargetHead,
    ports: createProjectPorts({ env }),

    async register(operationId, extra = {}) {
      return registerOperation(
        {
          operationId,
          submittedHead,
          repoPath: repoRoot,
          targetBranch: "main",
          targetWorktree: repoRoot,
          expectedTargetHead,
          ...extra,
        },
        { env },
      );
    },

    async head(ref = "HEAD") {
      return runGit(["-C", repoRoot, "rev-parse", ref], outer);
    },

    /** child ブランチへ追加コミットを積み、main に戻る。 */
    async advanceChild(files, message = "child work 2") {
      await runGit(["-C", repoRoot, "checkout", "-q", "child"], outer);
      for (const [relative, content] of Object.entries(files)) {
        await writeFile(repoRoot, relative, content);
      }
      const head = await commitAll(repoRoot, message);
      await runGit(["-C", repoRoot, "checkout", "-q", "main"], outer);
      return head;
    },

    async commitOnMain(files, message = "main work 2") {
      for (const [relative, content] of Object.entries(files)) {
        await writeFile(repoRoot, relative, content);
      }
      return commitAll(repoRoot, message);
    },

    async parents(rev) {
      const line = await runGit(["-C", repoRoot, "rev-list", "--parents", "-n", "1", rev], outer);
      return line.split(/\s+/).slice(1);
    },

    async isAncestor(ancestor, descendant) {
      const outcome = await runGitAllow(["-C", repoRoot, "merge-base", "--is-ancestor", ancestor, descendant], outer);
      return outcome.code === 0;
    },

    async dispose() {
      await removeTree(home);
      await removeTree(repoRoot);
    },
  };
}

export async function runWorkflow(fixture, operationId, mode, options = {}) {
  const ports = options.ports ?? createProjectPorts({ env: fixture.env });
  const run = createIntegrationRun(ports);
  return run({ args: { operationId, mode }, signal: options.signal });
}
