# FORGE 2.0 — PRODUCT REQUIREMENTS DOCUMENT

## Product Overview
FORGE 2.0 is a self-learning, self-evolving autonomous software factory. It is a Node.js CLI application that transforms raw product ideas into fully deployed, production-ready applications through governed autonomous building via Claude Code CLI.

## Target User
Reid Whitesides — non-technical founder operating multiple businesses, building software using the Visual AI Method. Future: any founder, agency, or developer seeking autonomous application building.

## Core Requirement
Given a raw product idea (text input), FORGE 2.0 must:
1. Generate a comprehensive PRD
2. Design every layer of the application at interaction-level granularity
3. Produce complete governance documentation
4. Execute the build autonomously via Claude Code CLI
5. Monitor execution in real-time with self-healing capability
6. Capture all outcomes in persistent memory
7. Use accumulated memory to improve every future build

## Feature Requirements

### F1: Build Memory Layer
Persistent Supabase database (self-hosted via Docker) storing all build outcomes, error patterns, resolutions, governance versions, and cross-project intelligence. Zero recurring cost.

### F2: Phase 0 — Toolchain Scout
Automated environment scanning, tool discovery, gap analysis, auto-configuration, and toolchain locking before any build begins.

### F3: Phase 1A — PRD Generator
Transform raw idea input into comprehensive PRD using Claude API with Build Memory pattern enrichment.

### F4: Phase 1B — Architecture Engine
Transform approved PRD into complete application design: database, API, frontend, auth, agents, infrastructure, testing — with interaction-level granularity for every user-facing element.

### F5: Phase 1C — Current State Ingestion
Read existing codebases for partial builds, extract decisions as immutable constraints, design only the remaining portions.

### F6: Phase 2 — Governance Generator
Convert design artifacts into FORGE governance documents and dependency-ordered prompt queue.

### F7: Phase 3 — Enhanced Build Executor
Autonomous prompt queue processing with context injection, failure prediction, dynamic prompt rewriting, git branch automation, and checkpoint management.

### F8: Phase 4 — Sentinel
Post-prompt health checking (TypeScript, build, file integrity, schema drift, dependencies) with Autonomous Recovery Mode.

### F9: Phase 5 — Recursive Learner
Post-build analysis, pattern extraction, template evolution, and self-evolving agent creation.

### F10: Project Autopsy + Resurrection
Read failed/abandoned projects, extract intent, diagnose failure, produce reconstruction plan feeding into Phase 1A.

### F11: Dry Run Mode
Simulate full build without executing. Predict cost, time, failures.

### F12: Build Replay
Re-execute from any checkpoint with modified governance.

### F13: Automated Six Laws Verification
Automated checking of 5 of 6 quality laws after build completion.

### F14: Multi-Machine Coordination
Database locks, branch isolation, resource tracking for simultaneous builds.

### F15: Post-Deployment Monitoring
Lightweight telemetry agent in built apps reporting to Build Memory.

### F16: Documentation Generation
Auto-generated README, API docs, schema docs, deploy guide.

### F17: Cost Estimation
Pre-build prediction of token consumption, dollar cost, execution time.

### F18: Browser Automation
Playwright-based web task automation under delegated authority.

### F19: CLI Interface
Commander-based CLI with commands for build, scout, design, resume, replay, status, history, patterns, agents, resurrect, estimate.

## Success Criteria
- Zero-intervention build rate >90% after 5 builds
- Error recurrence <5% after pattern capture
- PRD-to-deploy under 48 hours for standard projects
- Build cost under $20 per application
- At least 1 self-created agent within 10 builds
