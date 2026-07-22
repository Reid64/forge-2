---
id: ui-components
name: UI Component Engineering Standards
domain: ui
tags: [react, tailwind, shadcn, typescript]
applicablePromptTypes: [component, page, feature]
---

COMPONENT LIBRARY: Use shadcn/ui as the primary component library. Install components via npx shadcn-ui@latest add [component]. Never hand-roll primitive UI elements (buttons, inputs, modals, dropdowns, tables) that shadcn provides.

SHADCN COMPONENTS AVAILABLE: Button, Input, Label, Select, Dialog, Sheet, Dropdown Menu, Table, Card, Badge, Alert, Toast, Tabs, Accordion, Avatar, Checkbox, Radio Group, Switch, Textarea, Form (with react-hook-form), Calendar, Date Picker, Command, Combobox, Data Table (with TanStack Table).

TAILWIND PATTERNS: Use cn() utility from @/lib/utils for conditional classes. Never use inline styles. Never use arbitrary values when Tailwind scale values exist. Mobile-first responsive: sm: md: lg: xl: prefixes.

ACCESSIBILITY: Every interactive element has aria-label or aria-labelledby. Every form field has associated label. Color contrast minimum 4.5:1. Focus visible on all interactive elements. Never remove outline without replacing with visible focus indicator.

LOADING STATES: Every async operation shows skeleton loader not spinner unless operation < 300ms. Use shadcn Skeleton component.

EMPTY STATES: Every list/table has an empty state with icon, heading, description, and CTA.

ERROR STATES: Every data fetch has error state with retry button.

DARK MODE: All components support dark mode via Tailwind dark: prefix. Never hardcode colors.
