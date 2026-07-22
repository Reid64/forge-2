---
id: typescript-strict
name: TypeScript Strict Engineering Patterns
domain: typescript
tags: [typescript]
applicablePromptTypes: [feature, api, component, agent, database]
---

NO ANY: Never use any. Use unknown for truly unknown types and narrow with type guards. Use Record<string, unknown> for dynamic objects.

INTERFACES VS TYPES: Interfaces for objects that may be extended. Types for unions, intersections, primitives, tuples. Never mix.

ERROR TYPES: Define explicit error types. Never throw raw strings. Use class CustomError extends Error with name and code properties.

ASYNC PATTERNS: Always return Promise<Result<T, E>> shape for fallible operations where Result = { data: T, error: null } | { data: null, error: E }. Never throw from async functions that cross module boundaries.

ENUMS: Use const enums for compile-time constants. Use string enums for runtime-serializable values. Never use numeric enums.

GENERICS: Name generic parameters descriptively: TData, TError, TResponse not T, U, V.

STRICT NULL: Never use non-null assertion operator ! unless asserting after a runtime check. Use optional chaining ?. and nullish coalescing ?? everywhere.
