import type { RequestHandler } from "express";

/**
 * @fileoverview Application-wide security response headers middleware.
 *
 * This middleware is part of the remediation for GitHub Security Advisory
 * GHSA-gqqj-85qm-8qhf (CWE-284 — Improper Access Control). While the primary
 * advisory fix targets connector-inheritance isolation in the
 * `codex_local` adapter, QA Checkpoint FINAL3 identified four LOW-severity
 * and two INFO-severity defense-in-depth gaps on the JSON API surface that
 * this middleware closes without introducing any new npm dependencies
 * (per the AAP's "Don't introduce new dependencies" constraint).
 *
 * Header strategy:
 *
 * App-wide headers (emitted for every response):
 *   - `X-Content-Type-Options: nosniff`
 *       Prevents MIME-sniffing. Safe for API JSON, UI HTML, static assets,
 *       plugin UI bundles, and binary attachments alike. Addresses QA
 *       finding Issue #2.
 *   - `X-Frame-Options: DENY`
 *       Blocks all framing of Paperclip responses (clickjacking defense).
 *       The application has no legitimate first-party embedding use case.
 *       Addresses QA finding Issue #3.
 *   - `Referrer-Policy: no-referrer`
 *       Prevents leaking Paperclip URLs — which may contain entity ids
 *       like `/api/companies/<uuid>/agents/<uuid>` — via the `Referer`
 *       header when users click outbound links. Addresses QA finding
 *       Issue #5 (part 1).
 *
 * API-scoped headers (emitted ONLY when `req.path.startsWith("/api/")`):
 *   - `Cache-Control: no-store`
 *       JSON responses from the API surface typically contain
 *       user/company-scoped data and must not be cached by
 *       intermediaries or browsers. Addresses QA finding Issue #4.
 *       Scoping to `/api/*` preserves the long-lived (`max-age=1y,
 *       immutable`) cache policy that `app.ts` applies to `/assets/*`
 *       and the `no-cache` policy it applies to the UI shell, and
 *       leaves plugin UI (`/_plugins/:pluginId/ui/*`) untouched.
 *   - `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`
 *       JSON API responses are never intended to be parsed as HTML or
 *       executed as scripts, so the most restrictive CSP is appropriate.
 *       Scoping to `/api/*` avoids interfering with UI HTML serving
 *       (which has its own CSP needs via the Vite dev server and static
 *       shell) and with attachment downloads (which set their own
 *       `sandbox`-mode CSP in `issues.ts` / `assets.ts`).
 *       Addresses QA finding Issue #5 (part 2).
 *
 * Header-setting mechanics:
 *   Uses `res.setHeader()` (not `res.set()`) so that downstream route
 *   handlers are free to override any of these values via their own
 *   `res.setHeader()` / `res.set()` calls. Known override cases include:
 *     - `server/src/routes/issues.ts:2740` and
 *       `server/src/routes/assets.ts:325` set
 *       `Cache-Control: private, max-age=60` on authenticated attachment
 *       / asset downloads.
 *     - `server/src/routes/agents.ts:1137, 1149, 2509, 2544` set
 *       `Cache-Control: no-cache` (or `no-cache, no-store`) on SSE
 *       streaming endpoints.
 *     - `server/src/routes/plugins.ts:1153` and
 *       `server/src/routes/plugin-ui-static.ts:368` set their own
 *       content-hash-aware cache policies.
 *   All such overrides continue to work because the middleware executes
 *   before the route and uses `setHeader`, which the route replaces
 *   when it calls `setHeader` again.
 *
 * X-Powered-By:
 *   This middleware does NOT set or clear `X-Powered-By`. That header is
 *   suppressed once per Express app via `app.disable("x-powered-by")` in
 *   `server/src/app.ts`, which addresses QA finding Issue #6. Disabling
 *   it at the app level is the idiomatic approach and avoids a per-request
 *   `removeHeader` call in the middleware hot path.
 *
 * Scope of QA findings addressed:
 *   - Issue #2 (LOW)   — Missing `X-Content-Type-Options`      (here)
 *   - Issue #3 (LOW)   — Missing `X-Frame-Options`             (here)
 *   - Issue #4 (LOW)   — Missing `Cache-Control` on API        (here)
 *   - Issue #5 (LOW)   — Missing CSP / `Referrer-Policy`       (here)
 *   - Issue #6 (INFO)  — `X-Powered-By: Express` disclosed     (app.ts)
 *
 * Scope boundary (per AAP):
 *   This middleware must NOT introduce a dependency on `helmet` or any
 *   other npm package. The header set is deliberately small and
 *   hand-rolled to satisfy only the exact QA findings above.
 *
 * @see server/src/app.ts       — where `app.disable("x-powered-by")` is set and this middleware is registered
 * @see server/src/middleware/board-mutation-guard.ts — reference pattern for factory + RequestHandler idiom
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Path prefix identifying JSON API responses. Cache-Control: no-store and
 * the restrictive CSP are applied only to responses whose request path
 * begins with this prefix, so that static asset serving, UI shell HTML,
 * and plugin UI bundles are not affected.
 *
 * Kept in sync with the API router mount in `server/src/app.ts`:
 *   `app.use("/api", api);`
 */
const API_PATH_PREFIX = "/api/";

/**
 * Value for `Content-Security-Policy` on API responses. The API never
 * returns HTML or scripts, so `default-src 'none'` is the safest possible
 * value. `frame-ancestors 'none'` is the CSP-level equivalent of
 * `X-Frame-Options: DENY` and ensures coverage on any user agent that
 * prefers CSP's directive over the legacy header.
 */
const API_CONTENT_SECURITY_POLICY =
  "default-src 'none'; frame-ancestors 'none'";

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Returns an Express `RequestHandler` that sets defense-in-depth security
 * response headers.
 *
 * The returned handler is intended to be registered once, early in the
 * middleware chain (after `httpLogger`, before request authorization and
 * route-specific middleware), so that the headers are set on every
 * response — including error responses emitted by `errorHandler`.
 *
 * The handler sets all headers synchronously and calls `next()` with no
 * arguments; it never throws and never short-circuits the request.
 *
 * @returns A configured Express request handler.
 */
export function securityHeaders(): RequestHandler {
  return (req, res, next) => {
    // Always-on headers. Safe for every response type (JSON, HTML,
    // static assets, binary attachments, SSE, plugin UI bundles).
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");

    // API-scoped headers. These are inappropriate for UI HTML (would
    // break script execution) and for static asset caching (would
    // disable the 1y immutable cache on `/assets/*`), so they are
    // emitted only for requests under `/api/`.
    if (req.path.startsWith(API_PATH_PREFIX)) {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Security-Policy", API_CONTENT_SECURITY_POLICY);
    }

    next();
  };
}
