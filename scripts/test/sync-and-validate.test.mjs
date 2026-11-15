import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  mapUpstreamRelativePath,
  syncUpstream,
  transformPortedMarkdown,
} from "../sync-upstream.mjs";
import { DEFAULT_ROOT_DIR, validateAStack } from "../validate-astack.mjs";

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

test("transformPortedMarkdown strips Cursor frontmatter keys and preserves upstream URLs", () => {
  const input = [
    "---",
    "name: poteto-mode",
    "description: Use `/poteto-mode` and check ~/.cursor/rules/pstack-models.mdc",
    "disable-model-invocation: true",
    "icon: rocket",
    "color: red",
    "---",
    "",
    "# Body",
    "See https://github.com/cursor/plugins/tree/main/pstack for original pstack.",
    "Use `Read` and `StrReplace` and `TodoWrite`, spawn `subagent_type: \"generalPurpose\"`, and avoid /swarm conflicts.",
    "",
  ].join("\n");

  const output = transformPortedMarkdown(input, { targetName: "astack-mode" });
  assert.match(output, /^---\nname: astack-mode\n/);
  assert.doesNotMatch(output, /disable-model-invocation/);
  assert.doesNotMatch(output, /^icon:/m);
  assert.doesNotMatch(output, /^color:/m);
  assert.match(output, /~\/\.gemini\/config\/rules\/astack-models\.md/);
  assert.match(output, /\/astack-mode/);
  assert.match(output, /https:\/\/github\.com\/cursor\/plugins\/tree\/main\/pstack/);
  assert.match(output, /`read_file` and `edit_file`/);
  assert.match(output, /`TypeName: "self"`/);
  assert.match(output, /\/fanout conflicts/);
});

test("mapUpstreamRelativePath renames entry points, avoids /swarm collision, and moves automations under docs/", () => {
  const manifest = {
    skillRenames: {
      "poteto-mode": "astack-mode",
      "poteto-help": "astack-help",
      "setup-pstack": "setup-astack",
      swarm: "fanout",
    },
    agentRenames: { "poteto-agent": "astack-agent" },
    ignoredUpstreamPaths: [".cursor-plugin", "skills/poteto-mode/scripts/bootstrap.ts"],
  };

  assert.equal(mapUpstreamRelativePath(".cursor-plugin/plugin.json", manifest), null);
  assert.equal(mapUpstreamRelativePath("skills/poteto-mode/scripts/bootstrap.ts", manifest), null);
  assert.equal(mapUpstreamRelativePath("skills/swarm/SKILL.md", manifest), "skills/fanout/SKILL.md");
  assert.equal(mapUpstreamRelativePath("skills/poteto-mode/playbooks/feature.md", manifest), "skills/astack-mode/playbooks/feature.md");
  assert.equal(mapUpstreamRelativePath("agents/poteto-agent.md", manifest), "agents/astack-agent.md");
  assert.equal(mapUpstreamRelativePath("automations/benny/README.md", manifest), "docs/automations/benny/README.md");
  assert.equal(mapUpstreamRelativePath("docs/guide/02-poteto-mode.md", manifest), "docs/guide/02-astack-mode.md");
});

test("syncUpstream populates baseline and protects existing overlay files on subsequent syncs", () => {
  const tmp = makeTempDir("astack-sync-test-");
  try {
    const fakeUpstream = path.join(tmp, "upstream");
    const fakeDest = path.join(tmp, "dest");

    writeFile(
      path.join(fakeDest, "scripts", "UPSTREAM.json"),
      JSON.stringify({
        skillRenames: { "poteto-mode": "astack-mode", swarm: "fanout" },
        agentRenames: { "poteto-agent": "astack-agent" },
        ignoredUpstreamPaths: [],
        overlayPaths: ["skills/astack-mode"],
      }),
    );
    writeFile(
      path.join(fakeUpstream, "skills", "poteto-mode", "SKILL.md"),
      "---\nname: poteto-mode\ndescription: entry\ndisable-model-invocation: true\n---\n\nRun `/poteto-mode`.\n",
    );
    writeFile(
      path.join(fakeUpstream, "skills", "tdd", "SKILL.md"),
      "---\nname: tdd\ndescription: test first\n---\n\nInitial TDD.\n",
    );

    const first = syncUpstream({ rootDir: fakeDest, sourceDir: fakeUpstream });
    assert.deepEqual(first.added.sort(), ["skills/astack-mode/SKILL.md", "skills/tdd/SKILL.md"]);

    // Customize overlay + update upstream
    const overlayFile = path.join(fakeDest, "skills", "astack-mode", "SKILL.md");
    writeFile(overlayFile, "---\nname: astack-mode\ndescription: custom overlay\n---\n\nCustom Antigravity Swarm.\n");
    writeFile(
      path.join(fakeUpstream, "skills", "tdd", "SKILL.md"),
      "---\nname: tdd\ndescription: test first\n---\n\nUpdated TDD.\n",
    );

    const second = syncUpstream({ rootDir: fakeDest, sourceDir: fakeUpstream });
    assert.deepEqual(second.skippedOverlays, ["skills/astack-mode/SKILL.md"]);
    assert.deepEqual(second.updated, ["skills/tdd/SKILL.md"]);
    assert.match(fs.readFileSync(overlayFile, "utf8"), /Custom Antigravity Swarm/);
    assert.match(fs.readFileSync(path.join(fakeDest, "skills", "tdd", "SKILL.md"), "utf8"), /Updated TDD/);
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
        author: { name: "João Machete (port of PStack by Lauren Tan)" },
        logo: "assets/logo.svg",
      }),
    );
    writeFile(
      path.join(tmp, "LICENSE"),
      "Copyright (c) 2026 Lauren Tan\nCopyright (c) 2026 João Machete\n",
    );
    writeFile(path.join(tmp, "assets", "logo.svg"), "<svg/>");
    writeFile(
      path.join(tmp, "skills", "alpha", "SKILL.md"),
      "---\nname: alpha\ndescription: ok\n---\n\nSee [ref](./references/doc.md).\n",
    );
    writeFile(path.join(tmp, "skills", "alpha", "references", "doc.md"), "# Doc\n");
    writeFile(
      path.join(tmp, "agents", "helper.md"),
      "---\nname: helper\ndescription: ok agent\n---\n\n# Helper\n",
    );

    const clean = validateAStack(tmp, { withAgy: false });
    assert.equal(clean.ok, true, JSON.stringify(clean.errors));

    // Introduce failures across categories
    writeFile(path.join(tmp, "skills", "swarm", "SKILL.md"), "---\nname: swarm\ndescription: bad\n---\n\nBad.\n");
    writeFile(
      path.join(tmp, "skills", "beta", "SKILL.md"),
      "---\nname: wrong-name\ndescription: bad\ndisable-model-invocation: true\n---\n\nBroken [link](./missing.md) and ~/.cursor/skills/x and `TodoWrite`.\n" +
        "x".repeat(24500),
    );

    const broken = validateAStack(tmp, { withAgy: false });
    assert.equal(broken.ok, false);
    const messages = broken.errors.map((e) => e.message).join("\n");
    assert.match(messages, /skills\/swarm must not exist/);
    assert.match(messages, /Unsupported frontmatter key "disable-model-invocation"/);
    assert.match(messages, /does not match folder "beta"/);
    assert.match(messages, /exceeding Antigravity's 24000-byte/);
    assert.match(messages, /Broken relative link target: \.\/missing\.md/);
    assert.match(messages, /Cursor runtime leak matched \(cursor-dir\)/);
    assert.match(messages, /Cursor runtime leak matched \(cursor-tool-todowrite\)/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("live AStack repo validates cleanly and defaults to UI/Orchestrator inheritance", () => {
  const result = validateAStack(DEFAULT_ROOT_DIR, { withAgy: false });
  assert.equal(result.ok, true, JSON.stringify({ errors: result.errors, warnings: result.warnings }));
  assert.equal(result.errors.length, 0);
  assert.equal(result.warnings.length, 0);

  const setupSkill = fs.readFileSync(path.join(DEFAULT_ROOT_DIR, "skills", "setup-astack", "SKILL.md"), "utf8");
  assert.match(setupSkill, /Orchestrator/);
  assert.match(setupSkill, /\/create-verification-skill/);
  assert.doesNotMatch(setupSkill, /Reasoning budget & subagent tier preset/i);

  const helpSkill = fs.readFileSync(path.join(DEFAULT_ROOT_DIR, "skills", "astack-help", "SKILL.md"), "utf8");
  assert.doesNotMatch(helpSkill, /No `~\/\.gemini\/config\/rules\/astack-models\.md`.*means `\/setup-astack` has not run yet/);

  const whySkill = fs.readFileSync(path.join(DEFAULT_ROOT_DIR, "skills", "why", "SKILL.md"), "utf8");
  assert.doesNotMatch(whySkill, /grok-4\.7/);
  assert.doesNotMatch(whySkill, /claude-opus-5-5-xhigh/);
  assert.doesNotMatch(whySkill, /generalPurpose/);
  assert.doesNotMatch(whySkill, /Cursor environment/);
});
