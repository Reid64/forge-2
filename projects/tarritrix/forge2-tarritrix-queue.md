# TARRITRIX FORGE 2.0 AUTONOMOUS EXECUTION QUEUE
# Total Prompts: 22 | Estimated Runtime: 12-16 hours CC autonomous
# Each prompt is self-contained with gates, rollback, and commit conventions
# FORGE executes sequentially — if a prompt fails, auto-rollback to previous commit

---

# ============================================================================
# PRE-QUEUE SETUP (Reid executes manually before starting FORGE)
# ============================================================================

# In PowerShell (not CC):
# cd C:\Users\manag\Documents\Tarritrix
# git stash  (stash dirty .npmrc, package.json, pnpm-lock.yaml)
# git tag -a baseline-pre-forge2 -m "Baseline before FORGE 2.0 audit and refactor"
# git push origin baseline-pre-forge2
# npm install -g ecc-agentshield
# npm install -g knip

# ============================================================================
# PHASE 0 — FOUNDATION
# ============================================================================

---
FORGE-PROMPT-01
---

--dangerously-skip-permissions

# FORGE-TARRITRIX-P0-T1: Governance Synchronization
# Phase: 0 (Foundation) | Task: 1 of 22
# Execution target: Claude Code on Windows PowerShell
# Rollback: git reset --hard baseline-pre-forge2

## CONTEXT
You are executing FORGE 2.0 Prompt 1 for Tarritrix 1.0. Read ALL governance documents before taking any action:
1. MASTER_BUILD_SPEC.md
2. SCHEMA_REGISTRY.md
3. BEHAVIORAL_CONTRACTS.md
4. AGENTS.md
5. STATE_OF_THE_BUILD.md
6. BLUEPRINT.md

Current state: Build passes clean (exit 0), tsc --noEmit passes (zero errors), verify:fast chain executes. HEAD is b2dd1fb on master. Governance docs on disk are ~3,729 lines behind the versions that were used in the last active governance session. 7+ commits exist after the last governance sync.

## MISSION
Synchronize all governance documents so they accurately reflect the current codebase state. This is a documentation-only commit — no code changes.

## ACTIONS

### Step 1: Audit current governance state
Read all 6 governance docs. Read the last 10 git log entries with full messages:
```powershell
git log --format="%H %s" -15
```

### Step 2: Update STATE_OF_THE_BUILD.md
Add session entries for any commits not already documented. Update:
- Last updated timestamp to current date/time
- Build state summary header to reflect current HEAD
- ACTIVE BUILD DAG with current status
- VERIFIED CURRENT STATE section
- TEST STATUS table

### Step 3: Update SCHEMA_REGISTRY.md
Run schema introspection against live Supabase:
```powershell
# If Supabase MCP is available, query information_schema.tables
# Otherwise, reconcile migration files against documented tables
```
Ensure table count, migration list, and column specifications match reality.

### Step 4: Reconcile remaining docs
- BLUEPRINT.md: Verify Part 11 and any subsequent additions match committed code
- BEHAVIORAL_CONTRACTS.md: Verify contract count matches committed verification scripts
- AGENTS.md: Verify agent list and operational boundaries match committed routes
- MASTER_BUILD_SPEC.md: Verify Phase 1 scope matches committed features

### Step 5: Verify
```powershell
pnpm verify:fast
```
All governance verification scripts must pass.

## COMMIT
```powershell
git add -A
git commit -m "FORGE-TARRITRIX-P0-T1-governance-sync: synchronize all 6 governance docs with codebase reality

Changes:
- STATE_OF_THE_BUILD.md: added missing session entries for commits post-May-25
- SCHEMA_REGISTRY.md: reconciled table count with live database
- BEHAVIORAL_CONTRACTS.md: verified contract count
- BLUEPRINT.md: verified Part 11+ additions
- AGENTS.md: verified operational boundaries
- MASTER_BUILD_SPEC.md: verified Phase 1 scope

Verification: verify:fast PASS
FORGE-PROMPT: 1 of 22"
```

## GATE
- [ ] verify:fast exits 0
- [ ] governance-lint passes
- [ ] All 6 docs have consistent cross-references
- [ ] STATE_OF_THE_BUILD.md last-updated timestamp is current

## ON FAILURE
```powershell
git reset --hard HEAD~1
```
Report failure reason. Do not proceed to Prompt 2.

---
FORGE-PROMPT-02
---

--dangerously-skip-permissions

# FORGE-TARRITRIX-P0-T2: Dependency Remediation
# Phase: 0 (Foundation) | Task: 2 of 22
# Rollback: git reset --hard HEAD~1

## CONTEXT
Read MASTER_BUILD_SPEC.md and STATE_OF_THE_BUILD.md. Prompt 1 (governance sync) is complete.
Current dependency state: 9 vulnerabilities (1 critical esbuild via tsx, 2 high, 5 moderate, 1 low). Outdated: next 16.2.6→16.2.9, react 19.2.3→19.2.7, radix-ui minor bumps, tailwindcss 4.3.0→4.3.1.

## MISSION
Remediate all dependency vulnerabilities and update outdated packages without breaking the build.

## ACTIONS

### Step 1: Audit current vulnerabilities
```powershell
pnpm audit
```
Document every vulnerability with package name, severity, and advisory URL.

### Step 2: Update dependencies
```powershell
pnpm update
pnpm audit fix
```

### Step 3: Handle Sentry deprecation warnings
Update next.config.ts (or next.config.js) to replace deprecated Sentry options:
- disableLogger → webpack.treeshake.removeDebugLogging
- automaticVercelMonitors → webpack.automaticVercelMonitors
- reactComponentAnnotation → webpack.reactComponentAnnotation

### Step 4: Verify nothing broke
```powershell
pnpm tsc --noEmit
pnpm run build
pnpm verify:fast
```

### Step 5: Re-audit
```powershell
pnpm audit
```
Must return 0 vulnerabilities (or only low-severity with no fix available).

### Step 6: Update STATE_OF_THE_BUILD.md
Append session entry documenting dependency changes, vulnerability count before/after.

## COMMIT
```powershell
git add -A
git commit -m "FORGE-TARRITRIX-P0-T2-dependency-remediation: fix 9 vulnerabilities, update outdated packages

Changes:
- Updated [list packages updated]
- Fixed Sentry deprecation warnings in next.config
- Vulnerability count: 9 → 0

Verification: tsc PASS, build PASS, verify:fast PASS, audit CLEAN
FORGE-PROMPT: 2 of 22"
```

## GATE
- [ ] pnpm audit returns 0 vulnerabilities (or only unfixable low)
- [ ] tsc --noEmit passes
- [ ] pnpm run build exits 0
- [ ] verify:fast passes
- [ ] No new TypeScript errors introduced

## ON FAILURE
```powershell
git checkout -- package.json pnpm-lock.yaml
pnpm install
```
If specific package update breaks build, pin that package at current version and update the rest.

---
FORGE-PROMPT-03
---

--dangerously-skip-permissions

# FORGE-TARRITRIX-P0-T3: Dead Code Removal
# Phase: 0 (Foundation) | Task: 3 of 22
# Rollback: git reset --hard HEAD~1

## CONTEXT
Read STATE_OF_THE_BUILD.md. Prompts 1-2 complete.
Dead code audit found 10 potentially unused exports:
- PortalLoginPage (portal login)
- AgentsPage, ClientsPage, CompliancePage, SettingsPage (dashboard stubs)
- ActivityFeed, LLMCostChart, NextBestActionsPanel, PublishingVelocityChart, SignalsPanel (legacy dashboard _components)

NOTE: Do NOT delete dashboard page files that are referenced by Next.js routing (page.tsx files) — these are auto-discovered by the framework even without explicit imports. Only delete truly orphaned component files.

## MISSION
Remove confirmed dead code. Verify no regressions.

## ACTIONS

### Step 1: Run knip for comprehensive dead code analysis
```powershell
npx knip --reporter compact
```
Cross-reference knip output against the 10 identified exports. Knip may find additional dead code.

### Step 2: Remove confirmed dead files
For each file knip confirms as unused AND that is not a Next.js page.tsx route file:
- Delete the file
- Remove any imports of that file from other files
- Run tsc --noEmit after each deletion to verify no breakage

### Step 3: Clean unused imports across codebase
```powershell
npx knip --fix --include files,exports,types
```
Review changes before committing. Revert any that break compilation.

### Step 4: Verify
```powershell
pnpm tsc --noEmit
pnpm run build
pnpm verify:fast
```

### Step 5: Update STATE_OF_THE_BUILD.md
Document files removed, dead code count before/after.

## COMMIT
```powershell
git add -A
git commit -m "FORGE-TARRITRIX-P0-T3-dead-code-removal: remove orphaned components and unused exports

Removed:
- [list files removed]

Verification: tsc PASS, build PASS, verify:fast PASS, knip CLEAN
FORGE-PROMPT: 3 of 22"
```

## GATE
- [ ] tsc --noEmit passes
- [ ] pnpm run build exits 0
- [ ] verify:fast passes
- [ ] knip reports zero unused exports (or only false positives documented)

## ON FAILURE
Revert individual file deletions that caused breakage. Keep the ones that didn't.

# ============================================================================
# PHASE 1 — BACKEND HARDENING
# ============================================================================

---
FORGE-PROMPT-04
---

--dangerously-skip-permissions

# FORGE-TARRITRIX-P1-T4: B1 Hydration Mismatch Fix
# Phase: 1 (Backend Hardening) | Task: 4 of 22
# Rollback: git reset --hard HEAD~1

## CONTEXT
Read STATE_OF_THE_BUILD.md blocker B1. Open since May 2026.
Symptom: Top portion of marketing site disappears or header masks content on changes affecting Hero/Nav region.
Root cause: UNDIAGNOSED.
Evidence: 11 of 12 marketing components in src/app/_components/marketing/ are 'use client'. Zero suppressHydrationWarning usage. CompareSection.tsx is the only server component.

## MISSION
Diagnose and fix the B1 hydration mismatch. This is a root-cause fix, not a patch.

## ACTIONS

### Step 1: Diagnostic
Read every marketing component file:
```powershell
Get-ChildItem -Path "src\app\_components\marketing" -Include "*.tsx" -Recurse | ForEach-Object { Write-Host "=== $($_.Name) ==="; Get-Content $_.FullName }
```
Read the main page.tsx that assembles them:
```powershell
Get-Content "src\app\page.tsx"
```
Read layout.tsx:
```powershell
Get-Content "src\app\layout.tsx"
```

### Step 2: Identify root cause
Look for:
- Server/client rendering mismatches (Date objects, Math.random, window references in initial render)
- CSS that causes layout shifts (position: fixed/absolute on nav without proper spacing)
- Missing key props in lists
- Conditional rendering based on typeof window
- Dynamic imports without proper loading states
- Content that differs between server and client render pass

### Step 3: Fix root cause
Apply the definitive fix. Do not use suppressHydrationWarning — that's a mask, not a fix.

### Step 4: Verify
```powershell
pnpm tsc --noEmit
pnpm run build
pnpm verify:fast
```
Open in browser (if Playwright available, run visual regression):
```powershell
npx playwright test --grep "marketing" --reporter=line 2>$null; if ($LASTEXITCODE -ne 0) { Write-Host "No marketing Playwright tests found — manual verification needed" }
```

### Step 5: Update STATE_OF_THE_BUILD.md
- Change B1 status from OPEN to CLOSED
- Document root cause and fix
- Append session entry

## COMMIT
```powershell
git add -A
git commit -m "FORGE-TARRITRIX-P1-T4-hydration-fix: diagnose and fix B1 hydration mismatch

Root cause: [describe]
Fix: [describe]
B1 status: CLOSED

Verification: tsc PASS, build PASS, verify:fast PASS
FORGE-PROMPT: 4 of 22"
```

## GATE
- [ ] tsc --noEmit passes
- [ ] pnpm run build exits 0
- [ ] verify:fast passes
- [ ] Marketing site renders without hydration warnings in browser console
- [ ] B1 marked CLOSED in STATE_OF_THE_BUILD.md

## ON FAILURE
If root cause cannot be identified from code inspection alone, document findings and proceed to Prompt 5. B1 will be revisited in Phase 3 (Prompt 16) with browser-level debugging.

---
FORGE-PROMPT-05
---

--dangerously-skip-permissions

# FORGE-TARRITRIX-P1-T5: LLM Call INSERT Ordering Fix
# Phase: 1 (Backend Hardening) | Task: 5 of 22
# Rollback: git reset --hard HEAD~1

## CONTEXT
Read STATE_OF_THE_BUILD.md KNOWN GAPS section: "LLM CALL INSERT ORDERING BUG."
Issue: A-02 inserts llm_calls rows with agent_event_id values referencing agent_events rows that don't exist yet. FK constraint rejects the insert, causing silent telemetry data loss.
Fix scope: Ensure agent_events row is committed before any llm_calls row references it.

## MISSION
Fix the INSERT ordering so agent_events is created before llm_calls references it.

## ACTIONS

### Step 1: Read the agent execution code
```powershell
Get-Content "src\app\api\agents\a-02\trigger\route.ts"
```
Find where agent_events and llm_calls are inserted. Identify the ordering issue.

### Step 2: Read the cost guard and LLM router
```powershell
Get-Content "src\lib\llm\cost-guard.ts" -ErrorAction SilentlyContinue
Get-Content "src\lib\llm\router.ts" -ErrorAction SilentlyContinue
Get-Content "src\lib\llm\index.ts" -ErrorAction SilentlyContinue
```

### Step 3: Fix ordering
Restructure so that:
1. agent_events row is inserted and committed FIRST
2. agent_event_id from that insert is passed to any llm_calls inserts
3. Error handling wraps both operations with Contract 69 (INSERT Error Capture Required)

### Step 4: Verify
```powershell
pnpm tsc --noEmit
pnpm run build
pnpm verify:fast
```

### Step 5: Update STATE_OF_THE_BUILD.md
Move "LLM CALL INSERT ORDERING BUG" from KNOWN GAPS to resolved, with commit reference.

## COMMIT
```powershell
git add -A
git commit -m "FORGE-TARRITRIX-P1-T5-llm-insert-ordering: fix agent_event_id FK violation in llm_calls

Fix: [describe ordering change]
Known gap: LLM CALL INSERT ORDERING BUG → CLOSED

Verification: tsc PASS, build PASS, verify:fast PASS
FORGE-PROMPT: 5 of 22"
```

## GATE
- [ ] tsc --noEmit passes
- [ ] pnpm run build exits 0
- [ ] verify:fast passes
- [ ] Known gap marked CLOSED in STATE_OF_THE_BUILD.md

---
FORGE-PROMPT-06
---

--dangerously-skip-permissions

# FORGE-TARRITRIX-P1-T6: Agent Trigger Resource Ownership
# Phase: 1 (Backend Hardening) | Task: 6 of 22
# Rollback: git reset --hard HEAD~1

## CONTEXT
Read STATE_OF_THE_BUILD.md KNOWN GAPS: "AGENT TRIGGER RESOURCE OWNERSHIP."
2 agent trigger routes (/api/agents/a-02/trigger, /api/agents/a-07/trigger) accept client_id in request body without verifying operator owns that client. Must add Contract 67 ownership verification.

## MISSION
Add resource ownership verification to both agent trigger routes following the established pattern from other operator routes.

## ACTIONS

### Step 1: Read Contract 67 pattern from an existing protected route
```powershell
Get-Content "src\app\api\operator\clients\[id]\route.ts"
```
Identify the ownership verification pattern.

### Step 2: Read both agent trigger routes
```powershell
Get-Content "src\app\api\agents\a-02\trigger\route.ts"
Get-Content "src\app\api\agents\a-07\trigger\route.ts"
```

### Step 3: Add ownership verification
Apply the Contract 67 pattern: after auth check, verify the authenticated operator owns the client_id being targeted. Use getOperatorContext() per Contract 70, getUserActiveRole() + hasPermission() per Contract 71.

### Step 4: Add tests
Create or update integration tests covering unauthorized client_id scenarios.

### Step 5: Verify
```powershell
pnpm tsc --noEmit
pnpm run build
pnpm verify:fast
```

### Step 6: Update STATE_OF_THE_BUILD.md
Move "AGENT TRIGGER RESOURCE OWNERSHIP" from KNOWN GAPS to resolved.

## COMMIT
```powershell
git add -A
git commit -m "FORGE-TARRITRIX-P1-T6-agent-trigger-ownership: add Contract 67 ownership check to a-02/a-07 triggers

Changes:
- src/app/api/agents/a-02/trigger/route.ts: added ownership verification
- src/app/api/agents/a-07/trigger/route.ts: added ownership verification
- Added integration tests for unauthorized client_id scenarios
Known gap: AGENT TRIGGER RESOURCE OWNERSHIP → CLOSED

Verification: tsc PASS, build PASS, verify:fast PASS
FORGE-PROMPT: 6 of 22"
```

## GATE
- [ ] tsc --noEmit passes
- [ ] pnpm run build exits 0
- [ ] verify:fast passes
- [ ] Both routes reject unauthorized client_id with 403
- [ ] Known gap marked CLOSED

# ============================================================================
# PHASE 2 — DASHBOARD UI REBUILD
# ============================================================================

---
FORGE-PROMPT-07
---

--dangerously-skip-permissions

# FORGE-TARRITRIX-P2-T7: Dashboard Scaffold + Layout
# Phase: 2 (Dashboard UI Rebuild) | Task: 7 of 22
# Rollback: git reset --hard HEAD~1

## CONTEXT
Read MASTER_BUILD_SPEC.md (locked color palette, typography), STATE_OF_THE_BUILD.md, and docs/architecture/COMMAND_CENTER_NORTH_STAR_AND_V1_SPEC.md (the rebuild target).

The dashboard currently has 36 .tsx files split between two competing component architectures (Layer 1 panels from Section 23 AND legacy _components from earlier iterations). Strategy: delete all dashboard UI and rebuild from the north star spec on the existing API routes.

CRITICAL PRESERVATIONS:
- Do NOT delete any file under src/app/api/ — all API routes stay
- Do NOT delete src/app/dashboard/layout.tsx QueryProvider integration (React Query must be preserved)
- Do NOT modify any file outside src/app/dashboard/

## MISSION
Delete all dashboard UI components and create a clean scaffold from the Command Center north star spec.

## ACTIONS

### Step 1: Read the north star spec
```powershell
Get-Content "docs\architecture\COMMAND_CENTER_NORTH_STAR_AND_V1_SPEC.md"
```

### Step 2: Inventory files to delete
```powershell
Get-ChildItem -Path "src\app\dashboard" -Recurse -Include "*.tsx" | ForEach-Object { Write-Host $_.FullName }
```

### Step 3: Back up then delete dashboard UI
```powershell
# Create backup branch for reference only
git checkout -b backup/dashboard-pre-rebuild
git checkout master

# Delete all dashboard .tsx files EXCEPT layout.tsx
Get-ChildItem -Path "src\app\dashboard" -Recurse -Include "*.tsx" | Where-Object { $_.Name -ne "layout.tsx" } | Remove-Item -Force
```

### Step 4: Read the existing layout.tsx
```powershell
Get-Content "src\app\dashboard\layout.tsx"
```
Preserve QueryProvider and auth check patterns. Rebuild the layout structure.

### Step 5: Create new dashboard scaffold

Create these files following MASTER_BUILD_SPEC.md color palette and typography:

**src/app/dashboard/layout.tsx** — Rebuild with:
- Sidebar navigation (dark: #0F1729)
- Main content area (#1A2238 background)
- Logo in sidebar (light SVG on dark)
- Navigation items: Dashboard, Clients, Users, Agents, Billing, Compliance, Settings, Pages
- QueryProvider wrapping content area
- Auth check (getOperatorContext per Contract 70)
- getUserActiveRole per Contract 71

**src/app/dashboard/page.tsx** — Command Center home:
- KPI strip placeholder zone
- Charts zone placeholder
- Signals/activity zone placeholder
- Geo-grid zone placeholder
- All zones with "Loading..." states and correct background colors
- 30-second React Query polling on /api/dashboard/stats

**src/app/dashboard/_components/Sidebar.tsx** — Navigation sidebar:
- Logo at top
- Navigation links with icons
- Active state highlighting (#FF6B35 accent)
- Collapsed/expanded toggle
- User role badge at bottom

### Step 6: Create stub pages for all dashboard routes
For each route that Next.js expects, create a minimal page.tsx:
- /dashboard/clients/page.tsx
- /dashboard/clients/new/page.tsx
- /dashboard/clients/[id]/page.tsx
- /dashboard/clients/[id]/flagged/page.tsx
- /dashboard/clients/[id]/pages/[pageId]/page.tsx
- /dashboard/agents/page.tsx
- /dashboard/billing/page.tsx
- /dashboard/compliance/page.tsx
- /dashboard/settings/page.tsx
- /dashboard/pages/page.tsx
- /dashboard/users/page.tsx

Each stub: server component with getOperatorContext auth check, renders page title + "Coming in next build phase" message in correct palette colors.

### Step 7: Verify
```powershell
pnpm tsc --noEmit
pnpm run build
pnpm verify:fast
```

### Step 8: Update STATE_OF_THE_BUILD.md

## COMMIT
```powershell
git add -A
git commit -m "FORGE-TARRITRIX-P2-T7-dashboard-scaffold: delete legacy dashboard UI, create clean scaffold from north star spec

Deleted: [count] legacy dashboard .tsx files
Created: layout.tsx, page.tsx, Sidebar.tsx, [count] stub pages
Architecture: Command Center north star spec
Color palette: MASTER_BUILD_SPEC.md locked palette
Auth: Contract 70 (getOperatorContext) + Contract 71 (RBAC)

Verification: tsc PASS, build PASS, verify:fast PASS
FORGE-PROMPT: 7 of 22"
```

## GATE
- [ ] tsc --noEmit passes
- [ ] pnpm run build exits 0 with all dashboard routes present
- [ ] verify:fast passes
- [ ] /dashboard renders with correct dark palette
- [ ] Sidebar navigation works for all routes
- [ ] Zero 404s on any dashboard route

---
FORGE-PROMPT-08
---

--dangerously-skip-permissions

# FORGE-TARRITRIX-P2-T8: Operator Command Center — KPI Strip + Status Bar
# Phase: 2 (Dashboard UI Rebuild) | Task: 8 of 22
# Rollback: git reset --hard HEAD~1

## CONTEXT
Read MASTER_BUILD_SPEC.md, STATE_OF_THE_BUILD.md, docs/architecture/COMMAND_CENTER_NORTH_STAR_AND_V1_SPEC.md.
Dashboard scaffold (Prompt 7) is complete. /dashboard renders with empty zones.
API route /api/dashboard/stats exists and returns real data.

## MISSION
Build the Operator KPI strip and status bar at the top of the Command Center.

## ACTIONS

### Step 1: Read the stats API to understand data shape
```powershell
Get-Content "src\app\api\dashboard\stats\route.ts"
```

### Step 2: Create KPI strip component
**src/app/dashboard/_components/KpiStrip.tsx**
- 'use client' component
- React Query polling on /api/dashboard/stats (30-second interval via refetchInterval: 30000)
- Display key metrics in cards: Total Clients, Total Pages, Pages Published, Pending Review, Active Agents, System Health
- Card styling: #243049 background, #334155 border, #F5F1E8 text, #06B6D4 accent for data values
- Loading skeleton state
- Error state with retry

### Step 3: Create status bar component
**src/app/dashboard/_components/StatusBar.tsx**
- System health indicator (green/yellow/red dot)
- Last data refresh timestamp
- Polling indicator (subtle pulse animation)
- Current user role badge

### Step 4: Wire into dashboard page.tsx
Import KpiStrip and StatusBar into src/app/dashboard/page.tsx. Place at top of content area.

### Step 5: Verify Six Laws
1. SCHEMA — Stats API reads from real tables
2. API — /api/dashboard/stats returns real data
3. UI — KPI strip renders with real values
4. DATA — All values from API, zero hardcoded
5. WIRING — Polling active, cards clickable where appropriate
6. VERIFICATION — Visual check in browser

### Step 6: Verify
```powershell
pnpm tsc --noEmit
pnpm run build
pnpm verify:fast
```

### Step 7: Update STATE_OF_THE_BUILD.md
Document Section 23 Step 5 as COMPLETE.

## COMMIT
```powershell
git add -A
git commit -m "FORGE-TARRITRIX-P2-T8-kpi-strip: build operator KPI strip with real-time polling

Components: KpiStrip.tsx, StatusBar.tsx
Data source: /api/dashboard/stats (30s polling)
Six Laws: ALL PASS

Verification: tsc PASS, build PASS, verify:fast PASS
FORGE-PROMPT: 8 of 22"
```

## GATE
- [ ] Six Laws all pass
- [ ] tsc, build, verify:fast all pass
- [ ] KPI strip shows real data from API
- [ ] 30-second polling active

---
FORGE-PROMPT-09
---

--dangerously-skip-permissions

# FORGE-TARRITRIX-P2-T9: Operator Command Center — Charts Zone
# Phase: 2 (Dashboard UI Rebuild) | Task: 9 of 22
# Rollback: git reset --hard HEAD~1

## CONTEXT
Read MASTER_BUILD_SPEC.md, docs/architecture/COMMAND_CENTER_NORTH_STAR_AND_V1_SPEC.md.
KPI strip (Prompt 8) is complete. API route /api/dashboard/charts exists.

## MISSION
Build the charts zone with LLM spend tracking, publishing velocity, and conversion funnel visualizations.

## ACTIONS

### Step 1: Read the charts API
```powershell
Get-Content "src\app\api\dashboard\charts\route.ts"
```

### Step 2: Create chart components
Build using recharts (already in dependencies) or build with SVG if recharts is not installed:

**src/app/dashboard/_components/LlmSpendChart.tsx** — Area chart showing LLM cost over time
**src/app/dashboard/_components/PublishingVelocity.tsx** — Bar chart showing pages published per day/week
**src/app/dashboard/_components/ConversionFunnel.tsx** — Funnel visualization for lead conversion

All charts:
- 'use client' with React Query fetching from /api/dashboard/charts
- Dark palette: chart backgrounds transparent, grid lines #334155, data colors #06B6D4 (cyan), #10B981 (green), #FF6B35 (orange)
- Responsive (flex layout)
- Loading skeletons
- Empty states ("No data yet")

### Step 3: Wire into dashboard page.tsx
Add charts zone below KPI strip. Use CSS grid or flex for responsive layout (2 charts per row on desktop, 1 on mobile).

### Step 4: Verify Six Laws and compile
```powershell
pnpm tsc --noEmit
pnpm run build
pnpm verify:fast
```

### Step 5: Update STATE_OF_THE_BUILD.md
Document Section 23 Step 6 as COMPLETE.

## COMMIT
```powershell
git add -A
git commit -m "FORGE-TARRITRIX-P2-T9-charts-zone: LLM spend, publishing velocity, conversion funnel charts

Components: LlmSpendChart.tsx, PublishingVelocity.tsx, ConversionFunnel.tsx
Data source: /api/dashboard/charts
Six Laws: ALL PASS

Verification: tsc PASS, build PASS, verify:fast PASS
FORGE-PROMPT: 9 of 22"
```

## GATE
- [ ] Six Laws pass
- [ ] All verification passes
- [ ] Charts render with real API data or clean empty states

---
FORGE-PROMPT-10
---

--dangerously-skip-permissions

# FORGE-TARRITRIX-P2-T10: Operator Command Center — Signals + Activity
# Phase: 2 (Dashboard UI Rebuild) | Task: 10 of 22
# Rollback: git reset --hard HEAD~1

## CONTEXT
Read docs/architecture/COMMAND_CENTER_NORTH_STAR_AND_V1_SPEC.md.
Charts zone (Prompt 9) complete. API routes exist: /api/dashboard/signals, /api/dashboard/signals/[id]/dismiss, /api/dashboard/activity-feed.

## MISSION
Build the signals panel (advisory warnings with dismiss) and activity feed.

## ACTIONS

### Step 1: Read both APIs
```powershell
Get-Content "src\app\api\dashboard\signals\route.ts"
Get-Content "src\app\api\dashboard\signals\[id]\dismiss\route.ts"
Get-Content "src\app\api\dashboard\activity-feed\route.ts"
```

### Step 2: Create components

**src/app/dashboard/_components/SignalsPanel.tsx**
- Lists active signals/warnings per client
- Color-coded severity: #EF4444 (danger), #F59E0B (warning), #06B6D4 (info)
- Dismiss button per signal (POST to /api/dashboard/signals/[id]/dismiss)
- React Query with 30s polling

**src/app/dashboard/_components/ActivityFeed.tsx**
- Chronological feed of recent agent actions, page publications, client onboardings
- Timestamp formatting
- Action type icons
- React Query polling

### Step 3: Wire into dashboard page.tsx
Add below charts zone. Side-by-side layout (signals left, activity right on desktop).

### Step 4: Verify Six Laws + compile
```powershell
pnpm tsc --noEmit
pnpm run build
pnpm verify:fast
```

### Step 5: Update STATE_OF_THE_BUILD.md
Document Section 23 Step 7 as COMPLETE. Mark Section 23 as FULLY COMPLETE.

## COMMIT
```powershell
git add -A
git commit -m "FORGE-TARRITRIX-P2-T10-signals-activity: signals panel with dismiss + activity feed

Components: SignalsPanel.tsx, ActivityFeed.tsx
Section 23: ALL 7 STEPS COMPLETE
Six Laws: ALL PASS

Verification: tsc PASS, build PASS, verify:fast PASS
FORGE-PROMPT: 10 of 22"
```

## GATE
- [ ] Six Laws pass for both components
- [ ] Signal dismiss persists to database
- [ ] Activity feed shows real agent events
- [ ] Section 23 fully complete in STATE_OF_THE_BUILD.md

---
FORGE-PROMPT-11
---

--dangerously-skip-permissions

# FORGE-TARRITRIX-P2-T11: Clients List + Detail Views
# Phase: 2 (Dashboard UI Rebuild) | Task: 11 of 22
# Rollback: git reset --hard HEAD~1

## CONTEXT
API routes exist: /api/operator/clients (GET list), /api/operator/clients/[id] (GET detail, PUT update).

## MISSION
Rebuild client list view and client detail view with real data.

## ACTIONS

### Step 1: Read API routes
```powershell
Get-Content "src\app\api\operator\clients\route.ts"
Get-Content "src\app\api\operator\clients\[id]\route.ts"
```

### Step 2: Build client list
**src/app/dashboard/clients/page.tsx**
- Server component with getOperatorContext auth
- Fetches client list via API
- Table view: Business Name, Tier, Status, Pages Published, Last Activity
- Search/filter by business name
- Click row → navigate to /dashboard/clients/[id]
- "Add Client" button → /dashboard/clients/new
- Correct palette colors

### Step 3: Build client detail
**src/app/dashboard/clients/[id]/page.tsx**
- Server component with getOperatorContext + Contract 67 ownership check
- Tabbed interface: Overview, Pages, Flagged, GSC, Settings
- Overview tab: client info, tier, subscription status, page count, recent activity
- Real data from /api/operator/clients/[id]

### Step 4: Verify Six Laws + compile
```powershell
pnpm tsc --noEmit
pnpm run build
pnpm verify:fast
```

## COMMIT
```powershell
git add -A
git commit -m "FORGE-TARRITRIX-P2-T11-clients-views: client list with search + tabbed detail view

Pages: clients/page.tsx, clients/[id]/page.tsx
Data: /api/operator/clients, /api/operator/clients/[id]
Six Laws: ALL PASS

Verification: tsc PASS, build PASS, verify:fast PASS
FORGE-PROMPT: 11 of 22"
```

## GATE
- [ ] Client list shows real data
- [ ] Client detail loads for valid client_id
- [ ] Contract 67 ownership check on detail view
- [ ] All verification passes

---
FORGE-PROMPT-12
---

--dangerously-skip-permissions

# FORGE-TARRITRIX-P2-T12: Onboarding Wizard
# Phase: 2 (Dashboard UI Rebuild) | Task: 12 of 22
# Rollback: git reset --hard HEAD~1

## CONTEXT
API route exists: /api/operator/onboard-client (POST). Read BLUEPRINT.md Section 4.1 for the 9-step onboarding specification. Read the latest commit b2dd1fb which added "nationwide service area model" with schema enum + role caps + UI toggle.

## MISSION
Rebuild the operator onboarding wizard at /dashboard/clients/new.

## ACTIONS

### Step 1: Read the onboarding API and existing form (if any remains)
```powershell
Get-Content "src\app\api\operator\onboard-client\route.ts"
```

### Step 2: Read the BLUEPRINT onboarding spec
Search BLUEPRINT.md for the 9-step wizard specification.

### Step 3: Build onboarding form
**src/app/dashboard/clients/new/page.tsx**
- Server component wrapper with auth
**src/app/dashboard/_components/OnboardingWizard.tsx**
- 'use client' multi-step form
- Steps: Business Info, Contact, Service Area (with nationwide toggle from b2dd1fb), Services, Tier Selection, Billing, Integration, Review, Submit
- Form validation per step
- Progress indicator
- Submits to /api/operator/onboard-client
- Success → redirect to /dashboard/clients/[new-id]
- Error handling with retry

### Step 4: Verify Six Laws + compile
```powershell
pnpm tsc --noEmit
pnpm run build
pnpm verify:fast
```

## COMMIT
```powershell
git add -A
git commit -m "FORGE-TARRITRIX-P2-T12-onboarding-wizard: 9-step operator onboarding with nationwide service area model

Components: OnboardingWizard.tsx
Steps: Business Info, Contact, Service Area, Services, Tier, Billing, Integration, Review, Submit
Includes nationwide toggle per b2dd1fb schema

Verification: tsc PASS, build PASS, verify:fast PASS
FORGE-PROMPT: 12 of 22"
```

## GATE
- [ ] Form submits successfully to API
- [ ] All 9 steps navigate correctly
- [ ] Nationwide toggle functional
- [ ] All verification passes

---
FORGE-PROMPT-13
---

--dangerously-skip-permissions

# FORGE-TARRITRIX-P2-T13: Users/RBAC Management UI
# Phase: 2 (Dashboard UI Rebuild) | Task: 13 of 22
# Rollback: git reset --hard HEAD~1

## CONTEXT
API routes exist: /api/operator/users (GET), /api/operator/users/grant (POST), /api/operator/users/change-role (POST), /api/operator/users/revoke (POST). Read ROLE_HIERARCHY_ARCHITECTURE_SPEC.md.

## MISSION
Rebuild the /dashboard/users role management UI.

## ACTIONS

### Step 1: Read all 4 user API routes
```powershell
Get-Content "src\app\api\operator\users\route.ts"
Get-Content "src\app\api\operator\users\grant\route.ts"
Get-Content "src\app\api\operator\users\change-role\route.ts"
Get-Content "src\app\api\operator\users\revoke\route.ts"
```

### Step 2: Build users page and components
**src/app/dashboard/users/page.tsx** — Server component, auth + permission check (view_all_roles)
**src/app/dashboard/users/UsersTable.tsx** — Table with role badges (master_admin=#EF4444, senior_admin=#06B6D4, va=#10B981)
**src/app/dashboard/users/GrantRoleModal.tsx** — Form: user search, role selector, submit
**src/app/dashboard/users/ChangeRoleModal.tsx** — Current role display, new role selector, reason field
**src/app/dashboard/users/RevokeModal.tsx** — Confirmation with "Type REVOKE to confirm", reason field (min 10 chars)

All must enforce Contract 71 (RBAC) and Contract 72 (three-attribute audit attribution).

### Step 3: Verify + compile
```powershell
pnpm tsc --noEmit
pnpm run build
pnpm verify:fast
```

## COMMIT
```powershell
git add -A
git commit -m "FORGE-TARRITRIX-P2-T13-rbac-ui: users table + grant/change/revoke role modals

Components: UsersTable, GrantRoleModal, ChangeRoleModal, RevokeModal
Contracts: 70 (auth), 71 (RBAC), 72 (audit attribution)

Verification: tsc PASS, build PASS, verify:fast PASS
FORGE-PROMPT: 13 of 22"
```

## GATE
- [ ] All RBAC operations work end-to-end
- [ ] Contract 71/72 verification scripts pass
- [ ] Constitutional constraint: cannot revoke last master_admin

---
FORGE-PROMPT-14
---

--dangerously-skip-permissions

# FORGE-TARRITRIX-P2-T14: Flagged Pages Review
# Phase: 2 (Dashboard UI Rebuild) | Task: 14 of 22
# Rollback: git reset --hard HEAD~1

## CONTEXT
API routes: /api/operator/clients/[id]/flagged (GET), /api/operator/clients/[id]/flagged/[pageId]/approve (POST), /api/operator/clients/[id]/flagged/[pageId]/reject (POST).

## MISSION
Rebuild flagged page review workflow.

## ACTIONS

### Step 1: Read API routes
```powershell
Get-Content "src\app\api\operator\clients\[id]\flagged\route.ts"
Get-Content "src\app\api\operator\clients\[id]\flagged\[pageId]\approve\route.ts"
Get-Content "src\app\api\operator\clients\[id]\flagged\[pageId]\reject\route.ts"
```

### Step 2: Build flagged pages UI
**src/app/dashboard/clients/[id]/flagged/page.tsx**
- List of flagged pages with validation failure reasons
- Approve button (sets status to 'queued')
- Reject button with reason field
- Page content preview
- Contract 67 ownership check

### Step 3: Build page detail view
**src/app/dashboard/clients/[id]/pages/[pageId]/page.tsx**
- Full page content display
- Validation results
- Quality scores
- Action buttons (approve/reject if flagged)

### Step 4: Verify + compile
```powershell
pnpm tsc --noEmit
pnpm run build
pnpm verify:fast
```

## COMMIT
```powershell
git add -A
git commit -m "FORGE-TARRITRIX-P2-T14-flagged-pages: review workflow with approve/reject

Pages: flagged/page.tsx, pages/[pageId]/page.tsx
Actions: approve → queued, reject → rejected with reason

Verification: tsc PASS, build PASS, verify:fast PASS
FORGE-PROMPT: 14 of 22"
```

## GATE
- [ ] Approve/reject persist to database
- [ ] Page status transitions correctly
- [ ] All verification passes

---
FORGE-PROMPT-15
---

--dangerously-skip-permissions

# FORGE-TARRITRIX-P2-T15: Remaining Dashboard Pages
# Phase: 2 (Dashboard UI Rebuild) | Task: 15 of 22
# Rollback: git reset --hard HEAD~1

## CONTEXT
Remaining stub pages: agents, billing, compliance, settings, pages (top-level).

## MISSION
Build minimal but functional versions of remaining dashboard pages.

## ACTIONS

### Step 1: Determine which pages have backing APIs
- /api/agents/* routes exist → Agents page can show agent status
- /api/operator/initiate-checkout exists → Billing page can show subscription status
- No compliance-specific API → Compliance page is informational
- No settings-specific API → Settings page is placeholder
- /api/operator/clients/[id]/pages/[pageId] exists → Pages page can aggregate

### Step 2: Build each page
**agents/page.tsx** — Agent status overview (read from agent_events table if API exists, otherwise "Agent monitoring coming in Phase 2")
**billing/page.tsx** — Current Stripe subscription status, link to billing portal
**compliance/page.tsx** — TCPA disclosure status, DSAR management link, sub-processor list
**settings/page.tsx** — Platform configuration (feature flags from platform_config)
**pages/page.tsx** — Cross-client page listing with status filters

Each page: auth check, correct palette, real data where API exists, clean "Phase 2" messaging where it doesn't.

### Step 3: Verify + compile
```powershell
pnpm tsc --noEmit
pnpm run build
pnpm verify:fast
```

## COMMIT
```powershell
git add -A
git commit -m "FORGE-TARRITRIX-P2-T15-stub-pages: agents, billing, compliance, settings, pages

All dashboard routes functional. Real data where APIs exist, Phase 2 messaging where not.

Verification: tsc PASS, build PASS, verify:fast PASS
FORGE-PROMPT: 15 of 22"
```

## GATE
- [ ] Zero 404s on any /dashboard/* route
- [ ] All pages render with correct palette
- [ ] All verification passes

# ============================================================================
# PHASE 3 — INTEGRATION & POLISH
# ============================================================================

---
FORGE-PROMPT-16
---

--dangerously-skip-permissions

# FORGE-TARRITRIX-P3-T16: Marketing Site Polish + Favicon
# Phase: 3 (Integration) | Task: 16 of 22
# Rollback: git reset --hard HEAD~1

## MISSION
Verify B1 fix holds (from Prompt 4), fix favicon rendering, address Next.js middleware→proxy deprecation warning.

## ACTIONS

### Step 1: If B1 was not fixed in Prompt 4, diagnose it now with full browser-level analysis
Check the build output for hydration warnings. Read all marketing components carefully.

### Step 2: Fix favicon
Read current favicon setup:
```powershell
Get-ChildItem "public" -Include "favicon*","apple-touch*","*.ico" -Recurse
Get-Content "src\app\layout.tsx" | Select-String "icon|favicon"
```
Rebuild as clean SVG. Ensure proper sizes for all contexts (16x16, 32x32, 180x180 apple-touch, site.webmanifest).

### Step 3: Address middleware deprecation
Next.js 16 warns about middleware→proxy rename. Read the Next.js docs and update if it's a simple rename that doesn't break functionality.
CAUTION: Do NOT break the existing auth check. The middleware currently only does a cookie presence check for /dashboard redirect. If the proxy convention requires different semantics, leave middleware as-is and document the deprecation as a known warning.

### Step 4: Verify
```powershell
pnpm tsc --noEmit
pnpm run build
pnpm verify:fast
```

## COMMIT
```powershell
git add -A
git commit -m "FORGE-TARRITRIX-P3-T16-marketing-polish: favicon rebuild + middleware deprecation assessment

Favicon: rebuilt as clean SVG with proper sizes
Middleware: [addressed/documented as known warning]

Verification: tsc PASS, build PASS, verify:fast PASS
FORGE-PROMPT: 16 of 22"
```

---
FORGE-PROMPT-17
---

--dangerously-skip-permissions

# FORGE-TARRITRIX-P3-T17: Client Portal Verification
# Phase: 3 (Integration) | Task: 17 of 22
# Rollback: git reset --hard HEAD~1

## MISSION
Verify client portal still functions correctly after dashboard rebuild. The MonthlyGrowthTimeline component (90-Day Growth Timeline chart) must be visually identical.

## ACTIONS

### Step 1: Verify portal components exist and compile
```powershell
Get-ChildItem "src\app\portal" -Recurse -Include "*.tsx" | ForEach-Object { Write-Host $_.Name }
Get-Content "src\components\MonthlyGrowthTimeline.tsx" | Select-Object -First 5
```

### Step 2: Verify portal API routes
```powershell
Get-ChildItem "src\app\api\portal" -Recurse -Include "route.ts" | ForEach-Object { Write-Host $_.FullName }
```

### Step 3: Run portal-specific Playwright tests if they exist
```powershell
npx playwright test --grep "portal" --reporter=line 2>$null
```

### Step 4: Build verification
```powershell
pnpm tsc --noEmit
pnpm run build
```

### Step 5: Update STATE_OF_THE_BUILD.md
Confirm portal status as VERIFIED post-rebuild.

## COMMIT
```powershell
git add -A
git commit -m "FORGE-TARRITRIX-P3-T17-portal-verification: client portal verified post-dashboard-rebuild

Portal: ALL routes functional
MonthlyGrowthTimeline: PRESERVED, visually identical
No regressions detected

Verification: tsc PASS, build PASS
FORGE-PROMPT: 17 of 22"
```

---
FORGE-PROMPT-18
---

--dangerously-skip-permissions

# FORGE-TARRITRIX-P3-T18: Governance Final Sync
# Phase: 3 (Integration) | Task: 18 of 22
# Rollback: git reset --hard HEAD~1

## MISSION
Final synchronization of all 6 governance documents to reflect the complete FORGE 2.0 refactor.

## ACTIONS

### Step 1: Update STATE_OF_THE_BUILD.md
- Add comprehensive FORGE 2.0 session log covering all 17 previous prompts
- Update ACTIVE BUILD DAG
- Update VERIFIED CURRENT STATE
- Update TEST STATUS
- Close all resolved KNOWN GAPS and OPEN BLOCKERS
- Update Section 23 status to COMPLETE

### Step 2: Update MASTER_BUILD_SPEC.md
- Mark completed Phase 1 surfaces
- Update any changed specifications

### Step 3: Update remaining docs as needed
- SCHEMA_REGISTRY.md: verify table count
- BEHAVIORAL_CONTRACTS.md: verify contract count
- BLUEPRINT.md: update Surface 3 description
- AGENTS.md: no changes expected

### Step 4: Run all governance verification
```powershell
pnpm verify:fast
```

### Step 5: Verify governance-lint specifically
```powershell
npx tsx scripts/governance-lint.ts
```

## COMMIT
```powershell
git add -A
git commit -m "FORGE-TARRITRIX-P3-T18-governance-sync: final governance synchronization post-FORGE-2.0

All 6 governance docs synchronized with codebase
FORGE 2.0 session log appended
Section 23: COMPLETE
Open blockers: [list closed]

Verification: verify:fast PASS, governance-lint PASS
FORGE-PROMPT: 18 of 22"
```

---
FORGE-PROMPT-19
---

--dangerously-skip-permissions

# FORGE-TARRITRIX-P3-T19: Test Suite Update
# Phase: 3 (Integration) | Task: 19 of 22
# Rollback: git reset --hard HEAD~1

## MISSION
Update Playwright E2E tests for rebuilt dashboard. Ensure coverage across all 6 surfaces.

## ACTIONS

### Step 1: Inventory existing tests
```powershell
Get-ChildItem "tests" -Recurse -Include "*.spec.ts","*.test.ts" | ForEach-Object { Write-Host $_.Name }
```

### Step 2: Create/update dashboard E2E tests
**tests/e2e/dashboard.spec.ts**
- Dashboard loads with auth
- KPI strip shows data
- Sidebar navigation works for all routes
- Client list loads
- Onboarding wizard renders all steps

### Step 3: Verify existing tests still pass
```powershell
pnpm vitest run
```

### Step 4: Run Playwright if configured
```powershell
npx playwright test --reporter=line 2>$null; Write-Host "Playwright exit: $LASTEXITCODE"
```

## COMMIT
```powershell
git add -A
git commit -m "FORGE-TARRITRIX-P3-T19-test-suite: updated E2E tests for rebuilt dashboard

Tests updated: [count]
Tests added: [count]
Coverage: all 6 surfaces

Verification: vitest PASS, playwright [PASS/SKIPPED]
FORGE-PROMPT: 19 of 22"
```

# ============================================================================
# PHASE 4 — SENTINEL VERIFICATION
# ============================================================================

---
FORGE-PROMPT-20
---

--dangerously-skip-permissions

# FORGE-TARRITRIX-P4-T20: AgentShield Security Scan
# Phase: 4 (Sentinel) | Task: 20 of 22
# Rollback: git reset --hard HEAD~1

## MISSION
Run AgentShield security scan. Grade B+ required to pass.

## ACTIONS

### Step 1: Run AgentShield
```powershell
npx ecc-agentshield scan --format json 2>&1 | Out-File "agentshield-results.json" -Encoding utf8
npx ecc-agentshield scan
```

### Step 2: Evaluate grade
If grade is B+ or above: PASS. Proceed.
If grade is below B+: Remediate findings. Re-scan. Repeat until B+.

### Step 3: Fix any critical/high findings
Address in priority order: secrets detected > injection vectors > insecure defaults > missing headers.

### Step 4: Verify no regressions from fixes
```powershell
pnpm tsc --noEmit
pnpm run build
pnpm verify:fast
```

## COMMIT
```powershell
git add -A
git commit -m "FORGE-TARRITRIX-P4-T20-security-scan: AgentShield grade [GRADE]

Findings: [count] total, [count] remediated
Grade: [GRADE] (B+ minimum required)

Verification: tsc PASS, build PASS, verify:fast PASS
FORGE-PROMPT: 20 of 22"
```

## GATE
- [ ] AgentShield grade B+ or above
- [ ] Zero critical findings remaining
- [ ] All verification passes

---
FORGE-PROMPT-21
---

--dangerously-skip-permissions

# FORGE-TARRITRIX-P4-T21: Full Verification Pipeline
# Phase: 4 (Sentinel) | Task: 21 of 22
# Rollback: git reset --hard HEAD~1

## MISSION
Run the complete verify:ci pipeline. Every gate must pass.

## ACTIONS

### Step 1: Run verify:fast (quick gate)
```powershell
pnpm verify:fast
```

### Step 2: Run full build
```powershell
pnpm run build
```

### Step 3: Run Playwright (if configured for CI)
```powershell
npx playwright test --project=chromium --reporter=line 2>$null; Write-Host "Playwright exit: $LASTEXITCODE"
```

### Step 4: Run schema verification
```powershell
npx tsx scripts/verify-schema.ts 2>$null; Write-Host "Schema verify exit: $LASTEXITCODE"
```

### Step 5: Document results
Create a verification report:
```
FORGE 2.0 Final Verification Report
====================================
tsc --noEmit:          [PASS/FAIL]
vitest:                [PASS/FAIL] ([count] tests)
verify-env:            [PASS/FAIL]
governance-lint:       [PASS/FAIL]
verify-contracts:      [PASS/FAIL]
verify-insert-patterns:[PASS/FAIL]
verify-operator-auth:  [PASS/FAIL]
verify-state-build:    [PASS/FAIL]
verify-permission-matrix: [PASS/FAIL]
verify-rbac-pattern:   [PASS/FAIL]
verify-audit-attribution: [PASS/FAIL]
verify-schema:         [PASS/FAIL]
pnpm build:            [PASS/FAIL]
playwright:            [PASS/FAIL/SKIPPED]
AgentShield:           [GRADE]
pnpm audit:            [count] vulnerabilities
```

## COMMIT
```powershell
git add -A
git commit -m "FORGE-TARRITRIX-P4-T21-full-verification: all gates pass

Verification report: [summary]
All 12+ verification scripts: PASS
Build: PASS
Security: [GRADE]

FORGE-PROMPT: 21 of 22"
```

## GATE
- [ ] Every single verification script exits 0
- [ ] Build exits 0
- [ ] Zero critical issues remaining

---
FORGE-PROMPT-22
---

--dangerously-skip-permissions

# FORGE-TARRITRIX-P4-T22: Production Deployment + Release Tag
# Phase: 4 (Sentinel) | Task: 22 of 22
# Rollback: git reset --hard HEAD~1

## MISSION
Deploy to Vercel production. Create release tag. Confirm all routes live.

## ACTIONS

### Step 1: Push to origin
```powershell
git push origin master
```

### Step 2: Deploy to Vercel
```powershell
npx vercel --prod --yes 2>&1
```
Wait for deployment to complete. Capture deployment URL.

### Step 3: Verify production
Confirm these return 200:
- tarritrix.com (marketing site)
- tarritrix.com/login
- tarritrix.com/dashboard (should redirect to login if not authenticated)
- tarritrix.com/portal/login

### Step 4: Create release tag
```powershell
$date = Get-Date -Format "yyyy-MM-dd"
git tag -a "refactor-complete-$date" -m "FORGE 2.0 refactor complete: 22 prompts, full dashboard rebuild, all gates pass"
git push origin "refactor-complete-$date"
```

### Step 5: Final STATE_OF_THE_BUILD.md update
```
FORGE 2.0 REFACTOR COMPLETE
Date: [current date]
Prompts executed: 22/22
Tag: refactor-complete-[date]
Production: LIVE
All verification gates: PASS
```

## COMMIT
```powershell
git add -A
git commit -m "FORGE-TARRITRIX-P4-T22-production-deploy: FORGE 2.0 refactor complete

Deployed to Vercel production
Tagged: refactor-complete-[date]
All 22 prompts executed successfully
All verification gates passed

FORGE-PROMPT: 22 of 22 — QUEUE COMPLETE"
git push origin master
```

## GATE
- [ ] Vercel deployment returns READY
- [ ] tarritrix.com returns 200
- [ ] Git tag pushed to origin
- [ ] STATE_OF_THE_BUILD.md reflects completion

# ============================================================================
# END OF FORGE 2.0 QUEUE
# ============================================================================
#
# Total prompts: 22
# Phase 0 (Foundation): 3 prompts
# Phase 1 (Backend Hardening): 3 prompts
# Phase 2 (Dashboard UI Rebuild): 9 prompts
# Phase 3 (Integration & Polish): 4 prompts
# Phase 4 (Sentinel Verification): 3 prompts
#
# Rollback at any point: git reset --hard baseline-pre-forge2
# Per-prompt rollback: git reset --hard HEAD~1
#
# ============================================================================
