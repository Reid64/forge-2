# Skill: Frontend Design

## When to apply
Before writing or editing ANY page, component, or layout in ANY project. This applies whether
or not a generated DESIGN SYSTEM block is present in this prompt — if one is present, it is
authoritative over everything below; this skill governs how you USE it and fills the gaps it
doesn't cover.

## Procedure

1. **Ground the design in the subject matter.** Before writing a single line of markup, name
   out loud (in your reasoning, not the UI): who is the audience, and what is this specific
   page's ONE job? A dashboard for field technicians and a landing page for enterprise buyers
   should not look like the same template with different copy.

2. **Token discipline — no exceptions.** Use ONLY the palette, type scale, spacing scale, radii,
   and shadow depths from the injected DESIGN SYSTEM block. Never invent a hex value, a font
   family, or a spacing number that isn't in that block. If a value you need genuinely isn't
   covered, derive it from the existing scale (e.g. interpolate between two defined spacing
   steps) rather than picking an arbitrary new one.

3. **Typography carries personality.** Pair a distinct display face for headings against a
   distinct, legible body face — never the same weight of the same font for both. Use an
   intentional type scale (not ad-hoc `text-lg`/`text-xl` guessing) and commit to specific
   weights per role (e.g. headings at 600/700, body at 400, emphasis at 500).

4. **Structure encodes information, not decoration.** Layout should reflect the actual
   relationships in the content — grouping, hierarchy, sequence. Question every numbered list
   or numbered-badge pattern (`① ② ③`) unless the content is GENUINELY sequential (a checkout
   flow, a step-by-step wizard); numbering a feature list just to look "designed" is decoration
   pretending to be information.

5. **Avoid the three generic AI looks**, unless the design system itself explicitly specifies
   one of them:
   - cream/off-white background + serif display type + terracotta/rust accent
   - near-black background + neon/acid-green accent
   - broadsheet-style hairline dividers everywhere with heavy small-caps labels
   These have become tells of unconsidered AI output. If the design system's palette happens to
   resemble one of these, that's fine — it was a deliberate choice, not a default.

6. **One signature element per page.** Pick a single moment of craft — a distinctive hero
   treatment, one animated transition, one unusual layout device — and let everything else be
   quiet and restrained around it. A page where every element is trying to be the signature
   element reads as noisy, not polished.

7. **Quality floor — met without announcing it.** Every page you ship must, without being asked
   again: work correctly at mobile widths; show a visible focus ring on every interactive
   element reachable by keyboard; respect `prefers-reduced-motion` (no forced animation on
   users who've disabled it); meet WCAG AA contrast (4.5:1 body text, 3:1 large text/UI
   components) using the design system's own palette — if a token combination fails contrast,
   pick a different pairing from the same system rather than shipping it anyway.

8. **Copy is design material, not an afterthought.** Write in active voice and sentence case.
   Buttons say exactly what they do ("Create project", not "Submit" or "OK"). Error messages
   explain what went wrong AND what to do about it ("Email already in use — try signing in
   instead", not "Error: invalid input").

9. **Motion is deliberate and sparse.** Prefer one well-orchestrated moment (a coordinated
   entrance, a meaningful state transition) over scattering small hover/fade effects across
   every element. If you can't articulate why a specific element animates, it shouldn't.

## Output requirement
When you finish a UI prompt, be able to state in one sentence which design-system tokens you
used for color/type/spacing, and which single element is this page's signature moment.
