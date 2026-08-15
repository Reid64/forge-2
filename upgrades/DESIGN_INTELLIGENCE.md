[**FORGE Design Intelligence & Visual Approval Engine**.]{.underline}

Build a first-class subsystem to FORGE called the **FORGE Design
Intelligence & Visual Approval Engine**.

The important point is that FORGE should not simply "have four design
plugins installed." It should understand what each one is good at,
classify the interface it is building, select the right design
capability, combine tools when appropriate, generate several competing
designs, render them, test them, capture screenshots, and require your
approval before it is allowed to merge or deploy frontend work.

One correction is important: taste-skill itself explicitly says its main
frontend skill is aimed at landing pages, portfolios, and redesigns and
is "not dashboards, not data tables, not multi-step product UI." That
means FORGE should not blindly use it for an admin dashboard just
because it is popular. Impeccable is much broader for product
interfaces: its own specification covers visual hierarchy, information
architecture, accessibility, responsive behavior, typography, spacing,
layout, motion, error states, edge cases, design systems, and related
product-UI concerns.

I would build the architecture like this:

FORGE MASTER ORCHESTRATOR

\|

v

DESIGN INTELLIGENCE ENGINE

\|

+\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\--+\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\--+

\| \| \|

v v v

APP PROFILER DESIGN ROUTER BRAND PROFILER

\| \| \|

+\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\--+\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\--+

\|

v

DESIGN STRATEGY PLAN

\|

+\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\--+\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\--+

\| \| \|

v v v

TASTE-SKILL IMPECCABLE AWESOME-DESIGN

Landing/marketing Product/dashboard Direction/reference

\| \| \|

+\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\--+\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\--+

\|

specialized capability

\|

IMG2THREEJS

\|

v

IMPLEMENTATION AGENT

\|

v

PLAYWRIGHT

\|

+\-\-\-\-\-\-\-\-\-\-\-\--+\-\-\-\-\-\-\-\-\-\-\-\--+

\| \| \|

v v v

DESIGN A DESIGN B DESIGN C

\| \| \|

+\-\-\-\-\-\-\-\-\-\-\-\--+\-\-\-\-\-\-\-\-\-\-\-\--+

\|

SCREENSHOT CAPTURE

\|

v

VISUAL QA / AUDIT

\|

v

HUMAN APPROVAL GATE

\|

+\-\-\-\-\-\-\-\-\-\-\-\--+\-\-\-\-\-\-\-\-\-\-\-\--+

\| \|

APPROVE REJECT

\| \|

v v

MERGE / CONTINUE ITERATE

\|

v

DEPLOY

The key is the **Design Router**.

FORGE should first create an AppDesignProfile before any frontend
generation occurs.

For example:

project:

name: Architectural Flashing Supply

application_type:

primary: b2b_commerce

secondary:

\- manufacturing

\- architect_portal

\- customer_portal

\- quoting_system

interface_types:

\- marketing_site

\- customer_dashboard

\- production_dashboard

\- architect_workspace

\- product_configurator

\- 3d_visualizer

brand:

tone:

\- industrial

\- precise

\- premium

\- architectural

avoid:

\- playful

\- cartoonish

\- generic_saas

\- excessive_gradients

visual_complexity: high

motion_requirement: moderate

3d_requirement: high

data_density:

marketing: low

dashboard: high

target_users:

\- architects

\- contractors

\- estimators

\- fabricators

\- customers

Then the router scores available design systems.

Something like:

DESIGN CAPABILITY SCORE

Marketing Dashboard Motion 3D Audit

Taste Skill 10 3 9 2 5

Impeccable 8 10 8 2 10

Awesome Design 9 7 7 2 4

img2threejs 1 1 6 10 1

Playwright 0 0 0 0 10

That table becomes machine-readable configuration rather than merely
documentation.

For example:

design_tools:

taste_skill:

capabilities:

landing_page: 1.00

marketing_site: 1.00

portfolio: 0.95

brand_expression: 0.95

motion: 0.90

dashboard: 0.25

dense_application_ui: 0.20

impeccable:

capabilities:

dashboard: 1.00

application_ui: 1.00

visual_audit: 1.00

accessibility: 0.95

typography: 1.00

spacing: 1.00

interaction_design: 0.95

polish: 1.00

awesome_design:

capabilities:

aesthetic_direction: 1.00

style_reference: 1.00

design_system_inspiration: 0.90

remixing: 0.95

img2threejs:

capabilities:

3d_reconstruction: 1.00

product_geometry: 1.00

procedural_geometry: 1.00

shaders: 0.95

playwright:

capabilities:

screenshot_capture: 1.00

responsive_validation: 1.00

interaction_validation: 1.00

browser_validation: 1.00

That gives FORGE actual reasoning criteria.

The main taste-skill repository now includes multiple variants,
including an image-to-code pipeline and a stricter GPT/Codex-oriented
taste variant. Impeccable exposes 23 commands and is structured
specifically around operations such as audit, polish, critique and other
targeted frontend improvements. Awesome Claude Design is particularly
useful as a reference/design-direction library because it organizes
DESIGN.md material by aesthetic families and includes remix recipes; it
even contains workflows for extracting a design system from an existing
repository.

So FORGE might make decisions like:

PROJECT: TARRITRIX

PAGE TYPE:

OPERATOR COMMAND CENTER

DETECTED REQUIREMENTS:

High data density

Enterprise SaaS

Multiple navigation levels

Analytics visualization

Low decorative motion

Strong information hierarchy

DESIGN ROUTING:

PRIMARY:

IMPECCABLE

SECONDARY:

AWESOME-DESIGN

Enterprise / technical aesthetic references

VALIDATION:

PLAYWRIGHT

AXE

LIGHTHOUSE

TASTE-SKILL:

NOT SELECTED

Reason: dashboard/product UI outside primary specialization.

But for a roofing homepage:

PROJECT: E4 ROOFING

PAGE TYPE:

PUBLIC MARKETING HOMEPAGE

DESIGN ROUTING:

PRIMARY:

TASTE-SKILL

SECONDARY:

AWESOME-DESIGN

POLISH:

IMPECCABLE

VALIDATION:

PLAYWRIGHT

AXE

LIGHTHOUSE

And for AFS:

PROJECT: ARCHITECTURAL FLASHING SUPPLY

PAGE:

FLASHING CONFIGURATOR

PRIMARY:

IMPECCABLE

SPECIALIZED:

IMG2THREEJS

SUPPORTING:

AWESOME-DESIGN

POLISH:

IMPECCABLE

VALIDATION:

PLAYWRIGHT

img2threejs is especially appropriate for the latter because the project
is specifically oriented around reconstructing visual references using
procedural Three.js primitives, shaders and generated geometry.

The second major addition should be a **Design Tournament**.

FORGE should never immediately commit the first AI-generated frontend.

Instead:

DESIGN BRIEF

\|

v

Generate 3-5 independent design directions

\|

+\-\-\-\-\-\-\-\--+\-\-\-\-\-\-\-\--+\-\-\-\-\-\-\-\--+

\| \| \| \|

A B C D

\| \| \| \|

v v v v

Implement Implement Implement Implement

\| \| \| \|

+\-\-\-\-\-\-\-\--+\-\-\-\-\-\-\-\--+\-\-\-\-\-\-\-\--+

\|

v

Playwright

\|

v

Screenshot Suite

\|

v

Automated Scoring

\|

v

HUMAN APPROVAL

For example:

DESIGN A

Architectural Precision

DESIGN B

Industrial Editorial

DESIGN C

Premium Technical

DESIGN D

Minimal Engineering

Critically, these should not just be four color variations.

FORGE should intentionally force significant differences across:

layout

navigation

information density

typography

card structure

sidebar architecture

dashboard composition

hero composition

interaction model

motion

data visualization

spacing

content hierarchy

You could define a minimum variance requirement:

design_tournament:

variants: 4

minimum_variance:

layout: 0.70

navigation: 0.50

typography: 0.40

component_composition: 0.60

information_hierarchy: 0.60

prohibit:

\- color_only_variants

\- font_only_variants

\- trivial_spacing_variants

That is important. Otherwise an AI will generate four versions that are
essentially the same page.

I would actually create a **Design Variance Controller**.

For example:

VARIANT A

DESIGN_VARIANCE = 0.35

MOTION_INTENSITY = 0.15

DENSITY = HIGH

VARIANT B

DESIGN_VARIANCE = 0.65

MOTION_INTENSITY = 0.35

DENSITY = MEDIUM

VARIANT C

DESIGN_VARIANCE = 0.85

MOTION_INTENSITY = 0.55

DENSITY = MEDIUM

VARIANT D

DESIGN_VARIANCE = 0.95

MOTION_INTENSITY = 0.20

DENSITY = LOW

Then FORGE deliberately explores the design space rather than converging
immediately.

The third major component is the **Visual Approval Environment**.

Before anything goes into production, FORGE starts a local or preview
build.

Playwright then visits every required screen and captures them.

For example:

.forge/

design-review/

run-0042/

option-a/

desktop/

homepage.png

dashboard.png

clients.png

analytics.png

settings.png

tablet/

dashboard.png

clients.png

mobile/

homepage.png

dashboard.png

option-b/

option-c/

option-d/

design-review.json

scores.json

Playwright is well suited to this role because it supports browser
automation across Chromium, Firefox and WebKit and already provides
screenshot/browser-testing primitives.

FORGE should capture at minimum:

DESKTOP

1920 × 1080

LAPTOP

1440 × 900

TABLET

768 × 1024

MOBILE

390 × 844

Not every page necessarily needs four screenshots every time. FORGE
could intelligently select representative screens.

For a large application:

LOGIN

DASHBOARD

PRIMARY WORKSPACE

DETAIL PAGE

CREATE/EDIT FLOW

ADMIN

SETTINGS

MOBILE DASHBOARD

Then FORGE can create an HTML approval gallery.

Something like:

=================================================================

TARRITRIX

DESIGN REVIEW #14

=================================================================

DESIGN A --- COMMAND CENTER

Automated score: 91/100

\[DESKTOP SCREENSHOT\]

\[View Mobile\]

\[View Dashboard\]

\[View Client Workspace\]

\[APPROVE A\]

DESIGN B --- INTELLIGENCE CONSOLE

Automated score: 94/100

\[DESKTOP SCREENSHOT\]

\[APPROVE B\]

DESIGN C --- OPERATIONS GRID

Automated score: 88/100

\[DESKTOP SCREENSHOT\]

\[APPROVE C\]

\[REQUEST NEW DESIGNS\]

=================================================================

The automated score should never be allowed to replace your selection.

It simply helps rank them.

For example:

design_score:

visual_hierarchy: 15

brand_alignment: 15

usability: 20

accessibility: 10

responsive_quality: 10

consistency: 10

information_architecture: 10

performance: 5

originality: 5

total: 100

Then Impeccable performs an audit on each candidate. Its audit command
is specifically designed to produce measurable implementation-quality
findings rather than simply subjective critique.

FORGE could produce:

DESIGN A --- 92

Hierarchy 14/15

Usability 18/20

Brand Alignment 15/15

Accessibility 9/10

Responsiveness 10/10

Consistency 9/10

Information Arch. 9/10

Performance 4/5

Originality 4/5

And importantly:

FORGE RECOMMENDATION:

DESIGN B

REASON:

Superior information hierarchy for high-density operator workflows.

Lower cognitive load.

Better separation between client and platform operations.

More scalable navigation system.

But:

STATUS:

AWAITING HUMAN DESIGN APPROVAL

The most important governance rule would be:

NO PRODUCTION FRONTEND DEPLOYMENT

WITHOUT DESIGN_APPROVAL = TRUE

This should be a genuine architectural gate.

For example:

design_governance:

visual_approval_required: true

deployment_gate:

require_human_approval: true

approved_design:

design_id: null

approved_by: null

approved_at: null

Until you choose:

approved_design:

design_id: design-b

approved_by: Reid

approved_at: 2026-08-13T16:21:43-05:00

FORGE cannot promote it.

There is another important feature I would add: **component-level
approval**.

You may like:

Dashboard from Design B

Sidebar from Design C

Header from Design A

Analytics cards from Design D

FORGE should support that.

You could select:

approved_composition:

shell: design_b

sidebar: design_c

top_navigation: design_b

analytics:

design_d

tables:

design_b

modal_system:

design_a

FORGE then assembles a fifth version:

DESIGN E

COMPOSITE USER-SELECTION

renders it again, screenshots it again, and returns it for final
approval.

That would give you substantially more control than simply saying:

Make it look better.

I would also add a **Design Memory**.

Every time you approve or reject something, FORGE records the decision:

design_memory:

prefers:

\- strong_information_hierarchy

\- premium_industrial

\- larger_spacing

\- restrained_motion

\- realistic_photography

\- clear_navigation

\- non_generic_dashboard_layouts

rejects:

\- excessive_gradients

\- ai_slop_icons

\- unnecessary_glassmorphism

\- cramped_cards

\- excessive_rounded_boxes

\- decorative_charts

Then your approvals gradually become empirical design preferences.

That means FORGE eventually learns:

Reid historically prefers Design B-like layouts

for industrial B2B applications.

But it should still generate alternatives instead of collapsing
everything into one style.

The selection algorithm could roughly work like this:

def select_design_pipeline(profile):

tools = \[\]

if profile.has_3d_product_geometry:

tools.append(\"img2threejs\")

if profile.interface_type in \[

\"dashboard\",

\"admin\",

\"saas\",

\"workflow\",

\"data_application\"

\]:

tools.append(\"impeccable\")

if profile.interface_type in \[

\"landing_page\",

\"marketing_site\",

\"brand_site\"

\]:

tools.append(\"taste-skill\")

if profile.needs_aesthetic_exploration:

tools.append(\"awesome-design\")

tools.append(\"playwright\")

return tools

But production FORGE should go beyond basic if statements.

I would create a scoring engine:

ToolScore =

capability_match × 0.30

\+ interface_match × 0.20

\+ brand_match × 0.15

\+ historical_success × 0.10

\+ user_preference × 0.10

\+ project_stack_match × 0.05

\+ accessibility_quality × 0.05

\+ performance_quality × 0.05

FORGE then explains its decision:

DESIGN ROUTER DECISION

PRIMARY TOOL:

IMPECCABLE

CONFIDENCE:

94%

REASONS:

\+ Application is dashboard-heavy.

\+ High information density.

\+ Requires reusable product components.

\+ Requires responsive behavior.

\+ Requires accessibility auditing.

\+ Previous FORGE projects showed strong results.

SUPPORT:

AWESOME-DESIGN

SPECIALIZED:

IMG2THREEJS

NOT SELECTED:

TASTE-SKILL

REASON:

Primary skill explicitly optimized for marketing/landing experiences

rather than dense dashboard interfaces.

That explainability is important. You should never wonder why FORGE
selected a certain design system.

I would therefore make the complete subsystem:

FORGE DESIGN INTELLIGENCE ENGINE

01 App Profiler

02 Interface Classifier

03 Brand Intelligence Engine

04 User/Persona Profiler

05 Design Capability Registry

06 Design Tool Router

07 Aesthetic Reference Engine

08 Design Strategy Generator

09 Design Variance Controller

10 Design Tournament Engine

11 Component Generator

12 img2threejs Geometry Engine

13 Browser Render Engine

14 Playwright Screenshot Engine

15 Responsive Screenshot Engine

16 Impeccable Audit Engine

17 Accessibility Audit

18 Visual Regression Engine

19 Design Scoring Engine

20 Human Visual Approval Gate

21 Composite Design Builder

22 Design Memory

23 Approval History

24 Design-System Extractor

25 Component/Token Consolidator

26 Deployment Design Gate

And I would give the document describing it a formal name:

**FORGE Enterprise Design Intelligence, Visual Validation & Human
Approval Architecture**

with filename:

FORGE-ENTERPRISE-DESIGN-INTELLIGENCE-VISUAL-APPROVAL-ARCHITECTURE.md

One additional consideration: the repositories you listed are evolving
quickly. For example, the current taste-skill repository notes that its
default skill is now a v2 experimental version while preserving v1, and
Impeccable currently has active issue reports around some
installation/static-analysis behavior. FORGE should therefore pin
known-good versions instead of automatically pulling main on every run.

That suggests another FORGE rule:

EXTERNAL DESIGN SKILL

\|

v

SECURITY SCAN

\|

v

COMPATIBILITY TEST

\|

v

PIN VERSION

\|

v

REGISTER CAPABILITIES

\|

v

ALLOW DESIGN ROUTER ACCESS

So a random repository update cannot silently alter the design behavior
of my autonomous factory.
