---
id: repository-pattern
name: Repository Pattern Standards
domain: architecture
tags: [typescript, patterns]
applicablePromptTypes: [api, database]
---

INTERFACE BEFORE IMPLEMENTATION: Every repository is defined as a TypeScript interface first (`UserRepository`), with a concrete implementation (`SupabaseUserRepository`, `PrismaUserRepository`) satisfying it second. Calling code depends on the interface, never on the concrete class, so the underlying persistence technology can be swapped or mocked in tests without touching a single call site.

NEVER EXPOSE ORM TYPES OUTSIDE THE REPOSITORY: A repository's public methods accept and return domain types/DTOs defined by the application, never the ORM's or query builder's generated row types (no leaking a Prisma `User` model, a Supabase `Database['public']['Tables']['users']['Row']`, or a raw `QueryResult` past the repository boundary). Mapping between the persistence row shape and the domain type happens inside the repository implementation, not at every call site.

MINIMUM METHOD SET: Every repository implements at minimum `findById`, `findAll` (or a scoped/paginated equivalent), `create`, `update`, and `delete`. Additional query methods (`findByEmail`, `findActiveByCompany`) are added as named, intention-revealing methods on the interface — never as an ad-hoc raw query built outside the repository.

NO BUSINESS LOGIC IN THE REPOSITORY: A repository's only job is data access — building queries, mapping rows to domain types, and handling persistence-layer errors. Validation rules, authorization checks, workflow orchestration, and side effects (sending emails, publishing events) belong in a service/use-case layer that calls the repository, never inside the repository methods themselves. If a repository method needs an `if` statement to decide whether an action is allowed, that logic has leaked in from the wrong layer.
