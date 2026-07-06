# Skill: UI/UX Pro Max (pointer)

## When to apply
Whenever this prompt includes a generated `## DESIGN SYSTEM — AUTHORITATIVE` block.

## Procedure
1. Treat the DESIGN SYSTEM block in this prompt as authoritative for this project — it was
   generated specifically for this product by the UI/UX Pro Max design-intelligence engine
   (palette, type pairing, spacing scale, shadow depths, component specs).
2. Honor its anti-patterns list explicitly — those are named failure modes for THIS product's
   style, not generic advice; do not reintroduce something it warns against.
3. Treat its component specs as contracts: match the stated variants, states, and sizing rather
   than inventing your own component shape.
4. If no DESIGN SYSTEM block is present in this prompt, fall back to `skills/frontend-design`
   for the underlying design mandates.

The full UI/UX Pro Max corpus (67 styles, 96 palettes, 57 font pairings, 99 UX guidelines, 25
chart types) lives in `.claude/skills/ui-ux-pro-max/` and is queried by
`src/tools/design-system-generator.ts` during Phase 1B — this file exists only so
queue-declared skill injection (`skills: [..., ui-ux-pro-max]`) resolves in Phase 3.
