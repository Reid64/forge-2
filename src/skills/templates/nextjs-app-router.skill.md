---
id: nextjs-app-router
name: Next.js 14 App Router Patterns
domain: frontend
tags: [nextjs, react, typescript]
applicablePromptTypes: [feature, component, page, api]
---

ROUTE HANDLERS: Always use NextRequest/NextResponse. Auth via createServerComponentClient or createRouteHandlerClient from supabase-js. Never use getServerSideProps. Every route.ts exports named functions GET/POST/PUT/DELETE/PATCH only.

SERVER COMPONENTS: Default to server components. Use 'use client' only when needed for interactivity, browser APIs, or hooks. Never fetch in client components when server component can do it.

ERROR HANDLING: Every API route returns { data, error } shape. Error always includes { message: string, code: string, status: number }. Never return raw error objects.

LOADING STATES: Every page.tsx has a loading.tsx sibling. Every async server component wraps data fetch in try/catch.

METADATA: Every page.tsx exports generateMetadata function.

FILE NAMING: page.tsx for pages, layout.tsx for layouts, loading.tsx for suspense, error.tsx for error boundaries, route.ts for API handlers. Never mix.

IMPORTS: Use @/ alias for all src imports. Never use relative paths beyond one level.
