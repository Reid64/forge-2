---
id: mobile-first
name: Mobile-First UI Patterns
domain: ui
tags: [react, mobile, responsive]
applicablePromptTypes: [component, page, feature]
---

TOUCH TARGETS: Every interactive element (button, link, checkbox, icon button) is at least 44x44px of tappable area, even when the visible glyph is smaller — pad with an invisible hit area rather than shrinking the target.

BOTTOM NAVIGATION: Primary navigation/actions for a mobile layout live in a bottom navigation bar or bottom-anchored action bar, within easy thumb reach — never only in a top-of-screen hamburger menu for actions used every session.

NO HOVER-DEPENDENT INTERACTIONS: Nothing essential is gated behind :hover — touch has no hover state. Tooltips, reveal-on-hover menus, and hover-only affordances must have a tap-triggered equivalent.

MINIMUM FONT SIZE: Body text is never smaller than 16px. Smaller sizes both hurt legibility and trigger automatic zoom-on-focus in mobile Safari for form inputs.

MOBILE KEYBOARDS: Inputs use the correct type/inputmode for their content — type="tel" for phone numbers, type="email" for email, type="number" or inputmode="numeric" for numeric entry — so the OS surfaces the matching keyboard layout instead of the full QWERTY default.

SKELETON LOADERS: Loading states use skeleton placeholders shaped like the content that will appear, not a generic spinner — skeletons communicate layout and perceived progress; spinners communicate only "wait."
