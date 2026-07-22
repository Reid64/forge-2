---
id: bundle-optimization
name: Bundle Size Optimization Standards
domain: performance
tags: [nextjs, react]
applicablePromptTypes: [page, component]
---

DYNAMIC IMPORTS: Use `next/dynamic` (or `React.lazy`) for heavy components not needed on initial render — modals, charts, rich text editors, anything below the fold or behind an interaction.

TREE-SHAKING: Use named imports from libraries that support them (`import { debounce } from 'lodash-es'`), never a default/namespace import of an entire library (`import _ from 'lodash'`) when only one function is used.

THIRD-PARTY SCRIPTS: Load third-party scripts (analytics, chat widgets, ads) via `next/script` with `strategy="lazyOnload"` unless the script is required for the initial render. Never a raw `<script>` tag in the document head.

IMAGES: Always use `next/image`, never a raw `<img>` tag. `next/image` provides automatic resizing, format negotiation (WebP/AVIF), and lazy loading below the fold.

FONTS: Always use `next/font`, never a CDN `<link>` tag — CDN font loading adds a render-blocking network request `next/font` avoids by self-hosting.

CODE SPLITTING: Rely on Next.js's automatic route-level code splitting (each `page.tsx`/route segment is its own chunk) rather than manually bundling routes together; do not artificially merge routes into one entry point.
