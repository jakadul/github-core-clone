// language: TypeScript, file: smoke.ts, runtime: Node 22 (type-stripping), platform: Linux
// Smoke-test client for the github-core-clone forge. Run against a live server:
//   BASE_URL=http://127.0.0.1:8080 SMOKE_REPO=smoke-repo node smoke.ts
// Walks REST v3 -> branches -> issue -> commits -> contents -> GraphQL -> MCP
// in order and prints PASS/FAIL per step. Exits 1 if any step fails.
// Standard library only: node:http, node:process. No third-party imports.

import http from "node:http";
import { URL } from "node:url";

const BASE = process.env.BASE_URL || "http://127.0.0.1:8080";
const OWNER = process.env.SMOKE_OWNER || "jakadul";
const REPO = process.env.SMOKE_REPO || "smoke-repo";

type Step = { name: string; ok: boolean; detail: string };

const steps: Step[] = [];

function request(method: string, path: string, body?: unknown): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), "utf8");
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname + url.search,
        method,
        headers: {
          "content-type": "application/json",
          ...(payload ? { "content-length": String(payload.length) } : {}),
        },
        timeout: 8000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode || 0, text: Buffer.concat(chunks).toString("utf8") })
        );
      }
    );
    req.on("timeout", () => {
      req.destroy(new Error("timeout"));
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function record(name: string, ok: boolean, detail: string): void {
  steps.push({ name, ok, detail });
  const tag = ok ? "PASS" : "FAIL";
  console.log(`${tag} ${name.padEnd(20)} ${detail}`);
}

function expect(cond: boolean, status: number, excerpt: string): boolean {
  return cond || excerpt.length === 0 ? cond : false;
}

async function stepCreateRepo(): Promise<void> {
  const r = await request("POST", "/api/v3/user/repos", { name: REPO, description: "smoke" });
  const ok = r.status === 200 || r.status === 201;
  record("create-repo", ok, `POST /api/v3/user/repos -> ${r.status}`);
}

async function stepGetRepo(): Promise<void> {
  const r = await request("GET", `/api/v3/repos/${OWNER}/${REPO}`);
  const ok = r.status === 200 && r.text.includes(`"full_name":"${OWNER}/${REPO}"`);
  record("get-repo", ok, `GET /api/v3/repos/${OWNER}/${REPO} -> ${r.status}`);
}

async function stepBranches(): Promise<void> {
  const r = await request("GET", `/api/v3/repos/${OWNER}/${REPO}/branches`);
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(r.text);
  } catch {
    parsed = null;
  }
  // A fresh repo has no commits yet, so zero branches is a valid answer —
  // the endpoint must exist and return an array, not a 404/500.
  const ok = r.status === 200 && Array.isArray(parsed);
  record("list-branches", ok, `GET branches -> ${r.status} (${Array.isArray(parsed) ? parsed.length : "?"} branches)`);
}

async function stepCreateIssue(): Promise<void> {
  const r = await request("POST", `/api/v3/repos/${OWNER}/${REPO}/issues`, {
    title: "smoke issue",
    body: "created by smoke.ts",
  });
  const ok = r.status === 200 || r.status === 201;
  record("create-issue", ok, `POST issues -> ${r.status}`);
}

async function stepListCommits(): Promise<void> {
  const r = await request("GET", `/api/v3/repos/${OWNER}/${REPO}/commits`);
  const ok = r.status === 200;
  record("list-commits", ok, `GET commits -> ${r.status}`);
}

async function stepReadFile(): Promise<void> {
  const r = await request("GET", `/api/v3/repos/${OWNER}/${REPO}/contents/.gitignore`);
  // .gitignore may not exist in a fresh repo: 404 is acceptable, 5xx is not
  const ok = r.status === 200 || r.status === 404;
  record("read-file", ok, `GET contents/.gitignore -> ${r.status}`);
}

async function stepGraphQL(): Promise<void> {
  const r = await request("POST", "/graphql", {
    query: `query($o: String!, $n: String!) { repository(owner: $o, name: $n) { name } }`,
    variables: { o: OWNER, n: REPO },
  });
  const ok = r.status === 200 && r.text.includes(REPO);
  record("graphql", ok, `POST /graphql -> ${r.status} (${ok ? "name resolved" : r.text.slice(0, 40)})`);
}

async function stepMcp(): Promise<void> {
  const r = await request("POST", "/mcp", {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "smoke.ts", version: "1.0.0" },
    },
  });
  const ok = r.status === 200 && r.text.includes("github-core-clone");
  record("mcp-initialize", ok, `POST /mcp initialize -> ${r.status}`);
}

async function stepMcpTools(): Promise<void> {
  const r = await request("POST", "/mcp", { jsonrpc: "2.0", id: 2, method: "tools/list" });
  let names = "";
  try {
    const parsed = JSON.parse(r.text) as { result?: { tools?: { name: string }[] } };
    names = (parsed.result?.tools ?? []).map((t) => t.name).join(",");
  } catch {
    names = "";
  }
  const ok = r.status === 200 && names.includes("create_issue");
  record("mcp-tools-list", ok, `POST /mcp tools/list -> ${r.status} [${names}]`);
}

async function main(): Promise<void> {
  console.log(`smoke.ts against ${BASE} (owner=${OWNER} repo=${REPO})`);
  const runners: (() => Promise<void>)[] = [
    stepCreateRepo,
    stepGetRepo,
    stepBranches,
    stepCreateIssue,
    stepListCommits,
    stepReadFile,
    stepGraphQL,
    stepMcp,
    stepMcpTools,
  ];
  for (const run of runners) {
    try {
      await run();
    } catch (err) {
      record(run.name, false, `transport error: ${(err as Error).message}`);
    }
  }
  const failed = steps.filter((s) => !s.ok);
  if (failed.length === 0) {
    console.log(`ALL PASS (${steps.length}/${steps.length})`);
    process.exit(0);
  }
  console.log(`${failed.length}/${steps.length} FAILED: ${failed.map((f) => f.name).join(", ")}`);
  process.exit(1);
}

main().catch((err) => {
  console.error("smoke.ts crashed:", err);
  process.exit(2);
});