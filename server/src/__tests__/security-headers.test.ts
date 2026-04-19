/**
 * @fileoverview Unit tests for `securityHeaders()` middleware.
 *
 * These tests close QA Checkpoint FINAL3 findings Issue #2 (missing
 * `X-Content-Type-Options`), Issue #3 (missing `X-Frame-Options`),
 * Issue #4 (missing `Cache-Control` on API), Issue #5 (missing CSP /
 * `Referrer-Policy`), and verify that the scoping logic
 * (`req.path.startsWith("/api/")`) does not affect non-API routes.
 *
 * The suite uses the `supertest` pattern established by
 * `activity-routes.test.ts`: build a minimal `express()` app that
 * registers only the middleware under test plus a handful of tiny
 * inline handlers, then assert on the raw HTTP response headers.
 *
 * These tests do not exercise the full `createApp` topology because
 * (a) `securityHeaders()` is self-contained — it has no dependencies
 * on the database, logger, or authentication middleware — and
 * (b) a smaller harness gives direct, unambiguous header evidence
 * for each QA finding.
 *
 * @see server/src/middleware/security-headers.ts
 * @see server/src/app.ts — where `securityHeaders()` is registered
 */
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { securityHeaders } from "../middleware/index.js";

function createTestApp() {
  const app = express();
  app.use(securityHeaders());

  app.get("/api/ping", (_req, res) => { res.json({ ok: true }); });
  app.get("/ui/ping", (_req, res) => { res.json({ ok: true }); });
  app.get("/", (_req, res) => {
    res.type("text/html").send("<html><body>hello</body></html>");
  });
  app.get("/api/attachment", (_req, res) => {
    res.setHeader("Cache-Control", "private, max-age=60");
    res.json({ ok: true });
  });
  app.get("/health", (_req, res) => { res.json({ status: "ok" }); });

  return app;
}

describe("securityHeaders middleware", () => {
  describe("app-wide headers (always emitted)", () => {
    it("sets X-Content-Type-Options: nosniff on API responses (Issue #2)", async () => {
      const app = createTestApp();
      const res = await request(app).get("/api/ping");
      expect(res.status).toBe(200);
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
    });
    it("sets X-Content-Type-Options: nosniff on non-API responses (Issue #2)", async () => {
      const app = createTestApp();
      const res = await request(app).get("/ui/ping");
      expect(res.status).toBe(200);
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
    });
    it("sets X-Content-Type-Options: nosniff on root (UI) responses (Issue #2)", async () => {
      const app = createTestApp();
      const res = await request(app).get("/");
      expect(res.status).toBe(200);
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
    });
    it("sets X-Frame-Options: DENY on API responses (Issue #3)", async () => {
      const app = createTestApp();
      const res = await request(app).get("/api/ping");
      expect(res.headers["x-frame-options"]).toBe("DENY");
    });
    it("sets X-Frame-Options: DENY on non-API responses (Issue #3)", async () => {
      const app = createTestApp();
      const res = await request(app).get("/ui/ping");
      expect(res.headers["x-frame-options"]).toBe("DENY");
    });
    it("sets X-Frame-Options: DENY on root responses (Issue #3)", async () => {
      const app = createTestApp();
      const res = await request(app).get("/");
      expect(res.headers["x-frame-options"]).toBe("DENY");
    });
    it("sets Referrer-Policy: no-referrer on API responses (Issue #5 part 1)", async () => {
      const app = createTestApp();
      const res = await request(app).get("/api/ping");
      expect(res.headers["referrer-policy"]).toBe("no-referrer");
    });
    it("sets Referrer-Policy: no-referrer on non-API responses (Issue #5 part 1)", async () => {
      const app = createTestApp();
      const res = await request(app).get("/ui/ping");
      expect(res.headers["referrer-policy"]).toBe("no-referrer");
    });
    it("sets Referrer-Policy: no-referrer on root responses (Issue #5 part 1)", async () => {
      const app = createTestApp();
      const res = await request(app).get("/");
      expect(res.headers["referrer-policy"]).toBe("no-referrer");
    });
  });

  describe("API-scoped headers (only on /api/* paths)", () => {
    it("sets Cache-Control: no-store on /api/* responses (Issue #4)", async () => {
      const app = createTestApp();
      const res = await request(app).get("/api/ping");
      expect(res.headers["cache-control"]).toBe("no-store");
    });
    it("sets Content-Security-Policy on /api/* responses (Issue #5 part 2)", async () => {
      const app = createTestApp();
      const res = await request(app).get("/api/ping");
      expect(res.headers["content-security-policy"]).toBe(
        "default-src 'none'; frame-ancestors 'none'",
      );
    });
    it("does NOT set Cache-Control: no-store on /ui/* responses (Issue #4 scoping)", async () => {
      const app = createTestApp();
      const res = await request(app).get("/ui/ping");
      expect(res.headers["cache-control"]).toBeUndefined();
    });
    it("does NOT set Content-Security-Policy on /ui/* responses (Issue #5 scoping)", async () => {
      const app = createTestApp();
      const res = await request(app).get("/ui/ping");
      expect(res.headers["content-security-policy"]).toBeUndefined();
    });
    it("does NOT set Cache-Control: no-store on root / responses (Issue #4 scoping)", async () => {
      const app = createTestApp();
      const res = await request(app).get("/");
      expect(res.headers["cache-control"]).toBeUndefined();
    });
    it("does NOT set Content-Security-Policy on root / responses (Issue #5 scoping)", async () => {
      const app = createTestApp();
      const res = await request(app).get("/");
      expect(res.headers["content-security-policy"]).toBeUndefined();
    });
    it("does NOT set Cache-Control: no-store on /health responses (top-level mount scoping)", async () => {
      const app = createTestApp();
      const res = await request(app).get("/health");
      expect(res.status).toBe(200);
      expect(res.headers["cache-control"]).toBeUndefined();
    });
    it("still sets app-wide headers on /health responses (cross-check)", async () => {
      const app = createTestApp();
      const res = await request(app).get("/health");
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["x-frame-options"]).toBe("DENY");
      expect(res.headers["referrer-policy"]).toBe("no-referrer");
    });
  });

  describe("route-handler override compatibility", () => {
    it("allows /api/* route handlers to override Cache-Control (attachment pattern)", async () => {
      const app = createTestApp();
      const res = await request(app).get("/api/attachment");
      expect(res.status).toBe(200);
      expect(res.headers["cache-control"]).toBe("private, max-age=60");
    });
    it("keeps app-wide headers intact when route overrides Cache-Control", async () => {
      const app = createTestApp();
      const res = await request(app).get("/api/attachment");
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["x-frame-options"]).toBe("DENY");
      expect(res.headers["referrer-policy"]).toBe("no-referrer");
    });
    it("keeps Content-Security-Policy intact when route overrides only Cache-Control", async () => {
      const app = createTestApp();
      const res = await request(app).get("/api/attachment");
      expect(res.headers["content-security-policy"]).toBe(
        "default-src 'none'; frame-ancestors 'none'",
      );
    });
  });

  describe("path prefix strictness (Issue #4 / #5 scoping boundary)", () => {
    it("treats /api (no trailing slash, non-existent route) as non-API", async () => {
      const app = express();
      app.use(securityHeaders());
      app.get("/apiNotReal", (_req, res) => { res.json({ ok: true }); });
      const res = await request(app).get("/apiNotReal");
      expect(res.status).toBe(200);
      expect(res.headers["cache-control"]).toBeUndefined();
      expect(res.headers["content-security-policy"]).toBeUndefined();
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["x-frame-options"]).toBe("DENY");
      expect(res.headers["referrer-policy"]).toBe("no-referrer");
    });
    it("treats nested /api/foo/bar paths as API (scoping reaches deep routes)", async () => {
      const app = express();
      app.use(securityHeaders());
      app.get("/api/foo/bar", (_req, res) => { res.json({ ok: true }); });
      const res = await request(app).get("/api/foo/bar");
      expect(res.status).toBe(200);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.headers["content-security-policy"]).toBe(
        "default-src 'none'; frame-ancestors 'none'",
      );
    });
  });

  describe("error response coverage (headers must still set on 404 via explicit fallback)", () => {
    // In production (server/src/app.ts), unmatched routes flow through an
    // explicit error handler which returns JSON rather than Express's default
    // HTML 404 page (Express's default 404 is emitted by the built-in
    // `finalhandler`, which OVERWRITES our CSP with its own `default-src
    // 'none'`). The production harness therefore never exposes finalhandler's
    // default to clients. To accurately model that, we register an explicit
    // JSON 404 fallback handler and assert our middleware's headers survive.
    it("emits app-wide + API headers on explicit 404 JSON fallback for /api/* unknown route", async () => {
      const app = express();
      app.use(securityHeaders());
      app.use((_req, res) => {
        res.status(404).json({ error: "not found" });
      });
      const res = await request(app).get("/api/does-not-exist");
      expect(res.status).toBe(404);
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["x-frame-options"]).toBe("DENY");
      expect(res.headers["referrer-policy"]).toBe("no-referrer");
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.headers["content-security-policy"]).toBe(
        "default-src 'none'; frame-ancestors 'none'",
      );
    });
    it("emits only app-wide headers on explicit 404 JSON fallback for non-API unknown route", async () => {
      const app = express();
      app.use(securityHeaders());
      app.use((_req, res) => {
        res.status(404).json({ error: "not found" });
      });
      const res = await request(app).get("/unknown");
      expect(res.status).toBe(404);
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["x-frame-options"]).toBe("DENY");
      expect(res.headers["referrer-policy"]).toBe("no-referrer");
      expect(res.headers["cache-control"]).toBeUndefined();
      expect(res.headers["content-security-policy"]).toBeUndefined();
    });
  });
});
