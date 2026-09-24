---
name: security-invariants
description: Use when running /security-review or auditing security. Documents the BUSINESS security invariants that the static scanner (semgrep) and the built-in review can't infer from code alone — server-side authorization, object access (IDOR), secrets and env exposed to the client, trust boundaries, PII in logs. The skeleton is universal; your stack's rules go in the user-section.
metadata:
  type: reference
  maxWords: 1200
---

<!-- navori:managed id="security-invariants-base" hash="8a08c119" version="0.10.0" source="@navori/core" fmkeys="name,description,metadata" -->
# Security invariants — the business security layer

Feeds the `/security-review` flow and is the single owner of the security checklist for `reviewer` and `auditor`. `semgrep` is an OPT-IN plugin, not a given, so the business invariants below (authorization, IDOR, trust) sit next to a compact fallback list (§7) for the generic patterns a scanner would otherwise catch.

Report with severity `[CRITICAL]`/`[HIGH]`/`[MEDIUM]` and `file:line`, as in `review-diff`. An authorization bypass or an exposed secret is CRITICAL.

## 1. Authorization — enforced on the server

- Every route / endpoint / action that exposes protected data or effects MUST verify the role or permission **on the server**, before the query or the effect. A missing server-side guard = **authorization bypass, CRITICAL**.
- Client guards (conditional render, in-component checks, a `useAuth()`) **are never enough on their own** — they are UX, not enforcement. A protected view that only trusts the client is CRITICAL.
- Navigation / UI config (menus, an `allowedRoles` in the nav array) filters the UI, it does **not** control access. Adding an entry there without the corresponding server-side guard is a finding.
- The guard must **fail closed**: no session or backend down → deny / redirect, never "let it through just in case". Don't add a path that cuts on error toward the permissive side.
- **A guard is worth exactly what its least-covered entry point is worth.** The unit protected is the *resource*, not the handler you happened to open: introducing or changing a guard means enumerating every way that resource is mutated — sibling routes, bulk or admin variants, background jobs, queue consumers, maintenance scripts — and accounting for each one, covered or excluded with the reason written down. An unlisted entry point is not "pending", it's unprotected. A sibling endpoint reachable by the same actor and missing the guard is the very bug the guard was added to fix, still alive and now harder to see, because the diff reads as if the hole were closed. Enumerate with evidence — via Code discovery routing's structural provider, or `locate-code` as fallback — and mark each one covered, or justify each exclusion one by one. An occurrence count alone doesn't demonstrate the enumeration is complete.

## 2. Object access (IDOR)

- An id coming from input (URL, body, query) does NOT authorize by existing. **Ownership / scope is verified server-side** (ideally in the backend or the access layer), not on the client.
- A view that fetches a record by URL-id must trust the backend's access error (`ACCESS_DENIED` / 403), not invent its own ownership check nor assume the id is valid.
- Lists of sensitive entities are never queried from the client with broad filters — they go through the server with the authenticated session.

## 3. Auth error handling

- A **401** means authentication is missing or invalid: handle it globally and fail closed (session reset / redirect). A **403** means an authenticated principal lacks permission: preserve the valid session, deny the action, and show/route the access outcome without retrying as another identity. Do not collapse them into logout behavior.
- Define the backend's error-code contract (for example 401 session, 403 authorization, 423 lock, 429 rate-limit) and respect it. Custom handling of those codes in a one-off component is a finding.

## 4. Secrets and environment variables

- Zero hardcoded secrets / tokens / internal URLs — **including tests and `.env.example` files** (use placeholders). A secret in code is CRITICAL.
- Vars that are **bundled into the client** (prefixes like `NEXT_PUBLIC_`, `VITE_`, `PUBLIC_`) MUST be safe to leak: no API keys, tokens or internal URLs behind that prefix. Putting a sensitive value there is CRITICAL.
- A data-mutating script that falls back to a default host or credentials when its env var is missing is CRITICAL — it runs clean against the wrong target; it must refuse to start.

## 5. Trust boundaries / data flow

- All data from an external source (backend, network, input) is **validated and normalized at the boundary** before entering the domain. Don't pass raw backend values straight to the UI.
- Fallbacks for unknown enums / states → to a known safe value, never raw passthrough nor throw (an untrusted raw enum in the UI = state confusion or potential XSS).
- Respect the architectural boundaries the repo declares (which layer may import generated types or talk to which backend).

## 6. Logging and PII

- No `console.log` / print of user data, tokens, session cookies or PII (email, phone, documents) on production paths. Debug logs only behind an environment guard (e.g. `NODE_ENV === 'development'`).

## 7. If no scanner is installed

When the repo has no static analyzer (e.g. `semgrep`) wired in, additionally scan the diff by hand for the patterns a scanner would otherwise catch:

1. Hardcoded credentials / API keys / tokens in source.
2. SQL injection — string-concatenated queries with unsanitized input.
3. XSS — unescaped user input rendered into HTML/DOM.
4. Path traversal — unsanitized paths reaching the filesystem.
5. CSRF — state-changing endpoints with no token/origin check.
6. Auth bypass — a route reachable without the expected guard.
7. Vulnerable dependencies — known CVEs in the manifest/lockfile.
8. Secrets in logs — tokens, passwords or PII printed to a log sink.

Plus, always (scanner or not, since it's a business invariant, not a generic pattern): **session or tokens kept in client storage** (`localStorage`/`sessionStorage`/cookies) beyond what the flow needs — a session token there is CRITICAL, an opaque non-sensitive id is not.

This list is a manual substitute, not a replacement — where a scanner plugin is installed, its rung below supersedes items 1-8 for the diffs it actually runs against.

## How to use it in the review

1. Walk the diff or the area with these 6 categories as a checklist.
2. Report with severity and `file:line`.
3. Cross-check with the **rules specific to your stack** (below): the concrete names of your guards, error codes and env prefixes live there — without that, the review only covers the universal layer.
<!-- /navori:managed id="security-invariants-base" -->

## Your stack's security invariants

<!-- user: document here what the model CAN'T infer from code — the concrete rules of YOUR domain. Suggestions:
     - AUTHORIZATION: name and signature of the mandatory server-side guard (e.g. `requireRole([...])`), where it goes, its terminal paths, and which routes require it.
     - IDOR: how resources are identified (UUID / CUID / slug), the validation helper, and which entities are sensitive.
     - ERRORS: the exact code contract of your backend (401/403/423/429…) and the global handler.
     - ENV: the secrets manager (Infisical / Vault / …), your framework's client-var prefix, and what NEVER carries that prefix.
     - BOUNDARIES: which layer may import what (generated types, backend clients), adapter and sanitization rules.
     - Repo anti-patterns that are auto-CRITICAL.
-->
