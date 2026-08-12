import assert from "node:assert/strict";
import test from "node:test";
import { MetricsRegistry, routeLabel, structuredRequestLog, validateProductionSecurityEnvironment } from "./observability.js";
import { createApiServer, createAppState } from "./app.js";
import type { AddressInfo } from "node:net";

test("route metrics bound identifiers and never retain query or user content", () => {
  assert.equal(routeLabel("/v1/projects/123e4567-e89b-42d3-a456-426614174000/artifacts/artifact-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/content?email=private@example.test"),
    "/v1/projects/:id/artifacts/:artifactId/content");
  assert.equal(routeLabel("/private-project-title/secret-value"), "/:segment/:segment");
  const metrics = new MetricsRegistry();
  metrics.observeRequest("GET", "/health", 200, 0.125, "none");
  const text = metrics.render();
  assert.match(text, /courseforge_http_requests_total\{method="GET",route="\/health",status="200"\} 1/u);
  assert.doesNotMatch(text, /private@example|prompt|secret/iu);
});

test("structured logs contain only the approved request envelope", () => {
  const parsed = JSON.parse(structuredRequestLog({ requestId: "123e4567-e89b-42d3-a456-426614174000", method: "POST", route: "/v1/projects/:id", statusCode: 409, durationMs: 12, failure: "conflict" }));
  assert.deepEqual(Object.keys(parsed).sort(), ["durationMs", "event", "failure", "level", "method", "requestId", "route", "statusCode", "timestamp"].sort());
  assert.equal(parsed.level, "warn");
  assert.match(parsed.timestamp, /Z$/u);
});

test("HTTPS and explicit production profiles fail closed without secure cookies", () => {
  assert.throws(() => validateProductionSecurityEnvironment({ COURSEFORGE_SITE_ADDRESS: "https://training.example", SECURE_COOKIES: "false" }), /SECURE_COOKIES/u);
  assert.throws(() => validateProductionSecurityEnvironment({ COURSEFORGE_DEPLOYMENT_PROFILE: "production", SECURE_COOKIES: "false" }), /SECURE_COOKIES/u);
  assert.doesNotThrow(() => validateProductionSecurityEnvironment({ COURSEFORGE_SITE_ADDRESS: ":8080", COURSEFORGE_DEPLOYMENT_PROFILE: "test", SECURE_COOKIES: "false" }));
  assert.doesNotThrow(() => validateProductionSecurityEnvironment({ COURSEFORGE_SITE_ADDRESS: "https://training.example", SECURE_COOKIES: "true" }));
});

test("metrics are readable from loopback without application identity and contain no request query", async (t) => {
  const logs: string[] = []; const server = createApiServer(createAppState(), { requestLogger: (line) => logs.push(line) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve())); t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await fetch(`${base}/health?email=private@example.test`);
  const response = await fetch(`${base}/metrics`); assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /version=0\.0\.4/u);
  const payload = await response.text(); assert.match(payload, /courseforge_http_requests_total/u);
  assert.doesNotMatch(payload, /private@example|email=|project title|prompt|secret/iu);
  assert.ok(logs.every((line) => !line.includes("private@example.test")));
});
