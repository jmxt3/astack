import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyFrontmatterPolicy, parseFrontmatter } from "../catalog.mjs";
import { DEFAULT_ROOT_DIR, renderNativeCommandsMarkdown, validateAStack } from "../validate-astack.mjs";
import { ASTACK_ASCII_LOGO } from "../../skills/setup-astack/scripts/setup-banner.mjs";

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

test("applyFrontmatterPolicy synchronizes disable-model-invocation from scripts/catalog.json", () => {
  const tmp = makeTempDir("astack-policy-test-");
  try {
    writeFile(
      path.join(tmp, "scripts", "catalog.json"),
      JSON.stringify({ manualOnlySkills: ["manual-skill"] }),
    );
    writeFile(
      path.join(tmp, "skills", "manual-skill", "SKILL.md"),
      "---\nname: manual-skill\ndescription: manual only\n---\n\n# Manual\n",
    );
    writeFile(
      path.join(tmp, "skills", "auto-skill", "SKILL.md"),
      "---\nname: auto-skill\ndescription: auto invocable\ndisable-model-invocation: true\n---\n\n# Auto\n",
    );

    const first = applyFrontmatterPolicy(tmp);
    assert.deepEqual(first.updated.sort(), [
      "skills/auto-skill/SKILL.md",
      "skills/manual-skill/SKILL.md",
    ]);

    const manualRaw = fs.readFileSync(path.join(tmp, "skills", "manual-skill", "SKILL.md"), "utf8");
    const autoRaw = fs.readFileSync(path.join(tmp, "skills", "auto-skill", "SKILL.md"), "utf8");
    assert.match(manualRaw, /^disable-model-invocation: true$/m);
    assert.doesNotMatch(autoRaw, /^disable-model-invocation:/m);

    const second = applyFrontmatterPolicy(tmp);
    assert.deepEqual(second.updated, []);
    assert.deepEqual(second.unchanged.sort(), [
      "skills/auto-skill/SKILL.md",
      "skills/manual-skill/SKILL.md",
    ]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("validateAStack rejects collisions, frontmatter errors, oversized skills, broken links, and Cursor leaks", () => {
  const tmp = makeTempDir("astack-validate-test-");
  try {
    writeFile(
      path.join(tmp, "plugin.json"),
      JSON.stringify({
        name: "astack",
        author: { name: "João Machete" },
        logo: "assets/logo.svg",
      }),
    );
    writeFile(
      path.join(tmp, "LICENSE"),
      "Copyright (c) 2026 Lauren Tan\nCopyright (c) 2026 João Machete\n",
    );
    writeFile(path.join(tmp, "assets", "logo.svg"), "<svg/>");
    writeFile(path.join(tmp, "assets", "banner test@1x.png"), "png");
    writeFile(path.join(tmp, "README.md"), '<p><img src="./assets/banner%20test@1x.png" alt="Banner"></p>\n');
    writeFile(
      path.join(tmp, "CREDITS.md"),
      "# Credits\n\nSee [README](./README.md) and [LICENSE](./LICENSE).\n",
    );
    writeFile(
      path.join(tmp, "skills", "principle-real", "SKILL.md"),
      "---\nname: principle-real\ndescription: valid principle\n---\n\n# Principle Real\n",
    );
    writeFile(
      path.join(tmp, "skills", "alpha", "SKILL.md"),
      "---\nname: alpha\ndescription: ok\ndisable-model-invocation: true\nlicense: MIT\ncompatibility: Antigravity\n---\n\nSee [ref](./references/doc.md) and `principle-real`.\n",
    );
    writeFile(path.join(tmp, "skills", "alpha", "references", "doc.md"), "# Doc\n");
    writeFile(
      path.join(tmp, "agents", "helper.md"),
      "---\nname: helper\ndescription: ok agent\nmainAgent: false\nsubagent: true\nmodel: inherit\ninheritMcp: true\ninheritCustomizations: true\n---\n\n# Helper\n",
    );

    const clean = validateAStack(tmp, { withAgy: false });
    assert.equal(clean.ok, true, JSON.stringify(clean.errors));

    writeFile(
      path.join(tmp, "README.md"),
      '<picture><source srcset="./missing-light.png"><img src="./missing-banner.png"></picture>\n',
    );
    writeFile(path.join(tmp, "CREDITS.md"), "Broken [credits-ref](./no-such-file.md).\n");
    writeFile(path.join(tmp, "CONTRIBUTING.md"), "Broken [guide](./missing-doc.md).\n");
    writeFile(path.join(tmp, "skills", "swarm", "SKILL.md"), "---\nname: swarm\ndescription: bad\n---\n\nBad.\n");
    writeFile(
      path.join(tmp, "skills", "beta", "SKILL.md"),
      "---\nname: wrong-name\ndescription: bad\ndisable-model-invocation: yes\nicon: rocket\n---\n\nBroken [link](./missing.md), ~/.cursor/skills/x, ~/.agents/skills/x, `allow_multiple: true`, `principle-does-not-exist`, and `TodoWrite`.\n" +
        "x".repeat(24500),
    );
    writeFile(
      path.join(tmp, "agents", "bad.md"),
      "---\nname: bad\ndescription: bad agent\nis_background: true\nmainAgent: maybe\n---\n\n# Bad\n",
    );

    const broken = validateAStack(tmp, { withAgy: false });
    assert.equal(broken.ok, false);
    const messages = broken.errors.map((e) => e.message).join("\n");
    assert.match(messages, /Broken relative link target: \.\/missing-light\.png/);
    assert.match(messages, /Broken relative link target: \.\/missing-banner\.png/);
    assert.match(messages, /Broken relative link target: \.\/no-such-file\.md/);
    assert.match(messages, /Broken relative link target: \.\/missing-doc\.md/);
    assert.match(messages, /skills\/swarm must not exist/);
    assert.match(messages, /Unsupported frontmatter key "icon"/);
    assert.match(messages, /Invalid disable-model-invocation value "yes": must be boolean true or false/);
    assert.match(messages, /Unsupported frontmatter key "is_background" in Antigravity agent/);
    assert.match(messages, /Invalid mainAgent value "maybe": must be boolean true or false/);
    assert.match(messages, /does not match folder "beta"/);
    assert.match(messages, /exceeding Antigravity's 24000-byte/);
    assert.match(messages, /Broken relative link target: \.\/missing\.md/);
    assert.match(messages, /Cursor runtime leak matched \(cursor-dir\)/);
    assert.match(messages, /Cursor runtime leak matched \(cursor-tool-todowrite\)/);
    assert.match(messages, /Cursor runtime leak matched \(invalid-global-skills-dir\)/);
    assert.match(messages, /Cursor runtime leak matched \(cursor-ask-allow-multiple\)/);
    assert.match(messages, /Unknown principle skill reference: principle-does-not-exist/);

    const budgetTmp = makeTempDir("astack-budget-test-");
    try {
      writeFile(
        path.join(budgetTmp, "plugin.json"),
        JSON.stringify({ name: "astack", author: { name: "João Machete" } }),
      );
      writeFile(path.join(budgetTmp, "LICENSE"), "Lauren Tan\nJoão Machete\n");
      writeFile(
        path.join(budgetTmp, "scripts", "catalog.json"),
        JSON.stringify({ maxAutoInvokeSkills: 1, maxAutoInvokeDescriptionBytes: 40, manualOnlySkills: [] }),
      );
      writeFile(
        path.join(budgetTmp, "skills", "skill-one", "SKILL.md"),
        "---\nname: skill-one\ndescription: shared trigger description\n---\n\nOne.\n",
      );
      writeFile(
        path.join(budgetTmp, "skills", "skill-two", "SKILL.md"),
        "---\nname: skill-two\ndescription: shared trigger description\n---\n\nTwo.\n",
      );
      const budgetErrors = validateAStack(budgetTmp, { withAgy: false }).errors.map((e) => e.message).join("\n");
      assert.match(budgetErrors, /Duplicate auto-invocable skill description matches skill-one/);
      assert.match(budgetErrors, /Auto-invocable skill count 2 exceeds maxAutoInvokeSkills \(1\)/);
      assert.match(budgetErrors, /Auto-invocable startup description bytes \d+ exceeds maxAutoInvokeDescriptionBytes \(40\)/);
    } finally {
      fs.rmSync(budgetTmp, { recursive: true, force: true });
    }

    writeFile(path.join(tmp, "skills", "plan", "SKILL.md"), "---\nname: plan\ndescription: clash\n---\n\nPlan.\n");
    writeFile(path.join(tmp, "skills", "learn", "SKILL.md"), "---\nname: learn\ndescription: clash\n---\n\nLearn.\n");
    writeFile(path.join(tmp, "skills", "antigravity_guide", "SKILL.md"), "---\nname: antigravity_guide\ndescription: clash\n---\n\nGuide.\n");
    const collisionMsgs = validateAStack(tmp, { withAgy: false }).errors.map((e) => e.message).join("\n");
    assert.match(collisionMsgs, /skills\/plan must not exist because it shadows the native \/plan/);
    assert.match(collisionMsgs, /skills\/learn must not exist because it shadows the native \/learn/);
    assert.match(collisionMsgs, /skills\/antigravity_guide must not exist because it shadows the native \/antigravity_guide/);

    const realRegistry = JSON.parse(
      fs.readFileSync(path.join(DEFAULT_ROOT_DIR, "skills", "astack-mode", "references", "native-commands.json"), "utf8"),
    );
    const regTmp = makeTempDir("astack-reg-test-");
    try {
      writeFile(
        path.join(regTmp, "plugin.json"),
        JSON.stringify({ name: "astack", author: { name: "João Machete" } }),
      );
      writeFile(path.join(regTmp, "LICENSE"), "Lauren Tan\nJoão Machete\n");
      writeFile(path.join(regTmp, "skills", "astack-mode", "SKILL.md"), "---\nname: astack-mode\ndescription: ok\n---\n\nBody.\n");
      writeFile(path.join(regTmp, "skills", "astack-mode", "references", "plan-contract.md"), "# Plan\n");
      const trimmed = {
        ...realRegistry,
        commands: realRegistry.commands
          .filter((c) => c.command !== "/btw")
          .map((c) => ({
            ...c,
            astackCompanion: ["skills/astack-mode/SKILL.md"],
            backing:
              c.mode === "contract"
                ? { ...c.backing, contract: "skills/astack-mode/references/plan-contract.md" }
                : c.backing,
          })),
      };
      writeFile(
        path.join(regTmp, "skills", "astack-mode", "references", "native-commands.json"),
        JSON.stringify(trimmed, null, 2),
      );
      writeFile(
        path.join(regTmp, "skills", "astack-mode", "references", "native-commands.md"),
        "# Drifted copy\n",
      );
      const regMessages = validateAStack(regTmp, { withAgy: false }).errors.map((e) => e.message).join("\n");
      assert.match(regMessages, /Missing catalog command from registry: \/btw/);
      assert.match(regMessages, /native-commands\.md drifted from native-commands\.json/);
    } finally {
      fs.rmSync(regTmp, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("live AStack repo validates cleanly and enforces UI/Orchestrator and agent isolation invariants", () => {
  const result = validateAStack(DEFAULT_ROOT_DIR, { withAgy: false });
  assert.equal(result.ok, true, JSON.stringify({ errors: result.errors, warnings: result.warnings }));
  assert.equal(result.errors.length, 0);
  assert.equal(result.warnings.length, 0);

  const setupSkill = fs.readFileSync(path.join(DEFAULT_ROOT_DIR, "skills", "setup-astack", "SKILL.md"), "utf8");
  assert.match(setupSkill, /Orchestrator/);
  assert.match(setupSkill, /\/create-verification-skill/);
  assert.ok(
    setupSkill.includes(ASTACK_ASCII_LOGO),
    "skills/setup-astack/SKILL.md fallback ASCII banner drifted from setup-banner.mjs",
  );
  assert.match(setupSkill, /setup-banner\.mjs/);
  assert.doesNotMatch(setupSkill, /Reasoning budget & subagent tier preset/i);

  const helpSkill = fs.readFileSync(path.join(DEFAULT_ROOT_DIR, "skills", "astack-help", "SKILL.md"), "utf8");
  assert.doesNotMatch(helpSkill, /No `~\/\.gemini\/config\/rules\/astack-models\.md`.*means `\/setup-astack` has not run yet/);

  const whySkill = fs.readFileSync(path.join(DEFAULT_ROOT_DIR, "skills", "why", "SKILL.md"), "utf8");
  assert.doesNotMatch(whySkill, /grok-4\.7/);
  assert.doesNotMatch(whySkill, /claude-opus-5-5-xhigh/);
  assert.doesNotMatch(whySkill, /generalPurpose/);
  assert.doesNotMatch(whySkill, /Cursor environment/);

  const commentSicko = fs.readFileSync(path.join(DEFAULT_ROOT_DIR, "agents", "comment-sicko.md"), "utf8");
  const commentSickoFm = Object.fromEntries(
    parseFrontmatter(commentSicko).entries.map((e) => [e.key, e.valueLines.join("\n").trim()]),
  );
  assert.equal(commentSickoFm.inheritCustomizations, "false");

  const readme = fs.readFileSync(path.join(DEFAULT_ROOT_DIR, "README.md"), "utf8");
  assert.match(readme, /fork it\. improve it\. make it yours\. PRs are welcome!/);
  assert.match(readme, /CREDITS\.md/);
  const archDoc = fs.readFileSync(path.join(DEFAULT_ROOT_DIR, "docs", "architecture-and-swarm.md"), "utf8");
  assert.match(archDoc, /dynamic bidirectional model routing/i);
  assert.match(archDoc, /gemini-4-carbon-in-google-antigravity/);
  assert.match(archDoc, /introducing-gemini-4-hydrogen/);
  assert.match(archDoc, /gemini-4-hydrogen-in-google-antigravity/);

  const userGuide = fs.readFileSync(path.join(DEFAULT_ROOT_DIR, "docs", "user-guide.md"), "utf8");
  const setupGuide = fs.readFileSync(path.join(DEFAULT_ROOT_DIR, "docs", "guide", "01-setup.md"), "utf8");
  assert.doesNotMatch(userGuide, /Orchestrator \(Ultra\)/);
  assert.doesNotMatch(setupGuide, /Orchestrator \(Ultra\)/);

  const planContract = fs.readFileSync(
    path.join(DEFAULT_ROOT_DIR, "skills", "astack-mode", "references", "plan-contract.md"),
    "utf8",
  );
  assert.match(planContract, /Post-Approval Finish Gates/i);
  assert.match(planContract, /Proceed/);
  assert.match(planContract, /stop before `git push`/i);

  const orchRule = fs.readFileSync(path.join(DEFAULT_ROOT_DIR, "rules", "astack-orchestration.md"), "utf8");
  assert.match(orchRule, /Proceed/);

  for (const rel of [
    "docs/user-guide.md",
    "docs/guide/02-astack-mode.md",
    "docs/guide/10-recipes-and-pitfalls.md",
    "skills/astack-help/references/recipes.md",
    "docs/tutorials/03-new-feature-workflows.md",
  ]) {
    const text = fs.readFileSync(path.join(DEFAULT_ROOT_DIR, ...rel.split("/")), "utf8");
    assert.doesNotMatch(
      text,
      /\/astack-mode approved\.\s*execute the plan/i,
      `Legacy manual post-plan prompt still present in ${rel}`,
    );
  }

  const stack = [DEFAULT_ROOT_DIR];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === ".tmp" || entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      assert.doesNotMatch(entry.name, /benn[y]/i, `Legacy name in path: ${full}`);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        const text = fs.readFileSync(full, "utf8");
        assert.doesNotMatch(text, /benn[y]/i, `Legacy name in file: ${full}`);
      }
    }
  }
});

test("live repo matches scripts/catalog.json manualOnlySkills (37 manual-only, 29 auto-invocable)", () => {
  const catalog = JSON.parse(fs.readFileSync(path.join(DEFAULT_ROOT_DIR, "scripts", "catalog.json"), "utf8"));
  const manualSet = new Set(catalog.manualOnlySkills);
  assert.equal(manualSet.size, 37);

  const skillDirs = fs
    .readdirSync(path.join(DEFAULT_ROOT_DIR, "skills"), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  assert.equal(skillDirs.length, 66);

  let manualCount = 0;
  let autoCount = 0;
  for (const name of skillDirs) {
    const raw = fs.readFileSync(path.join(DEFAULT_ROOT_DIR, "skills", name, "SKILL.md"), "utf8");
    const { entries } = parseFrontmatter(raw);
    const keyMap = Object.fromEntries(entries.map((e) => [e.key, e.valueLines.join("\n").trim()]));
    if (manualSet.has(name)) {
      assert.equal(keyMap["disable-model-invocation"], "true", `${name} must set disable-model-invocation: true`);
      manualCount++;
    } else {
      assert.equal(keyMap["disable-model-invocation"], undefined, `${name} must remain auto-invocable`);
      autoCount++;
    }
  }
  assert.equal(manualCount, 37);
  assert.equal(autoCount, 29);
});

test("validateAStack rejects hook script gaps, drifted matchers, trust/internal imports, and pr-verifier tools", () => {
  const tmp = makeTempDir("astack-trust-validate-");
  try {
    writeFile(path.join(tmp, "plugin.json"), JSON.stringify({ name: "astack", author: { name: "João Machete" } }));
    writeFile(path.join(tmp, "LICENSE"), "Lauren Tan\nJoão Machete\n");
    writeFile(
      path.join(tmp, "agents", "pr-verifier.md"),
      "---\nname: pr-verifier\ndescription: verifier\ntools:\n  - read_file\n---\n\n# Verifier\n",
    );
    writeFile(
      path.join(tmp, "hooks.json"),
      JSON.stringify({
        "astack-secret-guard": {
          enabled: false,
          PreToolUse: [
            {
              matcher: "write_file",
              hooks: [{ type: "command", command: "node ./scripts/hooks/does-not-exist.mjs" }],
            },
          ],
        },
      }),
    );
    writeFile(
      path.join(tmp, "scripts", "bad-caller.mjs"),
      'import { parseHookStdin } from "./trust/internal/envelope.mjs";\n',
    );
    writeFile(
      path.join(tmp, "sidecars", "broken_sidecar", "sidecar.json"),
      JSON.stringify({
        command: "node",
        args: ["missing.mjs"],
        has_web_ui: true,
        ui_config: { views: [] },
      }),
    );
    writeFile(
      path.join(tmp, "sidecars", "gated_automation", "sidecar.json"),
      JSON.stringify({
        builtin: "schedule",
        args: ["CRON_TZ=UTC 0 9 * * 1-5", "agentapi", "new-conversation", "--", "run"],
        arguments: [{ key: "repo_dir", workspace_arg: {} }],
        agent_permissions: {
          workspace_uris: ["${repo_dir}"],
          access_grants: ["command(gh pr list)"],
        },
      }),
    );
    writeFile(
      path.join(tmp, "sidecars", "broken_sidecar", "bad.mjs"),
      'import { readMergedReceipts } from ' + '"../../scripts/trust/internal/ledger.mjs";\n',
    );

    const msgs = validateAStack(tmp, { withAgy: false }).errors.map((e) => e.message).join("\n");
    assert.match(msgs, /agents\/pr-verifier\.md must omit tools:/);
    assert.match(msgs, /astack-secret-guard PreToolUse matcher drifted from TOOL_MATCHERS/);
    assert.match(msgs, /astack-secret-guard references missing hook script: scripts\/hooks\/does-not-exist\.mjs/);
    assert.match(msgs, /Direct import of scripts\/trust\/internal\/\* is forbidden/);
    assert.match(msgs, /Sidecar references missing script: missing\.mjs/);
    assert.match(msgs, /has_web_ui sidecar must declare non-empty ui_config\.views/);
    assert.match(msgs, /Bundled sidecar must not request arguments, agent_permissions\.workspace_uris, agent_permissions\.access_grants/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("all 20 bundled CLI entrypoints exit 0 on --help and -h with zero module-type warnings", () => {
  const clis = [
    "scripts/validate-astack.mjs",
    "scripts/upstream-watch.mjs",
    "scripts/eval/run-eval.mjs",
    "scripts/eval/risk-backtest.mjs",
    "scripts/trust/cli.mjs",
    "scripts/mcp/server.mjs",
    "scripts/cli/statusline.mjs",
    "scripts/cli/title.mjs",
    "skills/setup-astack/scripts/setup-banner.mjs",
    "skills/setup-astack/scripts/init-repo-policy.mjs",
    "skills/astack-mode/scripts/check-plan.mjs",
    "skills/astack-mode/scripts/worktree-audit.mjs",
    "skills/show-me-your-work/scripts/log.mjs",
    "skills/astack-mode/scripts/watch-pr/watch-pr.mjs",
    "skills/statechart/scripts/statechart.mjs",
    "skills/security-audit/scripts/validate-findings.cjs",
    "skills/security-audit/scripts/validate-coverage-ledger.cjs",
    "skills/pre-pr/scripts/pr-dossier.mjs",
    "skills/audit-architecture/scripts/arch-audit.mjs",
    "sidecars/astack_timeline/main.mjs",
  ];
  for (const rel of clis) {
    const full = path.join(DEFAULT_ROOT_DIR, ...rel.split("/"));
    assert.equal(fs.existsSync(full), true, `Missing CLI: ${rel}`);
    for (const flag of ["--help", "-h"]) {
      const res = spawnSync(process.execPath, [full, flag], { encoding: "utf8" });
      assert.equal(res.status, 0, `${rel} ${flag} failed (${res.status}): ${res.stderr}`);
      assert.doesNotMatch(
        res.stderr,
        /MODULE_TYPELESS_PACKAGE_JSON/,
        `${rel} ${flag} emitted module-type warning`,
      );
      assert.match(res.stdout, /usage:/i, `${rel} ${flag} missing usage output`);
    }
  }
});

test("validateAStack rejects inspiration leaks outside README.md and CREDITS.md without false positives", () => {
  const tmp = makeTempDir("astack-inspiration-test-");
  try {
    writeFile(
      path.join(tmp, "plugin.json"),
      JSON.stringify({
        name: "astack",
        author: { name: "João Machete" },
        keywords: ["astack", "verification"],
      }),
    );
    writeFile(
      path.join(tmp, "LICENSE"),
      "Copyright (c) 2026 Lauren Tan\nCopyright (c) 2026 João Machete\n",
    );
    writeFile(
      path.join(tmp, "README.md"),
      "# AStack\n\nInspired by Lauren Tan (@poteto) pstack, Garry Tan (@garrytan) gstack, and cloudflare/security-audit-skill.\n",
    );
    writeFile(
      path.join(tmp, "CREDITS.md"),
      "# Credits\n\nCredits pstack, gstack, Lauren Tan, Garry Tan, and cloudflare/security-audit-skill.\n",
    );
    writeFile(
      path.join(tmp, "skills", "clean", "SKILL.md"),
      "---\nname: clean\ndescription: Check upstack PRs and tan styling.\n---\n\n# Clean\n\nHandle upstack state and tan color.\n",
    );
    writeFile(
      path.join(tmp, "agents", "clean.md"),
      "---\nname: clean\ndescription: Clean delegate for upstack PR checks\nmainAgent: false\nsubagent: true\nmodel: inherit\n---\n\n# Clean\n",
    );
    writeFile(
      path.join(tmp, "rules", "clean.md"),
      "---\ntrigger: model_decision\ndescription: Handle upstack branches and tan badges.\n---\n\n# Rule\n",
    );

    const clean = validateAStack(tmp, { withAgy: false });
    assert.equal(clean.ok, true, JSON.stringify(clean.errors));

    writeFile(
      path.join(tmp, "plugin.json"),
      JSON.stringify({
        name: "astack",
        author: { name: "João Machete" },
        keywords: ["astack", "pstack"],
      }),
    );
    writeFile(
      path.join(tmp, "agents", "bad-agent.md"),
      "---\nname: bad-agent\ndescription: Inspired by Garry Tan (@garrytan)\nmainAgent: false\nsubagent: true\nmodel: inherit\n---\n\n# Bad Agent\n",
    );
    writeFile(
      path.join(tmp, "skills", "bad-skill", "SKILL.md"),
      "---\nname: bad-skill\ndescription: Built on Lauren Tan (@poteto) gstack and cloudflare/security-audit-skill.\n---\n\n# Bad Skill\n",
    );
    writeFile(
      path.join(tmp, "rules", "bad-rule.md"),
      "---\ntrigger: model_decision\ndescription: Laura Tan and Gary Tan note.\n---\n\n# Bad Rule\n",
    );
    writeFile(
      path.join(tmp, "docs", "bad-doc.md"),
      "# Bad Doc\n\nSee https://github.com/garrytan/gstack and pstack.\n",
    );
    writeFile(
      path.join(tmp, "scripts", "mcp", "tools.mjs"),
      'export const TOOL_DEFINITIONS = [{ description: "pstack helper" }];\n',
    );

    const broken = validateAStack(tmp, { withAgy: false });
    assert.equal(broken.ok, false);
    const byFile = new Map();
    for (const err of broken.errors) {
      const list = byFile.get(err.file) ?? [];
      list.push(err.message);
      byFile.set(err.file, list);
    }
    assert.match((byFile.get("plugin.json") ?? []).join("\n"), /inspiration-pstack/);
    assert.match((byFile.get("agents/bad-agent.md") ?? []).join("\n"), /inspiration-garry-tan/);
    assert.match((byFile.get("agents/bad-agent.md") ?? []).join("\n"), /inspiration-garrytan/);
    assert.match((byFile.get("skills/bad-skill/SKILL.md") ?? []).join("\n"), /inspiration-lauren-tan/);
    assert.match((byFile.get("skills/bad-skill/SKILL.md") ?? []).join("\n"), /inspiration-poteto/);
    assert.match((byFile.get("skills/bad-skill/SKILL.md") ?? []).join("\n"), /inspiration-gstack/);
    assert.match((byFile.get("skills/bad-skill/SKILL.md") ?? []).join("\n"), /inspiration-security-audit-skill/);
    assert.match((byFile.get("rules/bad-rule.md") ?? []).join("\n"), /inspiration-lauren-tan/);
    assert.match((byFile.get("rules/bad-rule.md") ?? []).join("\n"), /inspiration-garry-tan/);
    assert.match((byFile.get("docs/bad-doc.md") ?? []).join("\n"), /inspiration-garrytan/);
    assert.match((byFile.get("docs/bad-doc.md") ?? []).join("\n"), /inspiration-gstack/);
    assert.match((byFile.get("docs/bad-doc.md") ?? []).join("\n"), /inspiration-pstack/);
    assert.match((byFile.get("scripts/mcp/tools.mjs") ?? []).join("\n"), /inspiration-pstack/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("validateAStack rejects drifted timeline command-catalog, missing doc coverage, and stale counts", () => {
  const tmp = makeTempDir("astack-surface-validate-");
  try {
    writeFile(path.join(tmp, "plugin.json"), JSON.stringify({ name: "astack", author: { name: "João Machete" } }));
    writeFile(path.join(tmp, "LICENSE"), "Lauren Tan\nJoão Machete\n");
    writeFile(path.join(tmp, "skills", "astack-mode", "SKILL.md"), "---\nname: astack-mode\ndescription: mode\n---\n\nBody.\n");
    writeFile(path.join(tmp, "skills", "astack-mode", "references", "plan-contract.md"), "# Plan\n");
    writeFile(path.join(tmp, "skills", "astack-help", "SKILL.md"), "---\nname: astack-help\ndescription: help\n---\n\n/astack-mode\n");
    writeFile(path.join(tmp, "skills", "new-skill", "SKILL.md"), "---\nname: new-skill\ndescription: newly added\n---\n\nNew.\n");
    writeFile(path.join(tmp, "docs", "agent-timeline.md"), "# Timeline\n\n/astack-mode\n");
    writeFile(path.join(tmp, "docs", "user-guide.md"), "# User Guide\n\nPair with 16 native slash commands.\n");

    const realReg = JSON.parse(
      fs.readFileSync(path.join(DEFAULT_ROOT_DIR, "skills", "astack-mode", "references", "native-commands.json"), "utf8"),
    );
    const patchedReg = {
      ...realReg,
      commands: realReg.commands.map((c) => ({
        ...c,
        astackCompanion: ["skills/astack-mode/SKILL.md"],
        backing:
          c.mode === "contract"
            ? { ...c.backing, contract: "skills/astack-mode/references/plan-contract.md" }
            : c.backing,
      })),
    };
    writeFile(
      path.join(tmp, "skills", "astack-mode", "references", "native-commands.json"),
      JSON.stringify(patchedReg, null, 2),
    );
    writeFile(
      path.join(tmp, "skills", "astack-mode", "references", "native-commands.md"),
      renderNativeCommandsMarkdown(patchedReg),
    );

    writeFile(
      path.join(tmp, "sidecars", "astack_timeline", "command-catalog.json"),
      JSON.stringify(
        {
          githubDocsBase: "https://github.com/jmxt3/astack/blob/main",
          commands: {
            "/astack-mode": {
              kind: "skill",
              invocable: true,
              description: "Mode router.",
              docsPath: "skills/astack-mode/SKILL.md",
            },
            "/removed-skill": {
              kind: "skill",
              invocable: true,
              description: "Removed skill.",
              docsPath: "skills/astack-mode/SKILL.md",
            },
            "watch-pr": {
              kind: "script",
              invocable: true,
              backingPath: "skills/astack-mode/SKILL.md",
              invokedBy: "/astack-mode",
              description: "Invalid invocable script.",
              docsPath: "skills/astack-mode/SKILL.md",
            },
            "internal-helper": {
              kind: "script",
              invocable: false,
              backingPath: "skills/astack-mode/SKILL.md",
              invokedBy: "/astack-mode",
              description: "Valid non-invocable script placed in moreCommands.",
              docsPath: "skills/astack-mode/SKILL.md",
            },
            babysit: {
              kind: "playbook",
              invocable: true,
              backingPath: "skills/astack-mode/SKILL.md",
              description: "Bare playbook name.",
              docsPath: "skills/astack-mode/SKILL.md",
            },
          },
          stageCatalog: {
            ship: {
              autoSubCommands: ["watch-pr"],
              moreCommands: ["internal-helper"],
            },
          },
          delegateGuide: {
            picks: [{ id: "bad", chipLabel: "Bad", kicker: "Bad", prompt: "/ghost-cmd", how: "Test" }],
            sections: [
              {
                id: "alongside",
                title: "Alongside",
                subtitle: "Sub",
                icon: "fork",
                items: [
                  {
                    pickId: null,
                    command: "/compact",
                    copyText: "/compact",
                    ownership: "Not wired yet",
                    statusPill: "not wired",
                  },
                ],
              },
            ],
            delegateMenu: [],
          },
        },
        null,
        2,
      ),
    );

    const res = validateAStack(tmp, { withAgy: false });
    assert.equal(res.ok, false);
    const msgs = res.errors.map((e) => `${e.file}: ${e.message}`).join("\n");
    assert.match(msgs, /Skill entry \/removed-skill does not exist under skills\//);
    assert.match(msgs, /Internal script watch-pr must set invocable: false/);
    assert.match(msgs, /Playbook entry babysit must use \/astack-mode <trigger> syntax/);
    assert.match(msgs, /stageCatalog\.ship\.moreCommands cannot include non-invocable internal-helper/);
    assert.match(msgs, /delegateGuide picks\.bad references unknown command \/ghost-cmd/);
    assert.match(msgs, /Registered native command \/compact cannot be marked "not wired"/);
    assert.match(msgs, /Non-principle skill \/new-skill missing from command-catalog\.json/);
    assert.match(msgs, /skills\/astack-help\/SKILL\.md: Documentation missing skill \/new-skill/);
    assert.match(msgs, /docs\/agent-timeline\.md: Documentation missing skill \/new-skill/);
    assert.match(msgs, /docs\/user-guide\.md: Stale native command count \(16\); expected 18/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("audit-surfaces.mjs --help/-h and --json pass on live repo and fail on drifted command surfaces", () => {
  const auditCli = path.join(
    DEFAULT_ROOT_DIR,
    ".agents",
    "skills",
    "sync-astack-surfaces",
    "scripts",
    "audit-surfaces.mjs",
  );
  assert.equal(fs.existsSync(auditCli), true, "Missing audit-surfaces.mjs");
  for (const flag of ["--help", "-h"]) {
    const helpRes = spawnSync(process.execPath, [auditCli, flag], { encoding: "utf8" });
    assert.equal(helpRes.status, 0, `${flag} failed: ${helpRes.stderr}`);
    assert.match(helpRes.stdout, /usage:/i);
  }

  const liveRes = spawnSync(process.execPath, [auditCli, "--json"], {
    cwd: DEFAULT_ROOT_DIR,
    encoding: "utf8",
  });
  assert.equal(liveRes.status, 0, `Live audit-surfaces failed: ${liveRes.stderr}\n${liveRes.stdout}`);
  const liveJson = JSON.parse(liveRes.stdout);
  assert.equal(liveJson.ok, true);
  assert.deepEqual(liveJson.validationErrors, []);
  assert.deepEqual(liveJson.unknownSlashCommands, []);

  const tmp = makeTempDir("astack-audit-surfaces-fail-");
  try {
    writeFile(path.join(tmp, "plugin.json"), JSON.stringify({ name: "astack", author: { name: "João Machete" } }));
    writeFile(path.join(tmp, "LICENSE"), "Lauren Tan\nJoão Machete\n");
    writeFile(path.join(tmp, "docs", "bad-commands.md"), "# Guide\n\nRun `/nonexistent-slash-cmd` now.\n");
    const failRes = spawnSync(process.execPath, [auditCli, "--cwd", tmp, "--json"], {
      encoding: "utf8",
    });
    assert.equal(failRes.status, 1, "audit-surfaces.mjs must fail on unrecognized slash commands");
    const failJson = JSON.parse(failRes.stdout);
    assert.equal(failJson.ok, false);
    assert.ok(
      failJson.unknownSlashCommands.some((u) => u.command === "/nonexistent-slash-cmd"),
      "Expected unrecognized /nonexistent-slash-cmd report",
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
