> **FORGE Enterprise Governance, Project Structure & Source-of-Truth
> Framework**

- FORGE.md --- the supreme project-level operating contract. Defines
  what FORGE is allowed to do, project mission, readiness target,
  autonomy boundaries, completion criteria, and authoritative
  documentation.

- CLAUDE.md --- Claude-specific operating instructions only. Do not let
  it become the whole governance system.

- RULES.md --- hard engineering rules that agents cannot casually
  override.

- TOOLS.md --- approved tools, MCP servers, APIs, CLIs, permissions,
  when each may be invoked, and prohibited tool use.

- MODEL-ROUTING.md --- which LLM is used for architecture, frontend
  design, debugging, security review, consensus, research, code
  generation, etc.

- CONTEXT.md --- stable project context that every agent should know.

- NOW.md --- current active state: what is being built, current
  milestone, active blockers, next work.

- DECISIONS.md or preferably an /adr/ folder --- records why important
  architectural choices were made.

- MEMORY/ --- durable, validated knowledge FORGE may reuse.

- SKILLS/ --- reusable capabilities such as frontend design, database
  migration, security auditing, Playwright validation, queue generation,
  retrofit analysis.

- WORKFLOWS/ --- deterministic multi-step procedures.

- QUEUES/ --- generated queue YAML files.

- TESTING/ --- test policies, validation matrices, acceptance criteria,
  and readiness-level test requirements.

- SECURITY/ --- threat model, secure coding rules, secrets policy,
  tenant isolation policy, vulnerability response.

- GOVERNANCE/ --- authority hierarchy, human approval gates,
  self-improvement rules, change-control rules, audit requirements.

- ARCHITECTURE/ --- PRD, architecture, schema, system diagrams,
  infrastructure, API contracts, agent architecture, data flows.

- RUNS/ --- runtime logs, prompt timings, retries, test runs, model
  consensus results, failures, remediation.

- DESIGN/ --- design system, brand rules, design-routing rules,
  screenshots, approval history, visual QA.

I would structure a serious FORGE-controlled repository roughly like
this:

PROJECT-ROOT/

│ ├── SYSTEM-ARCHITECTURE.md

│ ├── DATA-ARCHITECTURE.md

│ ├── SECURITY-ARCHITECTURE.md

│ ├── API-ARCHITECTURE.md

│ ├── AGENT-ARCHITECTURE.md

│ ├── INFRASTRUCTURE.md

│ └── adr/

│

├── design/

│ ├── DESIGN-SYSTEM.md

│ ├── DESIGN-ROUTING.md

│ ├── BRAND.md

│ ├── COMPONENT-RULES.md

│ ├── visual-reviews/

│ └── approvals/

│

├── testing/

│ ├── TEST-STRATEGY.md

│ ├── VALIDATION-MATRIX.md

│ ├── SECURITY-TESTING.md

│ ├── PERFORMANCE-TESTING.md

│ └── RELEASE-GATES.md

│

├── memory/

│ ├── index.md

│ ├── validated-patterns/

│ ├── lessons-learned/

│ └── rejected-patterns/

│

├── skills/

│ ├── frontend-design/

│ ├── code-review/

│ ├── security-review/

│ ├── playwright/

│ ├── database/

│ └── retrofit/

│

├── workflows/

│ ├── new-build.yaml

│ ├── continue-build.yaml

│ ├── resurrect-build.yaml

│ ├── deploy.yaml

│ └── incident-recovery.yaml

│

├── queues/

│ ├── library/

│ ├── active/

│ ├── completed/

│ └── failed/

│

├── runs/

│ └── \<run-id\>/

│

├── scripts/

│ ├── powershell/

│ └── python/

│

├── src/

├── tests/

├── .env.example

├── .gitignore

└── package.json

The key difference from the screenshot is that FORGE should have an
explicit hierarchy of authority. Otherwise you eventually get
contradictory instructions across CLAUDE.md, RULES.md, CONTEXT.md, skill
files, queue files, and prompts.

I would define precedence something like:

1\. HUMAN APPROVAL / PROJECT OWNER DIRECTIVE

2\. FORGE.md

3\. GOVERNANCE POLICIES

4\. SECURITY POLICIES

5\. ARCHITECTURE / ADRs

6\. RULES.md

7\. PROJECT MANIFEST

8\. WORKFLOW

9\. QUEUE YAML

10\. SKILL INSTRUCTIONS

11\. MODEL-SPECIFIC FILES, e.g. CLAUDE.md

12\. CURRENT PROMPT

13\. AGENT-GENERATED SUGGESTIONS

That solves an important autonomous-agent problem: if a queue YAML tells
Claude to do something that conflicts with a security rule, the security
rule automatically wins.

I would also add one file that is missing from the screenshot and that I
consider extremely important for FORGE:

SOURCE-OF-TRUTH.md

It should tell agents exactly which documents are authoritative for each
subject.

For example:

product_requirements: architecture/PRD.md

database_schema: architecture/DATA-ARCHITECTURE.md

security: security/SECURITY-POLICY.md

current_work: NOW.md

design: design/DESIGN-SYSTEM.md

deployment: architecture/INFRASTRUCTURE.md

testing: testing/VALIDATION-MATRIX.md

That prevents an autonomous agent from finding an old specification
buried somewhere and treating it as current.

Another useful addition would be a machine-readable manifest.yaml rather
than relying entirely on Markdown:

project:

name: FORGE

mode: autonomous_software_factory

target_readiness: enterprise-grade

authority:

root_policy: FORGE.md

rules: RULES.md

current_state: NOW.md

autonomy:

enabled: true

queue_generation: true

auto_repair: true

approval_required:

production_deploy: true

destructive_migration: true

security_policy_change: true

design_selection: true

consensus:

architecture: required

repeated_failure_threshold: 3

testing:

policy: testing/VALIDATION-MATRIX.md

FORGE can parse that deterministically instead of asking an LLM to
interpret prose every time.
