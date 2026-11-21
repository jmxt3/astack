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
  "/swarm": {
    description: "Spawn named workers with isolated workspaces and a @verifier on a shared board.",
    docsUrl: `${GITHUB_DOCS_BASE}/skills/astack-mode/references/swarm-coordination.md`,
  },
  "/run-workflow": {
    description: "Run parallel() and pipeline() Python workflows across many files or staged phases.",
    docsUrl: `${GITHUB_DOCS_BASE}/skills/astack-mode/references/native-commands.md`,
  },
  "/schedule": {
    description: "Schedule a one-shot timer or recurring cron check inside the active conversation.",
    docsUrl: `${GITHUB_DOCS_BASE}/skills/astack-mode/playbooks/babysit.md`,
  },
  "/automation": {
    description: "Create a persistent App sidecar automation (sidecar.json with CRON_TZ), dormant until enabled.",
    docsUrl: `${GITHUB_DOCS_BASE}/skills/astack-mode/references/native-commands.md`,
  },
  "/browser": {
    description: "Delegate live web UI inspection, interaction, and screenshots to the browser subagent.",
    docsUrl: `${GITHUB_DOCS_BASE}/skills/control-ui/SKILL.md`,
  },
  "/boost": {
    description: "Three-tier multi-agent deep reasoning hierarchy for hard coupled bugs, races, and algorithms.",
    docsUrl: `${GITHUB_DOCS_BASE}/skills/astack-mode/playbooks/bug-fix.md`,
  },
  "/goal": {
    description: "Harness-owned continuous loop that keeps running until the done predicate holds.",
    docsUrl: `${GITHUB_DOCS_BASE}/skills/astack-mode/playbooks/autonomous-run.md`,
  },
  "/teamwork": {
    description: "Sentinel scoping interview, binding spec, and agent teams for multi-day campaigns.",
    docsUrl: `${GITHUB_DOCS_BASE}/skills/astack-mode/playbooks/orchestrate.md`,
  },
  "/btw": {
    description: "Ask a read-only contextual side question without pausing active agents or cluttering history.",
    docsUrl: `${GITHUB_DOCS_BASE}/skills/astack-mode/references/native-commands.md`,
  },
  "/learn": {
    description: "Distill session corrections into durable rules or skills via learning_proposal.md.",
    docsUrl: `${GITHUB_DOCS_BASE}/skills/astack-mode/references/plan-contract.md`,
  },
  "/compact": {
    description: "Checkpoint a long /goal run to free context without losing the thread (not wired to AStack yet).",
    docsUrl: `${GITHUB_DOCS_BASE}/docs/agent-timeline.md`,
  },
  subagents: {
    description: "Spawn focused background subagents (astack-agent, research, browser, comment-sicko, pr-verifier).",
    docsUrl: `${GITHUB_DOCS_BASE}/skills/fanout/SKILL.md`,
  },
  research: {
    description: "Read-only research subagents spawned by /how and /why to trace callers and history.",
    docsUrl: `${GITHUB_DOCS_BASE}/skills/how/SKILL.md`,
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

export const DELEGATE_GUIDE_DATA = {
  picks: [
    {
      id: "subagents",
      chipLabel: "Side task",
      kicker: "Side task · subagents",
      prompt: "Delegate to a research subagent: map every caller of resolveTrustDir and report file and line.",
      how: "AStack spawns these itself: astack-agent, research, browser, comment-sicko and pr-verifier.",
    },
    {
      id: "browser",
      chipLabel: "UI check",
      kicker: "UI check · /browser",
      prompt: "/browser Open http://localhost:3000, drive the timeline sidecar, check that receipts render, and capture a screenshot.",
      how: "AStack runs it under /control-ui during Build & Prove.",
    },
    {
      id: "swarm",
      chipLabel: "Broad",
      kicker: "Broad · /swarm",
      prompt: "/swarm <task>. One worker per file or package, plus a @verifier that runs the tests before sign-off.",
      how: "AStack runs it for broad Build & Prove work and stacked PRs.",
    },
    {
      id: "rw",
      chipLabel: "Many of the same",
      kicker: "Many of the same · /run-workflow",
      prompt: "/run-workflow Review the changed files on this branch in parallel, one reviewer per file, then run pr-verifier once on HEAD and log a one-line verdict per file.",
      how: "AStack runs it when many files or packages share the same staged pass. A workflow can use AStack agents such as pr-verifier as its agent type.",
    },
    {
      id: "boost",
      chipLabel: "Hard",
      kicker: "Hard · /boost",
      prompt: "/boost /astack-mode <hard bug>. Reproduce it, isolate the root cause, fix it, and prove it with repeated clean runs.",
      how: "AStack suggests it from the bug-fix, perf-issue and hillclimb playbooks. You start it.",
    },
    {
      id: "goal",
      chipLabel: "Until done",
      kicker: "Until done · /goal",
      prompt: "/goal <task>. Done when <checkable predicate>.",
      how: "AStack drafts the predicate; hand it an approved plan. You start it.",
    },
    {
      id: "teamwork",
      chipLabel: "Multi-day",
      kicker: "Multi-day · /teamwork",
      prompt: "/teamwork <repo-scale migration or multi-day goal>",
      how: "Starts with a scoping interview, then runs on its own. Pairs with the orchestrate playbook.",
    },
    {
      id: "schedule",
      chipLabel: "Later",
      kicker: "Later · /schedule",
      prompt: "/schedule every 10 minutes check watch-pr.mjs --pr <n> --status-only and wake me when CI finishes or new review comments arrive.",
      how: "babysit re-arms this during Ship.",
    },
    {
      id: "automation",
      chipLabel: "Recurring",
      kicker: "Recurring · /automation",
      prompt: "/automation every weekday at 9am run /maintain-verification-skill on this repository and post a summary of clean, changed or blocked features.",
      how: "App only. AStack creates it dormant; you turn it on in the Automations tab.",
    },
    {
      id: "btw",
      chipLabel: "Quick question",
      kicker: "Quick question · /btw",
      prompt: "/btw Which file defines the receipt freshness check?",
      how: "Opens a Side Question tab. Nothing is added to the main conversation.",
    },
  ],
  sections: [
    {
      id: "wider",
      title: "Wider",
      subtitle: "Split the work across agents",
      icon: "swarm",
      items: [
        {
          pickId: "subagents",
          command: "subagents",
          icon: "orbit",
          summary: "A focused side task while you keep working: research, a browser check, a test run.",
          ownership: "AStack runs",
        },
        {
          pickId: "browser",
          command: "/browser",
          icon: "browser",
          summary: "Hands UI tests, screenshots and console checks to a browser subagent.",
          ownership: "AStack runs",
        },
        {
          pickId: "swarm",
          command: "/swarm",
          badge: "Preview",
          icon: "swarm",
          summary: "Broad work that splits cleanly: named workers and a @verifier coordinate on one shared board.",
          ownership: "AStack runs",
        },
        {
          pickId: "rw",
          command: "/run-workflow",
          icon: "lanes",
          summary: "The same step across many files, or staged phases, run as a script you approve.",
          ownership: "AStack runs",
        },
      ],
    },
    {
      id: "deeper",
      title: "Deeper",
      subtitle: "Hard problems, challenged in rounds",
      icon: "spiral",
      items: [
        {
          pickId: "boost",
          command: "/boost",
          badge: "Paid plans",
          icon: "spiral",
          summary: "Root-cause bugs, race conditions and algorithms. Later workers try to break each attempt before it's accepted.",
          ownership: "AStack suggests",
        },
      ],
    },
    {
      id: "longer",
      title: "Longer",
      subtitle: "Keep going until it's proven",
      icon: "loop",
      items: [
        {
          pickId: "goal",
          command: "/goal",
          icon: "loop",
          summary: "No early stops: it ends only when every deliverable maps to evidence, and it waits for its subagents.",
          ownership: "AStack suggests",
        },
        {
          pickId: "teamwork",
          command: "/teamwork",
          badge: "Paid plans",
          icon: "milestone",
          summary: "Multi-day projects: a scoping interview, a project directory, and milestone audit gates.",
          ownership: "AStack suggests",
        },
      ],
    },
    {
      id: "later",
      title: "Later",
      subtitle: "Run on a timer or on repeat",
      icon: "clock",
      items: [
        {
          pickId: "schedule",
          command: "/schedule",
          icon: "clock",
          summary: "Wakes the agent later in this conversation, once or on a cron. Pairs with /goal for check-ins.",
          ownership: "AStack runs",
        },
        {
          pickId: "automation",
          command: "/automation",
          badge: "App only",
          icon: "cycle",
          summary: "A recurring background task you manage in the Automations tab.",
          ownership: "AStack loads",
        },
      ],
    },
    {
      id: "alongside",
      title: "Alongside",
      subtitle: "Not delegation, but always at hand",
      icon: "fork",
      items: [
        {
          pickId: "btw",
          command: "/btw",
          icon: "fork",
          summary: "A side question in a read-only fork. Agents keep working and your history stays clean.",
          ownership: "You start",
          statusPill: "ask bar",
        },
        {
          pickId: null,
          command: "/plan · /grill-me",
          copyText: "/plan /grill-me",
          icon: "doc",
          summary: "Already in Plan. Use both to turn the interview into a plan before /goal takes over.",
          ownership: "AStack follows",
          statusKind: "plan",
        },
        {
          pickId: null,
          command: "/learn",
          copyText: "/learn",
          icon: "book",
          summary: "After Ship, turns this session's corrections into rules or skills you approve.",
          ownership: "AStack follows",
          statusKind: "learn",
        },
        {
          pickId: null,
          command: "/compact",
          copyText: "/compact",
          badge: "New to AStack",
          icon: "compact",
          summary: "Checkpoints a long /goal run to free up context without losing the thread.",
          ownership: "Not wired yet",
          statusPill: "not wired",
        },
      ],
    },
  ],
  delegateMenu: [
    {
      id: "swarm",
      command: "/swarm",
      icon: "swarm",
      summary: "Split work across named workers",
      prompt: "/swarm <task>. One worker per file or package, plus a @verifier that runs the tests before sign-off.",
    },
    {
      id: "goal",
      command: "/goal",
      icon: "loop",
      summary: "Keep going until checks pass",
      prompt: "/goal <task>. Done when <checkable predicate>.",
    },
    {
      id: "boost",
      command: "/boost",
      icon: "spiral",
      summary: "Stuck on a hard bug or a race",
      prompt: "/boost /astack-mode <hard bug>. Reproduce it, isolate the root cause, fix it, and prove it with repeated clean runs.",
    },
    {
      id: "rw",
      command: "/run-workflow",
      icon: "lanes",
      summary: "Same change across many files",
      prompt: "/run-workflow For each package, apply <change> in an isolated branch workspace, run its tests, and log a one-line result per package.",
    },
    {
      id: "teamwork",
      command: "/teamwork",
      icon: "milestone",
      summary: "Work that will take days",
      prompt: "/teamwork <repo-scale migration or multi-day goal>",
    },
    {
      id: "schedule",
      command: "/schedule",
      icon: "clock",
      summary: "Check back on something later",
      prompt: "/schedule in 30 minutes re-run node --run test and tell me if anything regressed.",
    },
  ],
};
