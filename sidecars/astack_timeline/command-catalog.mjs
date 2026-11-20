export const GITHUB_DOCS_BASE = "https://github.com/jmxt3/astack/blob/main";

export const COMMAND_DOCS = {
  "/setup-astack": {
    description: "Scaffold verify-<app> skills and repo guardrails once per project.",
    docsUrl: `${GITHUB_DOCS_BASE}/skills/setup-astack/SKILL.md`,
  },
  "/create-verification-skill": {
    description: "Generate .agents/skills/verify-<app>/ and a live feature map.",
    docsUrl: `${GITHUB_DOCS_BASE}/skills/create-verification-skill/SKILL.md`,
  },
  "/create-formal-verification-skill": {
    description: "Scaffold TLA+ or TypeScript bounded invariant verification checks.",
    docsUrl: `${GITHUB_DOCS_BASE}/skills/create-formal-verification-skill/SKILL.md`,
  },
  "/maintain-verification-skill": {
    description: "Audit and repair drifted verify-<app> checks against live app behavior.",
    docsUrl: `${GITHUB_DOCS_BASE}/skills/maintain-verification-skill/SKILL.md`,
  },
  "/maintain-formal-verification-skill": {
    description: "Re-sync TLA+ or bounded TypeScript specs after code changes.",
    docsUrl: `${GITHUB_DOCS_BASE}/skills/maintain-formal-verification-skill/SKILL.md`,
  },
  "/astack-help": {
    description: "Pick the right skill, playbook, or multi-agent tier without running edits.",
    docsUrl: `${GITHUB_DOCS_BASE}/skills/astack-help/SKILL.md`,
  },
  "/plan": {
    description: "Investigate read-only and write implementation_plan.md before editing files.",
    docsUrl: `${GITHUB_DOCS_BASE}/skills/astack-mode/references/plan-contract.md`,
  },
  "/grill-me": {
    description: "Interview you one question at a time to sharpen a rough idea before planning.",
    docsUrl: `${GITHUB_DOCS_BASE}/docs/user-guide.md#part-2-plan-first-workflow-write-a-plan-approve-then-execute`,
  },
  "/how": {
    description: "Trace how a subsystem works right now and which module owns it.",
    docsUrl: `${GITHUB_DOCS_BASE}/skills/how/SKILL.md`,
  },
  "/why": {
    description: "Trace git history, PRs, and trackers for why code or limits exist.",
    docsUrl: `${GITHUB_DOCS_BASE}/skills/why/SKILL.md`,
  },
  "/in-your-own-words": {
    description: "Restate the ticket or goal read-only to catch misreads before coding.",
    docsUrl: `${GITHUB_DOCS_BASE}/skills/in-your-own-words/SKILL.md`,
  },
  "/sharpen": {
    description: "Rewrite an underspecified prompt deeper without executing edits.",
    docsUrl: `${GITHUB_DOCS_BASE}/skills/sharpen/SKILL.md`,
  },
  "/teach": {
    description: "Explain a subsystem or PR step by step with diagrams and rationale.",
    docsUrl: `${GITHUB_DOCS_BASE}/skills/teach/SKILL.md`,
  },
  "/recall": {
    description: "Reconstruct recent work from Antigravity transcripts and PR history.",
    docsUrl: `${GITHUB_DOCS_BASE}/skills/recall/SKILL.md`,
  },
  "/architect": {
    description: "Explore competing boundary designs in parallel and screen red flags.",
    docsUrl: `${GITHUB_DOCS_BASE}/skills/architect/SKILL.md`,
  },
  "/statechart": {
    description: "Model-check TLA+ state machines and render failing paths as Mermaid charts.",
    docsUrl: `${GITHUB_DOCS_BASE}/skills/statechart/SKILL.md`,
  },
  "/figure-it-out": {
    description: "Design an auditable hypothesis loop for huge unmapped migrations.",
    docsUrl: `${GITHUB_DOCS_BASE}/skills/figure-it-out/SKILL.md`,
  },
  "/astack-mode": {
    description: "Run the full playbook: implement, clean the diff, and prove it works live.",
    docsUrl: `${GITHUB_DOCS_BASE}/skills/astack-mode/SKILL.md`,
  },
  "/interrogate": {
    description: "Run multi-model adversarial review on a contested design or diff.",
    docsUrl: `${GITHUB_DOCS_BASE}/skills/interrogate/SKILL.md`,
  },
  "/deslop": {
    description: "Strip speculative helpers, shims, and bloat before committing.",
    docsUrl: `${GITHUB_DOCS_BASE}/skills/deslop/SKILL.md`,
  },
  "/no-comments": {
    description: "Delete narrating comments and flag workarounds via comment-sicko.",
    docsUrl: `${GITHUB_DOCS_BASE}/skills/no-comments/SKILL.md`,
  },
  "/control-ui": {
    description: "Boot isolated UI servers and verify user flows in a real browser.",
    docsUrl: `${GITHUB_DOCS_BASE}/skills/control-ui/SKILL.md`,
  },
  "/control-cli": {
    description: "Verify CLIs, daemons, and HTTP APIs in isolated temp workspaces.",
    docsUrl: `${GITHUB_DOCS_BASE}/skills/control-cli/SKILL.md`,
  },
  "/tdd": {
    description: "Write a minimal failing behavioral test first on cheap local tests.",
    docsUrl: `${GITHUB_DOCS_BASE}/skills/tdd/SKILL.md`,
  },
  "/arena": {
    description: "Race competing candidates in isolated branches and graft the cleanest wins.",
    docsUrl: `${GITHUB_DOCS_BASE}/skills/arena/SKILL.md`,
  },
  "/fanout": {
    description: "Run parallel subagent slices or review arms and consolidate findings.",
    docsUrl: `${GITHUB_DOCS_BASE}/skills/fanout/SKILL.md`,
  },
  "/design-audit": {
    description: "Audit desktop and mobile layout, keyboard nav, ARIA, and UI states live.",
    docsUrl: `${GITHUB_DOCS_BASE}/skills/design-audit/SKILL.md`,
  },
  "/benchmark-checklist": {
    description: "Vet performance speedups and regressions across seven empirical checks.",
    docsUrl: `${GITHUB_DOCS_BASE}/skills/benchmark-checklist/SKILL.md`,
  },
  "/show-me-your-work": {
    description: "Record an append-only TSV decision trail audited against transcripts.",
    docsUrl: `${GITHUB_DOCS_BASE}/skills/show-me-your-work/SKILL.md`,
  },
  "/ketchup": {
    description: "Summarize recent changes and pending human decisions in plain prose.",
    docsUrl: `${GITHUB_DOCS_BASE}/skills/ketchup/SKILL.md`,
  },
  "/review-pr": {
    description: "Compile pr-review.md and run an isolated verifier pass before opening a PR.",
    docsUrl: `${GITHUB_DOCS_BASE}/skills/review-pr/SKILL.md`,
  },
  "pr-dossier": {
    description: "Compile Risk Tier 0-3 blast radius, receipts, and pr-review.md.",
    docsUrl: `${GITHUB_DOCS_BASE}/skills/review-pr/SKILL.md`,
  },
  "pr-verifier": {
    description: "Run isolated fresh-context verification against base-branch REVIEW.md.",
    docsUrl: `${GITHUB_DOCS_BASE}/agents/pr-verifier.md`,
  },
  "/security-audit": {
    description: "Run opt-in trust-boundary guidance or 6-phase vulnerability audits.",
    docsUrl: `${GITHUB_DOCS_BASE}/skills/security-audit/SKILL.md`,
  },
  "/blast-radius": {
    description: "Prove downstream caller, wire, and database safety by running real code.",
    docsUrl: `${GITHUB_DOCS_BASE}/skills/blast-radius/SKILL.md`,
  },
  "/audit-architecture": {
    description: "Scan module boundaries, banned patterns, and shallow modules.",
    docsUrl: `${GITHUB_DOCS_BASE}/skills/audit-architecture/SKILL.md`,
  },
  "/astack-mode open the pr": {
    description: "Prepare clean commits, compile the PR proof block, and open the PR.",
    docsUrl: `${GITHUB_DOCS_BASE}/skills/astack-mode/playbooks/opening-a-pr.md`,
  },
  babysit: {
    description: "Watch CI, triage review threads skeptically, and drive the PR to merge-ready.",
    docsUrl: `${GITHUB_DOCS_BASE}/skills/astack-mode/playbooks/babysit.md`,
  },
  "/technical-writing": {
    description: "Enforce clear active voice and Google/STE rules on docs and PR bodies.",
    docsUrl: `${GITHUB_DOCS_BASE}/skills/technical-writing/SKILL.md`,
  },
  "/unslop": {
    description: "Remove AI writing tells, forced triplets, and filler from prose.",
    docsUrl: `${GITHUB_DOCS_BASE}/skills/unslop/SKILL.md`,
  },
  "watch-pr": {
    description: "Poll GitHub PR checks, mergeability, and review threads to READY.",
    docsUrl: `${GITHUB_DOCS_BASE}/skills/astack-mode/playbooks/babysit.md`,
  },
  "/astack-mode land the stack": {
    description: "Verify each PR via an independent verifier and merge bottom-up.",
    docsUrl: `${GITHUB_DOCS_BASE}/skills/astack-mode/playbooks/shipping.md`,
  },
  "release-and-postmortem": {
    description: "Write release notes, run post-deploy smoke checks, and close incidents.",
    docsUrl: `${GITHUB_DOCS_BASE}/skills/astack-mode/playbooks/release-and-postmortem.md`,
  },
  "/correct": {
    description: "Encode recurring mistakes into types, lints, tests, or rules.",
    docsUrl: `${GITHUB_DOCS_BASE}/skills/correct/SKILL.md`,
  },
  "/reflect": {
    description: "Mine session transcripts to propose targeted skill improvements.",
    docsUrl: `${GITHUB_DOCS_BASE}/skills/reflect/SKILL.md`,
  },
  "/automate-me": {
    description: "Distill recurring session habits into a personal workflow skill.",
    docsUrl: `${GITHUB_DOCS_BASE}/skills/automate-me/SKILL.md`,
  },
  "/astack-mode prune worktrees": {
    description: "Audit stale git worktrees and clones safely before removing them.",
    docsUrl: `${GITHUB_DOCS_BASE}/skills/astack-mode/playbooks/worktree-cleanup.md`,
  },
};

export const STAGE_COMMAND_CATALOG = {
  setup: {
    autoSubCommands: ["/create-verification-skill", "/create-formal-verification-skill"],
    moreCommands: ["/maintain-verification-skill", "/maintain-formal-verification-skill", "/astack-help"],
  },
  plan: {
    autoSubCommands: ["/how", "/why"],
    moreCommands: [
      "/in-your-own-words",
      "/sharpen",
      "/teach",
      "/recall",
      "/architect",
      "/statechart",
      "/figure-it-out",
    ],
  },
  build: {
    autoSubCommands: ["/deslop", "/no-comments", "/control-ui", "/control-cli"],
    moreCommands: [
      "/tdd",
      "/arena",
      "/fanout",
      "/design-audit",
      "/benchmark-checklist",
      "/show-me-your-work",
      "/ketchup",
    ],
  },
  review: {
    autoSubCommands: ["pr-dossier", "pr-verifier"],
    moreCommands: ["/security-audit", "/blast-radius", "/audit-architecture"],
  },
  ship: {
    autoSubCommands: ["/technical-writing", "/unslop", "watch-pr"],
    moreCommands: [
      "/astack-mode land the stack",
      "release-and-postmortem",
      "/correct",
      "/reflect",
      "/automate-me",
      "/astack-mode prune worktrees",
    ],
  },
};
