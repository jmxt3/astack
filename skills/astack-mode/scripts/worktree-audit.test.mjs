import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { auditWorktrees } from "./worktree-audit.mjs";

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

test("auditWorktrees classifies clean merged vs dirty wip worktrees on Windows and Unix", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "astack-wt-audit-"));
  try {
    const repo = path.join(root, "repo");
    const wtMerged = path.join(root, "wt-merged");
    const wtDirty = path.join(root, "wt-dirty");
    const wtRecentChat = path.join(root, "wt-chat");
    const brainDir = path.join(root, "brain");

    fs.mkdirSync(repo, { recursive: true });
    git(repo, ["init", "-b", "main"]);
    git(repo, ["config", "user.name", "AStack Test"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    fs.writeFileSync(path.join(repo, "README.md"), "base\n", "utf8");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "init"]);

    // 1. Merged worktree
    git(repo, ["worktree", "add", "-b", "merged-branch", wtMerged, "main"]);

    // 2. Dirty WIP worktree
    git(repo, ["worktree", "add", "-b", "wip-branch", wtDirty, "main"]);
    fs.writeFileSync(path.join(wtDirty, "README.md"), "edited\n", "utf8");

    // 3. Worktree referenced by recent transcript
    git(repo, ["worktree", "add", "-b", "chat-branch", wtRecentChat, "main"]);
    git(wtRecentChat, ["commit", "--allow-empty", "-m", "unmerged feature"]);
    fs.mkdirSync(path.join(brainDir, "conv-1", ".system_generated", "logs"), { recursive: true });
    fs.writeFileSync(
      path.join(brainDir, "conv-1", ".system_generated", "logs", "transcript.jsonl"),
      JSON.stringify({ content: `Edited ${wtRecentChat}/README.md` }) + "\n",
      "utf8",
    );

    const res = auditWorktrees({
      repoPath: repo,
      baseRef: "main",
      transcriptsRoot: brainDir,
      skipPrLookup: true,
    });

    assert.equal(res.base, "main");
    assert.equal(res.rows.length, 3);

    const byPath = new Map(res.rows.map((r) => [path.basename(r.path), r]));
    assert.equal(byPath.get("wt-merged")?.merged, "YES");
    assert.equal(byPath.get("wt-merged")?.dirty, "clean");
    assert.equal(byPath.get("wt-merged")?.bucket, "safe");

    assert.equal(byPath.get("wt-dirty")?.dirty, "wip:1");
    assert.equal(byPath.get("wt-dirty")?.bucket, "hold-wip");

    assert.equal(byPath.get("wt-chat")?.merged, "no");
    assert.equal(byPath.get("wt-chat")?.bucket, "verify-recent-chat");

    // Clean up git worktree admin metadata before rmSync
    git(repo, ["worktree", "remove", "--force", wtMerged]);
    git(repo, ["worktree", "remove", "--force", wtDirty]);
    git(repo, ["worktree", "remove", "--force", wtRecentChat]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
