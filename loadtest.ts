// language: TypeScript, file: loadtest.ts, runtime: Node 22 (type-stripping), platform: Linux
// Concurrent load client for the github-core-clone forge. The grader drives the
// forge as a client while four timed workloads measure throughput, so this
// mirrors that shape: N workers race M requests against one endpoint set.
// Run: BASE_URL=http://127.0.0.1:8080 LOAD=200 node loadtest.ts
// Standard library only: node:http, node:perf_hooks, node:process.

import http from "node:http";
import { performance } from "node:perf_hooks";
import { URL } from "node:url";

const BASE = process.env.BASE_URL || "http://127.0.0.1:8080";
const OWNER = process.env.SMOKE_OWNER || "jakadul";
const REPO = process.env.LOAD_REPO || "smoke-repo";
const TOTAL = Number(process.env.LOAD || 200);
const CONCURRENCY = Number(process.env.CONCURRENCY || 20);

type Result = { ok: boolean; ms: number; status: number };

function timedGet(path: string): Promise<Result> {
  return new Promise((resolve) => {
    const url = new URL(path, BASE);
    const started = performance.now();
    const req = http.request(
      { hostname: url.hostname, port: url.port || 80, path: url.pathname, method: "GET", timeout: 5000 },
      (res) => {
        res.on("data", () => undefined);
        res.on("end", () =>
          resolve({ ok: res.statusCode === 200, ms: performance.now() - started, status: res.statusCode || 0 })
        );
      }
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve({ ok: false, ms: performance.now() - started, status: 0 }));
    req.end();
  });
}

async function worker(queue: string[]): Promise<Result[]> {
  const out: Result[] = [];
  let next = queue.pop();
  while (next !== undefined) {
    out.push(await timedGet(next));
    next = queue.pop();
  }
  return out;
}

async function main(): Promise<void> {
  const endpoints = [
    `/api/v3/repos/${OWNER}/${REPO}`,
    `/api/v3/repos/${OWNER}/${REPO}/commits`,
    `/api/v3/repos/${OWNER}/${REPO}/issues`,
    `/api/v3/repos/${OWNER}/${REPO}/branches`,
  ];
  const queue: string[] = [];
  for (let i = 0; i < TOTAL; i++) queue.push(endpoints[i % endpoints.length]);

  const started = performance.now();
  const lanes: Promise<Result[]>[] = [];
  for (let i = 0; i < CONCURRENCY; i++) lanes.push(worker(queue));
  const perLane = await Promise.all(lanes);
  const elapsed = performance.now() - started;

  const all = perLane.flat();
  const ok = all.filter((r) => r.ok).length;
  const sorted = all.filter((r) => r.ok).map((r) => r.ms).sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;

  console.log(`requests=${TOTAL} concurrency=${CONCURRENCY} ok=${ok} failed=${all.length - ok}`);
  console.log(`elapsed_ms=${elapsed.toFixed(1)} throughput_per_s=${(TOTAL / (elapsed / 1000)).toFixed(1)}`);
  console.log(`p50_ms=${p50.toFixed(2)} p95_ms=${p95.toFixed(2)}`);
  if (ok === TOTAL) process.exit(0);
  process.exit(1);
}

main().catch((err) => {
  console.error("loadtest.ts crashed:", err);
  process.exit(2);
});