---
id: core-web-vitals
name: Core Web Vitals Performance Standards
domain: performance
tags: [nextjs, performance]
applicablePromptTypes: [page, component, feature]
---

LCP (Largest Contentful Paint): Target under 2.5s. Use next/image for the largest above-fold element and mark it priority. Never lazy-load above-fold hero images or headline text.

FID (First Input Delay): Target under 100ms. Defer non-critical JavaScript. Split heavy client-side logic into dynamic imports that load after first paint. Never block the main thread with synchronous work during initial render.

CLS (Cumulative Layout Shift): Target under 0.1. Always set explicit width/height (or aspect-ratio) on images, embeds, and ad slots. Reserve space for content that loads asynchronously (fonts, images, dynamically injected UI) before it arrives.

TTFB (Time to First Byte): Target under 600ms. Use SSR or SSG for the initial route render. Never use client-side rendering (CSR) alone for the first paint of a page that needs to be fast or indexable.

FONTS: Use next/font, never a CDN <link> tag. next/font self-hosts and inlines font metrics to prevent layout shift from font swapping.

NETWORK: Add <link rel="preconnect"> for critical third-party origins (fonts, analytics, image CDNs) that the page depends on for its critical rendering path.
