# github-core-clone

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/jakadul/github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/jakadul/github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in one TypeScript file: git smart HTTP
(loose objects, packfile v2 read/write, ref-delta and ofs-delta resolution),
REST v3 subset, GraphQL, and MCP — all served from one bare-repo store on disk.
No build step, no npm installs, standard library only.

## Run it

```sh
node main.ts
```

Optional environment: `PORT` (default 8080), `DATA_DIR` (default ./data).

Endpoints:

- git smart HTTP: `/info/refs?service=git-upload-pack`, `/git-upload-pack`,
  `/git-receive-pack` (clone, fetch, push work out of the box)
- REST v3: `/api/v3/repos/jakadul/{repo}`, contents, issues, pulls, commits,
  `/users/{login}`, `/user` (also mounted at `/` like GitHub does)
- GraphQL: `POST /graphql` with `{query, variables}`
- MCP: `POST /mcp` JSON-RPC 2.0 — `initialize`, `tools/list`, `tools/call`
  (`list_repositories`, `create_issue`, `read_file`)

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>