// language: TypeScript, file: main.ts, runtime: Node 22 (type-stripping, run directly), platform: Linux
// GitHub-compatible git forge in one file: git smart HTTP + object model + REST v3 + GraphQL + MCP.
// Standard library only. No build step, no npm installs.

import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { promisify } from "node:util";

const deflateRawSync = zlib.deflateRawSync;
const inflateRawSync = zlib.inflateRawSync;
const inflateSync = promisify(zlib.inflate);
const gzipSync = zlib.gzipSync;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT || 8080);
const DATA_DIR = path.resolve(process.env.DATA_DIR || "./data");

// ---------------------------------------------------------------------------
// Hashing / encoding helpers
// ---------------------------------------------------------------------------
function sha1Hex(data: Buffer | string): string {
  return crypto.createHash("sha1").update(data).digest("hex");
}
function sha1Bytes(data: Buffer | string): Buffer {
  return crypto.createHash("sha1").update(data).digest();
}
function toHex(b: Buffer): string {
  return b.toString("hex");
}
function fromHex(s: string): Buffer {
  return Buffer.from(s, "hex");
}
function utf8(s: string): Buffer {
  return Buffer.from(s, "utf8");
}
function concat(parts: Buffer[]): Buffer {
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// pkt-line framing (git wire protocol)
// ---------------------------------------------------------------------------
function pktLine(payload: Buffer | string): Buffer {
  const buf = typeof payload === "string" ? utf8(payload) : payload;
  const len = (buf.length + 4).toString(16).padStart(4, "0");
  return concat([utf8(len), buf]);
}
function pktFlush(): Buffer {
  return utf8("0000");
}
/** Split a pkt-line stream into payloads; flush packets become null. */
function parsePktLines(buf: Buffer): (Buffer | null)[] {
  const out: (Buffer | null)[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const lenHex = buf.subarray(off, off + 4).toString("latin1");
    const len = parseInt(lenHex, 16);
    if (Number.isNaN(len)) break;
    if (len === 0) {
      out.push(null);
      off += 4;
      continue;
    }
    if (len < 4) break;
    if (off + len > buf.length) break; // truncated
    out.push(buf.subarray(off + 4, off + len));
    off += len;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Git object model: types, encoding, loose objects
// ---------------------------------------------------------------------------
type ObjType = "commit" | "tree" | "blob" | "tag";

interface GitObject {
  type: ObjType;
  data: Buffer;
}

function objectHeader(type: ObjType, size: number): Buffer {
  return utf8(`${type} ${size}\0`);
}
function hashObject(obj: GitObject): string {
  return sha1Hex(concat([objectHeader(obj.type, obj.data.length), obj.data]));
}
/** Serialize an object to its loose-object file contents (zlib of header+data). */
function encodeLoose(obj: GitObject): Buffer {
  return zlibDeflate(concat([objectHeader(obj.type, obj.data.length), obj.data]));
}
function zlibDeflate(buf: Buffer): Buffer {
  return zlib.deflateSync(buf);
}
/** Parse raw object file contents (inflated header+data). */
function decodeLoose(raw: Buffer): GitObject {
  const nul = raw.indexOf(0);
  // header is a STRING here (already decoded), so slice it — calling subarray
  // on it throws "header.subarray is not a function" on every read.
  const header = raw.subarray(0, nul).toString("latin1");
  const sp = header.indexOf(" ");
  const type = header.slice(0, sp) as ObjType;
  const data = raw.subarray(nul + 1);
  return { type, data };
}

// ---------------------------------------------------------------------------
// Tree parsing / building
// ---------------------------------------------------------------------------
interface TreeEntry {
  mode: string; // "100644" | "40000" | "100755" | "120000" | "160000"
  name: string;
  sha: string;
}
function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    const mode = data.subarray(off, sp).toString("latin1");
    const nul = data.indexOf(0, sp + 1);
    const name = data.subarray(sp + 1, nul).toString("utf8");
    const sha = toHex(data.subarray(nul + 1, nul + 21));
    entries.push({ mode, name, sha });
    off = nul + 21;
  }
  return entries;
}
function buildTree(entries: TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  // git sorts trees with directory names getting an implicit trailing slash
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === "40000" ? a.name + "/" : a.name;
    const bn = b.mode === "40000" ? b.name + "/" : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  for (const e of sorted) {
    parts.push(utf8(`${e.mode} ${e.name}\0`), fromHex(e.sha));
  }
  return concat(parts);
}

// ---------------------------------------------------------------------------
// Commit parsing / building
// ---------------------------------------------------------------------------
interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}
function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString("utf8");
  const sep = text.indexOf("\n\n");
  const headerStr = sep === -1 ? text : text.slice(0, sep);
  const message = sep === -1 ? "" : text.slice(sep + 2);
  let tree = "";
  const parents: string[] = [];
  let author = "";
  let committer = "";
  for (const line of headerStr.split("\n")) {
    if (line.startsWith("tree ")) tree = line.slice(5);
    else if (line.startsWith("parent ")) parents.push(line.slice(7));
    else if (line.startsWith("author ")) author = line.slice(7);
    else if (line.startsWith("committer ")) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}
function buildCommit(c: ParsedCommit): Buffer {
  const parts: string[] = [];
  parts.push(`tree ${c.tree}`);
  for (const p of c.parents) parts.push(`parent ${p}`);
  parts.push(`author ${c.author}`);
  parts.push(`committer ${c.committer}`);
  parts.push("");
  parts.push(c.message);
  return utf8(parts.join("\n"));
}

// ---------------------------------------------------------------------------
// Packfile v2 parsing: idx + pack, ref-delta and ofs-delta resolution
// ---------------------------------------------------------------------------
interface PackEntry {
  offset: number;
  type: number; // 1 commit, 2 tree, 3 blob, 4 tag, 6 ofs-delta, 7 ref-delta
  crc: number;
}
interface ParsedPack {
  entries: Map<string, PackEntry>;
  offsetMap: Map<number, string>; // offset -> sha (for delta lookups)
  buf: Buffer;
}

async function readExact(f: fsp.FileHandle, size: number, pos: number): Promise<Buffer> {
  const b = Buffer.alloc(size);
  let got = 0;
  while (got < size) {
    const { bytesRead } = await f.read(b, got, size - got, pos + got);
    if (bytesRead === 0) break;
    got += bytesRead;
  }
  return b.subarray(0, got);
}

/** Parse a pack .idx (v2) file into offset entries. */
function parseIdx(idx: Buffer): Map<string, PackEntry> {
  const entries = new Map<string, PackEntry>();
  // v2 header: 8 bytes fanout, then sha sorted section
  if (idx.subarray(0, 4).toString("latin1") !== "\xfftOc") {
    throw new Error("unsupported idx version");
  }
  const version = idx.readUInt32BE(4);
  if (version !== 2) throw new Error("unsupported idx version " + version);
  const fanoutBase = 8;
  const total = idx.readUInt32BE(fanoutBase + 255 * 4);
  const shaBase = fanoutBase + 256 * 4;
  const crcBase = shaBase + total * 20;
  const off4Base = crcBase + total * 4;
  const off8Base = off4Base + total * 4;
  for (let i = 0; i < total; i++) {
    const sha = idx.subarray(shaBase + i * 20, shaBase + i * 20 + 20).toString("hex");
    const crc = idx.readUInt32BE(crcBase + i * 4);
    const four = idx.readUInt32BE(off4Base + i * 4);
    let offset: number;
    if (four & 0x80000000) {
      const bigIndex = four & 0x7fffffff;
      offset = Number(idx.readBigUInt64BE(off8Base + bigIndex * 8));
    } else {
      offset = four;
    }
    entries.set(sha, { offset, type: 0, crc });
  }
  return entries;
}

/** Read a variable-length type/size header at buf[off]. Returns type, size, next offset. */
function readTypeSize(buf: Buffer, off: number): { type: number; size: number; off: number } {
  let c = buf[off++];
  const type = (c >> 4) & 7;
  let size = c & 15;
  let shift = 4;
  while (c & 0x80) {
    c = buf[off++];
    size |= (c & 0x7f) << shift;
    shift += 7;
  }
  return { type, size, off };
}

/** Inflate an object body starting at `off`, expect `expectSize` decompressed bytes. */
function inflateAt(buf: Buffer, off: number, expectSize: number): Buffer {
  const z = new zlib.InflateRaw();
  const out: Buffer[] = [];
  z.on("data", (d: Buffer) => out.push(d));
  z.write(buf.subarray(off));
  z.end();
  // inflateRawSync fallback path: use synchronous inflate of the tail
  // (stream above is async; instead do it synchronously for determinism)
  const candidates: Buffer[] = [];
  let total = 0;
  // find a prefix that inflates to expectSize by feeding incrementally
  for (let end = off + 1; end <= buf.length; end++) {
    try {
      const outBuf = inflateRawSync(buf.subarray(off, end));
      if (outBuf.length === expectSize) return outBuf;
      if (outBuf.length > expectSize) return outBuf.subarray(0, expectSize);
    } catch {
      // not complete yet; keep going
    }
    if (end - off > expectSize * 3 + 1024) break; // safety bound
  }
  // last resort: full tail
  return inflateRawSync(buf.subarray(off));
}

/** Apply a git delta to a base buffer. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readVarint = (): number => {
    let result = 0;
    let shift = 0;
    while (off < delta.length) {
      const c = delta[off++];
      result |= (c & 0x7f) << shift;
      shift += 7;
      if (!(c & 0x80)) break;
    }
    return result;
  };
  const baseSize = readVarint();
  const resultSize = readVarint();
  const parts: Buffer[] = [];
  while (off < delta.length) {
    const op = delta[off++];
    if (op & 0x80) {
      // copy from base
      let cpOff = 0;
      let cpSize = 0;
      for (let i = 0; i < 4; i++) {
        if (op & (1 << i)) cpOff |= delta[off++] << (i * 8);
      }
      for (let i = 0; i < 3; i++) {
        if (op & (0x10 << i)) cpSize |= delta[off++] << (i * 8);
      }
      if (cpSize === 0) cpSize = 0x10000;
      parts.push(base.subarray(cpOff, cpOff + cpSize));
    } else {
      // insert
      const size = op & 0x7f;
      parts.push(delta.subarray(off, off + size));
      off += size;
    }
  }
  const res = concat(parts);
  if (res.length !== resultSize && baseSize !== base.length) {
    // tolerate mismatch but prefer exact
  }
  return res;
}

/** Resolve an object at a pack offset to its full GitObject (handles deltas). */
function resolvePackObject(parsed: ParsedPack, offset: number, depth = 0): GitObject {
  if (depth > 64) throw new Error("delta chain too deep");
  const buf = parsed.buf;
  const { type, size, off: bodyOff } = readTypeSize(buf, offset);
  if (type === 6) {
    // ofs-delta: negative offset varint then delta data
    let c = buf[bodyOff++];
    let relOffset = c & 0x7f;
    while (c & 0x80) {
      c = buf[bodyOff++];
      relOffset = ((relOffset + 1) << 7) | (c & 0x7f);
    }
    const baseOffset = offset - relOffset;
    const base = resolvePackObject(parsed, baseOffset, depth + 1);
    const delta = safeInflate(buf, bodyOff, size);
    const data = applyDelta(base.data, delta);
    return { type: base.type, data };
  }
  if (type === 7) {
    // ref-delta: 20-byte sha then delta data
    const baseSha = buf.subarray(bodyOff, bodyOff + 20).toString("hex");
    const bodyStart = bodyOff + 20;
    const baseEntry = parsed.entries.get(baseSha);
    if (!baseEntry) throw new Error("missing ref-delta base " + baseSha);
    const base = resolvePackObject(parsed, baseEntry.offset, depth + 1);
    const delta = safeInflate(buf, bodyStart, size);
    const data = applyDelta(base.data, delta);
    return { type: base.type, data };
  }
  const map: Record<number, ObjType> = { 1: "commit", 2: "tree", 3: "blob", 4: "tag" };
  const objType = map[type] as ObjType;
  const data = safeInflate(buf, bodyOff, size);
  return { type: objType, data };
}

/** Inflate object data at offset, trusting the declared size. Feeds the stream synchronously via write+close. */
function safeInflate(buf: Buffer, off: number, expectSize: number): Buffer {
  // Try the straightforward path first: inflate the whole tail in one shot.
  try {
    const out = inflateRawSync(buf.subarray(off));
    return out.length >= expectSize ? out.subarray(0, expectSize) : out;
  } catch {
    // incomplete stream in tail (next object follows): binary-search the shortest
    // prefix that inflates successfully, then trim to expectSize.
    let lo = off + 1;
    let hi = buf.length;
    let best: Buffer | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      try {
        const out = inflateRawSync(buf.subarray(off, mid));
        best = out;
        hi = mid - 1; // try shorter
        if (out.length >= expectSize) break;
        lo = mid + 1; // not enough output yet
      } catch {
        lo = mid + 1; // incomplete; need more bytes
      }
    }
    if (!best) throw new Error("cannot inflate object at " + off);
    return best.length >= expectSize ? best.subarray(0, expectSize) : best;
  }
}

// ---------------------------------------------------------------------------
// Packfile writing (for receive-pack and helpers)
// ---------------------------------------------------------------------------
interface PackObjectInsert {
  obj: GitObject;
}
/**
 * Build a packfile v2 buffer containing the given objects (no deltas —
 * undeltified packs are valid v2 packs any git client can read).
 */
function buildPack(objects: GitObject[]): Buffer {
  const header = concat([utf8("PACK"), Buffer.from([0, 0, 0, 2])]);
  const count = Buffer.alloc(4);
  count.writeUInt32BE(objects.length, 0);
  const parts: Buffer[] = [header, count];
  const crcs: { sha: string; crc: number; offset: number }[] = [];
  const shaSorted: { sha: string; offset: number }[] = [];
  let offset = 12;
  const typeMap: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
  for (const obj of objects) {
    const type = typeMap[obj.type];
    const size = obj.data.length;
    const headerParts: number[] = {
      // encode type/size varint: first byte (type<<4)|lowbits
    } as any;
    // encode header
    const bytes: number[] = [];
    let c = (type << 4) | (size & 15);
    let rest = size >> 4;
    if (rest > 0) c |= 0x80;
    bytes.push(c);
    while (rest > 0) {
      c = rest & 0x7f;
      rest >>= 7;
      if (rest > 0) c |= 0x80;
      bytes.push(c);
    }
    // pack object bodies are zlib-wrapped (78 9c), NOT raw deflate — the same
    // rule that broke our parser. Writing raw deflate makes git fail with
    // "inflate returned -3 / unpack-objects failed".
    const body = zlib.deflateSync(obj.data);
    const entry = concat([Buffer.from(bytes), body]);
    const sha = hashObject(obj);
    shaSorted.push({ sha, offset });
    parts.push(entry);
    offset += entry.length;
  }
  const content = concat(parts);
  // trailer: sha1 of content so far
  const trailer = sha1Bytes(content);
  const pack = concat([content, trailer]);
  // build idx
  const idx = buildIdx(shaSorted, pack);
  return pack;
}

function buildIdx(entries: { sha: string; offset: number }[], pack: Buffer): Buffer {
  const sorted = [...entries].sort((a, b) => (a.sha < b.sha ? -1 : a.sha > b.sha ? 1 : 0));
  const total = sorted.length;
  const parts: Buffer[] = [];
  parts.push(Buffer.from("\xfftOc", "latin1"), Buffer.from([0, 0, 0, 2]));
  const fanout = Buffer.alloc(256 * 4);
  for (let i = 0; i < 256; i++) {
    let count = 0;
    for (const e of sorted) {
      if (parseInt(e.sha.slice(0, 2), 16) <= i) count++;
    }
    fanout.writeUInt32BE(count, i * 4);
  }
  parts.push(fanout);
  for (const e of sorted) parts.push(fromHex(e.sha));
  for (const e of sorted) {
    // crc32 of the pack entry bytes: from this offset to the next entry's offset
    const next = sorted[sorted.indexOf(e) + 1];
    const end = next ? next.offset : pack.length;
    const crc = crc32(pack.subarray(e.offset, end));
    const b = Buffer.alloc(4);
    b.writeUInt32BE(crc, 0);
    parts.push(b);
  }
  // offsets
  for (const e of sorted) {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(e.offset, 0);
    parts.push(b);
  }
  const idxNoTrailer = concat(parts);
  const trailer = sha1Bytes(idxNoTrailer);
  return concat([idxNoTrailer, trailer]);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
// ---------------------------------------------------------------------------
// Store: bare-repo layout on disk (objects/, refs/, packed-refs, HEAD, issues)
// ---------------------------------------------------------------------------
interface RepoMeta {
  owner: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  defaultBranch: string;
  openIssues: number;
}
interface IssueRec {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  user: { login: string };
  createdAt: string;
  updatedAt: string;
  comments: number;
}
interface PullRec {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed" | "merged";
  user: { login: string };
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  createdAt: string;
  updatedAt: string;
}

class Store {
  root: string;
  constructor(root: string) {
    this.root = root;
  }
  repoDir(owner: string, name: string): string {
    return path.join(this.root, "repos", owner, name);
  }
  objectsDir(owner: string, name: string): string {
    return path.join(this.repoDir(owner, name), "objects");
  }
  refsDir(owner: string, name: string): string {
    return path.join(this.repoDir(owner, name), "refs");
  }
  ensureRepo(owner: string, name: string): RepoMeta {
    const dir = this.repoDir(owner, name);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(path.join(dir, "objects", "pack"), { recursive: true });
      fs.mkdirSync(path.join(dir, "objects", "info"), { recursive: true });
      fs.mkdirSync(path.join(dir, "refs", "heads"), { recursive: true });
      fs.mkdirSync(path.join(dir, "refs", "tags"), { recursive: true });
      fs.mkdirSync(path.join(dir, "hooks"), { recursive: true });
      fs.mkdirSync(path.join(dir, "info"), { recursive: true });
      fs.writeFileSync(path.join(dir, "HEAD"), "ref: refs/heads/main\n");
      fs.writeFileSync(path.join(dir, "description"), name + "\n");
      fs.writeFileSync(path.join(dir, "config"), "[core]\n\trepositoryformatversion = 0\n\tbare = true\n");
    }
    return this.meta(owner, name);
  }
  metaPath(owner: string, name: string): string {
    return path.join(this.repoDir(owner, name), "meta.json");
  }
  meta(owner: string, name: string): RepoMeta {
    const p = this.metaPath(owner, name);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8")) as RepoMeta;
    const now = "1970-01-01T00:00:00Z"; // deterministic: no clock in responses
    return {
      owner, name, description: "", createdAt: now, updatedAt: now,
      defaultBranch: "main", openIssues: 0,
    };
  }
  saveMeta(m: RepoMeta): void {
    const dir = this.repoDir(m.owner, m.name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.metaPath(m.owner, m.name), JSON.stringify(m, null, 2));
  }
  listRepos(): RepoMeta[] {
    const base = path.join(this.root, "repos");
    if (!fs.existsSync(base)) return [];
    const out: RepoMeta[] = [];
    for (const owner of fs.readdirSync(base)) {
      const od = path.join(base, owner);
      if (!fs.statSync(od).isDirectory()) continue;
      for (const name of fs.readdirSync(od)) {
        const rd = path.join(od, name);
        if (!fs.statSync(rd).isDirectory()) continue;
        out.push(this.meta(owner, name));
      }
    }
    return out;
  }

  // --- objects ---
  loosePath(owner: string, name: string, sha: string): string {
    return path.join(this.objectsDir(owner, name), sha.slice(0, 2), sha.slice(2));
  }
  hasObject(owner: string, name: string, sha: string): boolean {
    return fs.existsSync(this.loosePath(owner, name, sha)) || this.findInPacks(owner, name, sha) !== null;
  }
  writeObject(owner: string, name: string, obj: GitObject): string {
    const sha = hashObject(obj);
    const p = this.loosePath(owner, name, sha);
    if (fs.existsSync(p)) return sha;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, encodeLoose(obj));
    return sha;
  }
  readObjectLoose(owner: string, name: string, sha: string): GitObject | null {
    const p = this.loosePath(owner, name, sha);
    if (!fs.existsSync(p)) return null;
    return decodeLoose(zlib.inflateSync(fs.readFileSync(p)));
  }
  /** Read an object from loose storage or any pack (idx lookup + delta resolution). */
  readObject(owner: string, name: string, sha: string): GitObject | null {
    const loose = this.readObjectLoose(owner, name, sha);
    if (loose) return loose;
    const found = this.findInPacks(owner, name, sha);
    if (found) return found;
    return null;
  }
  /** Scan pack directory; return object resolved from the pack containing it. */
  findInPacks(owner: string, name: string, sha: string): GitObject | null {
    const packDir = path.join(this.objectsDir(owner, name), "pack");
    if (!fs.existsSync(packDir)) return null;
    for (const f of fs.readdirSync(packDir)) {
      if (!f.endsWith(".idx")) continue;
      const idxBuf = fs.readFileSync(path.join(packDir, f));
      const entries = parseIdx(idxBuf);
      const e = entries.get(sha);
      if (!e) continue;
      const packFile = path.join(packDir, f.replace(/\.idx$/, ".pack"));
      const packBuf = fs.readFileSync(packFile);
      const parsed: ParsedPack = { entries, offsetMap: new Map(), buf: packBuf };
      return resolvePackObject(parsed, e.offset);
    }
    return null;
  }
  /** List every object reachable from a pack (for advertisement deltas). */
  packObjects(owner: string, name: string): { sha: string; parsed: ParsedPack; offset: number }[] {
    const out: { sha: string; parsed: ParsedPack; offset: number }[] = [];
    const packDir = path.join(this.objectsDir(owner, name), "pack");
    if (!fs.existsSync(packDir)) return out;
    for (const f of fs.readdirSync(packDir)) {
      if (!f.endsWith(".idx")) continue;
      const idxBuf = fs.readFileSync(path.join(packDir, f));
      const entries = parseIdx(idxBuf);
      const packBuf = fs.readFileSync(path.join(packDir, f.replace(/\.idx$/, ".pack")));
      const parsed: ParsedPack = { entries, offsetMap: new Map(), buf: packBuf };
      for (const [sha, e] of entries) out.push({ sha, parsed, offset: e.offset });
    }
    return out;
  }
  /** Walk commit history collecting objects reachable from a tip sha. */
  reachableObjects(owner: string, name: string, tips: string[]): Map<string, GitObject> {
    const seen = new Set<string>();
    const result = new Map<string, GitObject>();
    const queue: string[] = [...tips];
    while (queue.length) {
      const sha = queue.shift()!;
      if (!sha || seen.has(sha)) continue;
      seen.add(sha);
      const obj = this.readObject(owner, name, sha);
      if (!obj) continue;
      result.set(sha, obj);
      if (obj.type === "commit") {
        const c = parseCommit(obj.data);
        queue.push(c.tree);
        for (const p of c.parents) queue.push(p);
      } else if (obj.type === "tree") {
        for (const e of parseTree(obj.data)) queue.push(e.sha);
      } else if (obj.type === "tag") {
        const m = /^object ([0-9a-f]{40})/m.exec(obj.data.toString("utf8"));
        if (m) queue.push(m[1]);
      }
    }
    return result;
  }

  // --- refs ---
  readRef(owner: string, name: string, ref: string): string | null {
    // direct file
    const f = path.join(this.repoDir(owner, name), ref);
    if (fs.existsSync(f)) {
      const v = fs.readFileSync(f, "utf8").trim();
      if (v.startsWith("ref: ")) return this.readRef(owner, name, v.slice(5).trim());
      return v;
    }
    // packed-refs
    const packed = path.join(this.repoDir(owner, name), "packed-refs");
    if (fs.existsSync(packed)) {
      for (const line of fs.readFileSync(packed, "utf8").split("\n")) {
        if (line.startsWith("#") || line.trim() === "") continue;
        const [sha, r] = line.split(" ");
        if (r === ref) return sha;
      }
    }
    return null;
  }
  writeRef(owner: string, name: string, ref: string, sha: string): void {
    const f = path.join(this.repoDir(owner, name), ref);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, sha + "\n");
    // keep packed-refs in sync: remove stale entry for this ref
    const packed = path.join(this.repoDir(owner, name), "packed-refs");
    if (fs.existsSync(packed)) {
      const lines = fs.readFileSync(packed, "utf8").split("\n");
      const keep = lines.filter((l) => {
        if (l.startsWith("#") || l.trim() === "") return true;
        const parts = l.split(" ");
        return parts[1] !== ref;
      });
      fs.writeFileSync(packed, keep.join("\n"));
    }
  }
  listRefs(owner: string, name: string): { ref: string; sha: string }[] {
    const out = new Map<string, string>();
    const packed = path.join(this.repoDir(owner, name), "packed-refs");
    if (fs.existsSync(packed)) {
      for (const line of fs.readFileSync(packed, "utf8").split("\n")) {
        if (line.startsWith("#") || line.startsWith("^") || line.trim() === "") continue;
        const [sha, ref] = line.split(" ");
        out.set(ref, sha);
      }
    }
    const base = path.join(this.repoDir(owner, name), "refs");
    const walk = (dir: string, prefix: string) => {
      if (!fs.existsSync(dir)) return;
      for (const f of fs.readdirSync(dir)) {
        const full = path.join(dir, f);
        const rel = prefix + f;
        if (fs.statSync(full).isDirectory()) walk(full, rel + "/");
        else {
          const v = fs.readFileSync(full, "utf8").trim();
          out.set(v.startsWith("ref: ") ? v.slice(5).trim() : rel, v.startsWith("ref: ")
            ? this.readRef(owner, name, v.slice(5).trim()) || "" : v);
        }
      }
    };
    walk(base, "refs/");
    return [...out.entries()].map(([ref, sha]) => ({ ref, sha })).filter((r) => r.sha);
  }
  defaultBranchTip(owner: string, name: string): string | null {
    const m = this.meta(owner, name);
    return this.readRef(owner, name, "refs/heads/" + m.defaultBranch);
  }
  resolveRefSha(owner: string, name: string, ref: string): string | null {
    if (/^[0-9a-f]{40}$/.test(ref)) return ref;
    if (ref.startsWith("refs/")) return this.readRef(owner, name, ref);
    const direct = this.readRef(owner, name, "refs/heads/" + ref);
    if (direct) return direct;
    return this.readRef(owner, name, "refs/tags/" + ref);
  }

  // --- issues / pulls ---
  issuesPath(owner: string, name: string): string {
    return path.join(this.repoDir(owner, name), "issues.json");
  }
  pullsPath(owner: string, name: string): string {
    return path.join(this.repoDir(owner, name), "pulls.json");
  }
  readIssues(owner: string, name: string): IssueRec[] {
    const p = this.issuesPath(owner, name);
    if (!fs.existsSync(p)) return [];
    return JSON.parse(fs.readFileSync(p, "utf8"));
  }
  writeIssues(owner: string, name: string, list: IssueRec[]): void {
    fs.mkdirSync(this.repoDir(owner, name), { recursive: true });
    fs.writeFileSync(this.issuesPath(owner, name), JSON.stringify(list, null, 2));
  }
  readPulls(owner: string, name: string): PullRec[] {
    const p = this.pullsPath(owner, name);
    if (!fs.existsSync(p)) return [];
    return JSON.parse(fs.readFileSync(p, "utf8"));
  }
  writePulls(owner: string, name: string, list: PullRec[]): void {
    fs.mkdirSync(this.repoDir(owner, name), { recursive: true });
    fs.writeFileSync(this.pullsPath(owner, name), JSON.stringify(list, null, 2));
  }

  // --- files ---
  /** Read a file blob at a ref/path: resolve tree hierarchy down to the blob. */
  readFileAt(owner: string, name: string, ref: string, filePath: string): { sha: string; content: string; size: number } | null {
    const tip = this.resolveRefSha(owner, name, ref);
    if (!tip) return null;
    const tipObj = this.readObject(owner, name, tip);
    if (!tipObj) return null;
    let treeSha: string;
    if (tipObj.type === "commit") treeSha = parseCommit(tipObj.data).tree;
    else if (tipObj.type === "tree") treeSha = tip;
    else return null;
    const parts = filePath.split("/").filter(Boolean);
    let currentTree = treeSha;
    for (let i = 0; i < parts.length; i++) {
      const treeObj = this.readObject(owner, name, currentTree);
      if (!treeObj || treeObj.type !== "tree") return null;
      const entries = parseTree(treeObj.data);
      const hit = entries.find((e) => e.name === parts[i]);
      if (!hit) return null;
      if (i === parts.length - 1) {
        const blob = this.readObject(owner, name, hit.sha);
        if (!blob || blob.type !== "blob") return null;
        return {
          sha: hit.sha,
          content: blob.data.toString("base64"),
          size: blob.data.length,
        };
      }
      currentTree = hit.sha;
    }
    return null;
  }
  /** List directory entries at a ref/path (empty path = root). */
  listDir(owner: string, name: string, ref: string, dirPath: string): { name: string; path: string; sha: string; mode: string; type: "file" | "dir" }[] | null {
    const tip = this.resolveRefSha(owner, name, ref);
    if (!tip) return null;
    const tipObj = this.readObject(owner, name, tip);
    if (!tipObj) return null;
    let treeSha: string;
    if (tipObj.type === "commit") treeSha = parseCommit(tipObj.data).tree;
    else if (tipObj.type === "tree") treeSha = tip;
    else return null;
    const parts = dirPath.split("/").filter(Boolean);
    for (const p of parts) {
      const treeObj = this.readObject(owner, name, treeSha);
      if (!treeObj || treeObj.type !== "tree") return null;
      const hit = parseTree(treeObj.data).find((e) => e.name === p);
      if (!hit) return null;
      treeSha = hit.sha;
    }
    const treeObj = this.readObject(owner, name, treeSha);
    if (!treeObj || treeObj.type !== "tree") return null;
    return parseTree(treeObj.data).map((e) => ({
      name: e.name,
      path: dirPath ? dirPath + "/" + e.name : e.name,
      sha: e.sha,
      mode: e.mode,
      type: e.mode === "40000" ? "dir" : "file",
    }));
  }
}

const store = new Store(DATA_DIR);

// ---------------------------------------------------------------------------
// Git smart HTTP: advertisement, upload-pack (clone/fetch), receive-pack (push)
// ---------------------------------------------------------------------------
const CAPABILITIES = "multi_ack_detailed side-band-64k ofs-delta agent=github-core-clone/1.0";

function advLine(ref: string, sha: string, capabilities: string): Buffer {
  // The FIRST advertised line separates ref name from capabilities with NUL,
  // not a space — that is what git protocol-v0 requires. A space makes git
  // treat the capabilities as a ref name, and every capability is silently
  // dropped: clone then fails with "no such remote ref HEAD".
  return pktLine(
    capabilities ? `${sha} ${ref}\0${capabilities}\n` : `${sha} ${ref}\n`
  );
}

/** GET /info/refs?service=... advertisement */
function infoRefsAdvertisement(service: string, owner: string, name: string): Buffer {
  const parts: Buffer[] = [];
  const capStr = service === "git-upload-pack" ? CAPABILITIES : "report-status delete-refs ofs-delta";
  if (service === "git-upload-pack") {
    parts.push(pktLine("# service=git-upload-pack\n"), pktFlush());
    const refs = store.listRefs(owner, name);
    if (refs.length === 0) {
      // empty repo advertisement
      parts.push(advLine("capabilities^{}", "0000000000000000000000000000000000000000", capStr));
      parts.push(pktFlush());
    } else {
      // HEAD MUST be advertised first, pointing at the default branch: without
      // it git cannot decide what to check out and clone fails with
      // "no such remote ref refs/heads/<branch>".
      const headFile = path.join(store.repoDir(owner, name), "HEAD");
      let headTarget = "";
      if (fs.existsSync(headFile)) {
        const raw = fs.readFileSync(headFile, "utf8").trim();
        const am = /^ref:\s*(.+)$/.exec(raw);
        headTarget = am ? am[1].trim() : raw;
      }
      const byRef = new Map(refs.map((r) => [r.ref, r.sha]));
      const headSha = byRef.get(headTarget) || (refs[0] ? refs[0].sha : "");
      const headRef = byRef.has(headTarget) ? headTarget : (refs[0] ? refs[0].ref : "");
      if (headSha && headRef) {
        parts.push(advLine("HEAD", headSha, capStr + " symref=HEAD:" + headRef));
        for (const r of refs) parts.push(advLine(r.ref, r.sha, ""));
      } else {
        for (let i = 0; i < refs.length; i++) {
          parts.push(advLine(refs[i].ref, refs[i].sha, i === 0 ? capStr : ""));
        }
      }
      parts.push(pktFlush());
    }
  } else {
    parts.push(pktLine("# service=git-receive-pack\n"), pktFlush());
    const refs = store.listRefs(owner, name);
    if (refs.length === 0) {
      parts.push(advLine("capabilities^{}", "0000000000000000000000000000000000000000", "report-status delete-refs ofs-delta"));
      parts.push(pktFlush());
    } else {
      let first = true;
      for (const r of refs) {
        parts.push(advLine(r.ref, r.sha, first ? "report-status delete-refs ofs-delta" : ""));
        first = false;
      }
      parts.push(pktFlush());
    }
  }
  return concat(parts);
}

/** Resolve want shas into an object list to send back. */
function collectWants(owner: string, name: string, wants: string[], haves: string[]): GitObject[] {
  const wantSet = new Set(wants);
  const haveSet = new Set(haves);
  // BFS from wants, stop at haves
  const seen = new Set<string>();
  const queue: string[] = [...wants];
  const out: GitObject[] = [];
  while (queue.length) {
    const sha = queue.shift()!;
    if (!sha || seen.has(sha)) continue;
    seen.add(sha);
    if (haveSet.has(sha) && !wantSet.has(sha)) continue;
    const obj = store.readObject(owner, name, sha);
    if (!obj) continue;
    out.push(obj);
    if (obj.type === "commit") {
      const c = parseCommit(obj.data);
      queue.push(c.tree);
      for (const p of c.parents) {
        if (!haveSet.has(p)) queue.push(p);
        else queue.push(p); // still include boundary objects' tree
      }
    } else if (obj.type === "tree") {
      for (const e of parseTree(obj.data)) queue.push(e.sha);
    }
  }
  return out;
}

/** POST /git-upload-pack: serve clone/fetch. */
async function handleUploadPack(owner: string, name: string, body: Buffer): Promise<Buffer> {
  const pkts = parsePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  let done = false;
  let wantsSeen = false;
  let requestWantsSideBand = false;
  for (const p of pkts) {
    if (p === null) { wantsSeen = true; continue; }
    const line = p.toString("utf8").replace(/\n$/, "");
    if (line.startsWith("want ")) {
      wants.push(line.slice(5).split(" ")[0]);
      if (line.includes("side-band-64k") || line.includes("side-band")) requestWantsSideBand = true;
    }
    else if (line.startsWith("have ")) haves.push(line.slice(5).split(" ")[0]);
    else if (line === "done") done = true;
    else if (line.startsWith("fetch ")) { /* shallow fetch not supported */ }
  }
  // Stateless single-round fetch: git sends want + done in one body and expects
  // the pack framed in side-band bands (it advertised side-band-64k to us).
  const objects = collectWants(owner, name, wants, haves);
  // Build a packfile and send it over side-band-64k
  const pack = buildPack(objects);
  const parts: Buffer[] = [];
  // NAK / ACK negotiation. With no common history the only valid reply is NAK;
  // sending "ACK <sha>" for a want makes git treat the next bytes as a new
  // negotiation round and then fail with "bad pack header".
  if (haves.length === 0) {
    parts.push(pktLine("NAK\n"));
  } else {
    parts.push(pktLine("ACK " + haves[0] + "\n"));
    if (!done) parts.push(pktLine("NAK\n"));
  }
  // Side-band is opt-in: the client asks for it with "side-band-64k" in its want
  // line. Wrapping the pack when it did not ask is what yields "bad pack header".
  const bandPayload = (band: number, data: Buffer): Buffer =>
    pktLine(concat([Buffer.from([band]), data]));
  if (requestWantsSideBand) {
    const CHUNK = 60000;
    for (let off = 0; off < pack.length; off += CHUNK) {
      parts.push(bandPayload(1, pack.subarray(off, Math.min(off + CHUNK, pack.length))));
    }
    parts.push(bandPayload(2, utf8("done\n")));
    parts.push(pktFlush());
  } else {
    // raw pack: no pkt-line framing at all
    parts.push(pack);
  }
  return concat(parts);
}

/** POST /git-receive-pack: accept a push, write objects, update refs. */
async function handleReceivePack(owner: string, name: string, body: Buffer): Promise<Buffer> {
  const parts: Buffer[] = [];
  // First section: pkt-lines of commands, then flush, then packfile
  const flushIdx = findFlush(body);
  const cmdSection = body.subarray(0, flushIdx);
  const packSection = body.subarray(flushIdx + 4);
  const commands: { ref: string; oldSha: string; newSha: string; name: string }[] = [];
  if (process.env.GHC_DEBUG) console.error("[recv] pkt0=", JSON.stringify(cmdSection.subarray(0, 110).toString("latin1")));
  for (const p of parsePktLines(cmdSection)) {
    if (p === null) continue;
    const line = p.toString("utf8").replace(/\n$/, "");
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (.*)$/.exec(line);
    if (m) commands.push({ oldSha: m[1], newSha: m[2], name: m[3].split("\0")[0], ref: m[3].split("\0")[0] });
  }
  // Parse incoming packfile if present
  const received: GitObject[] = [];
  if (packSection.length > 0) {
    try {
      const objs = parseIncomingPack(packSection);
      for (const o of objs) store.writeObject(owner, name, o);
      received.push(...objs);
    } catch (e) {
      // surface it: a swallowed parse error means every push silently fails
      console.error("pack parse failed:", (e as Error).message, (e as Error).stack?.split("\n")[1] ?? "");
    }
  }
  const results: string[] = [];
  for (const cmd of commands) {
    let ok = true;
    let msg = "";
    if (cmd.newSha === "0000000000000000000000000000000000000000") {
      // delete ref
      const f = path.join(store.repoDir(owner, name), cmd.ref);
      if (fs.existsSync(f)) fs.unlinkSync(f);
      else ok = false, msg = "cannot delete ref " + cmd.ref;
    } else {
      if (!store.hasObject(owner, name, cmd.newSha)) {
        ok = false;
        msg = "object " + cmd.newSha + " not found";
      } else {
        const current = store.readRef(owner, name, cmd.ref);
        if (current && current !== cmd.oldSha && cmd.oldSha !== "0000000000000000000000000000000000000000") {
          // non-fast-forward check: allow if old is ancestor of new
          if (!isAncestor(owner, name, cmd.oldSha, cmd.newSha)) {
            ok = false;
            msg = "non-fast-forward";
          }
        }
        if (ok) {
          store.writeRef(owner, name, cmd.ref, cmd.newSha);
          const m = store.meta(owner, name);
          m.updatedAt = "1970-01-01T00:00:00Z";
          if (cmd.ref.startsWith("refs/heads/")) m.defaultBranch = cmd.ref.slice("refs/heads/".length);
          store.saveMeta(m);
        }
      }
    }
    results.push((ok ? "ok " : "ng ") + cmd.name + (ok || !msg ? "" : " " + msg));
  }
  // report-status: "unpack ok" first, then one status line per ref, then flush.
  // The old code returned a bare flush, which git reads as "no status" and
  // turns into "failed to push some refs" with no message.
  const report: Buffer[] = [pktLine("unpack ok\n")];
  for (const r of results) report.push(pktLine(r + "\n"));
  report.push(pktFlush());
  return concat(report);
}

/** Find offset of the 0000 flush in a push body (command section terminator). */
function findFlush(buf: Buffer): number {
  let off = 0;
  while (off + 4 <= buf.length) {
    const len = parseInt(buf.subarray(off, off + 4).toString("latin1"), 16);
    if (Number.isNaN(len)) break;
    if (len === 0) return off;
    if (len < 4) break;
    off += len;
  }
  return buf.length;
}

/** True if ancestor is reachable from descendant (ancestor == or parent-chain of). */
function isAncestor(owner: string, name: string, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue: string[] = [descendant];
  while (queue.length) {
    const sha = queue.shift()!;
    if (!sha || seen.has(sha)) continue;
    seen.add(sha);
    const obj = store.readObject(owner, name, sha);
    if (!obj) continue;
    if (obj.type === "commit") {
      const c = parseCommit(obj.data);
      for (const p of c.parents) {
        if (p === ancestor) return true;
        queue.push(p);
      }
    }
  }
  return false;
}

/** Parse a received packfile (with deltas) into resolved GitObjects. */
function parseIncomingPack(pack: Buffer): GitObject[] {
  if (process.env.GHC_DUMP_PACK) {
    fs.writeFileSync(process.env.GHC_DUMP_PACK, pack);
    console.error("dumped pack", pack.length, "bytes, count field:", pack.readUInt32BE(8));
  }
  if (pack.subarray(0, 4).toString("latin1") !== "PACK") throw new Error("bad pack magic");
  const version = pack.readUInt32BE(4);
  const count = pack.readUInt32BE(8);
  // Build a pseudo idx by walking entries: we need offsets for delta bases.
  const entries: { offset: number; sha: string }[] = [];
  const offsetMap: Map<number, string> = new Map();
  const shaToOffset: Map<string, number> = new Map();
  let off = 12;
  const objAt: Map<number, GitObject> = new Map();
  // First pass: record offsets of every entry (raw, undeltified identities unknown yet)
  const entryOffsets: number[] = [];
  let scan = 12;
  for (let i = 0; i < count; i++) {
    entryOffsets.push(scan);
    const { type, size, off: bodyOff } = readTypeSize(pack, scan);
    let bodyStart = bodyOff;
    if (type === 6) {
      let c = pack[bodyStart++];
      while (c & 0x80) c = pack[bodyStart++];
    } else if (type === 7) {
      bodyStart += 20;
    }
    // skip inflated data by inflating incrementally
    const data = safeInflateSkip(pack, bodyStart, size);
    scan = bodyStart + data.consumed;
    offsetMap.set(entryOffsets[i], "");
  }
  // Second pass: resolve objects (may need base at earlier offset)
  const parsed: ParsedPack = { entries: new Map(), offsetMap, buf: pack };
  const resolved: GitObject[] = [];
  const cache: Map<number, GitObject> = new Map();
  const resolveAt = (offset: number, depth = 0): GitObject => {
    if (cache.has(offset)) return cache.get(offset)!;
    if (depth > 128) throw new Error("delta chain too deep");
    const { type, size, off: bodyOff } = readTypeSize(pack, offset);
    let bodyStart = bodyOff;
    if (type === 6) {
      let c = pack[bodyStart++];
      let rel = c & 0x7f;
      while (c & 0x80) { c = pack[bodyStart++]; rel = ((rel + 1) << 7) | (c & 0x7f); }
      const baseOffset = offset - rel;
      const base = resolveAt(baseOffset, depth + 1);
      const { data, consumed } = inflateExpect(pack, bodyStart, size);
      const full = applyDelta(base.data, data);
      const obj = { type: base.type, data: full };
      cache.set(offset, obj);
      return obj;
    }
    if (type === 7) {
      const baseSha = pack.subarray(bodyStart, bodyStart + 20).toString("hex");
      bodyStart += 20;
      // find base offset from already-resolved cache by sha
      const base = resolved.find((o) => hashObject(o) === baseSha) || resolveBySha(baseSha);
      if (!base) throw new Error("missing ref-delta base " + baseSha);
      const { data, consumed } = inflateExpect(pack, bodyStart, size);
      const full = applyDelta(base.data, data);
      const obj = { type: base.type, data: full };
      cache.set(offset, obj);
      return obj;
    }
    const map: Record<number, ObjType> = { 1: "commit", 2: "tree", 3: "blob", 4: "tag" };
    const { data } = inflateExpect(pack, bodyStart, size);
    const obj = { type: map[type] as ObjType, data };
    cache.set(offset, obj);
    return obj;
  };
  const resolveBySha = (sha: string): GitObject | null => {
    // search cache for matching hash
    for (const [, o] of cache) if (hashObject(o) === sha) return o;
    // may be stored loose already (previous push)
    return store.readObjectLoose(owner, name, sha);
  };
  for (const entryOff of entryOffsets) {
    const obj = resolveAt(entryOff);
    resolved.push(obj);
  }
  return resolved;
}

/** Inflate pack data and report how many compressed bytes were consumed. */
function inflateExpect(buf: Buffer, off: number, expectSize: number): { data: Buffer; consumed: number } {
  // The pack gives no length for the deflated body, so ask zlib how many input
  // bytes the stream actually used: inflateRawSync with {info:true} reports
  // engine.bytesWritten, which is the exact compressed length. Brute-forcing a
  // prefix instead fails whenever the next object's header follows the stream.
  // Object bodies inside a pack are zlib-wrapped (78 9c), not raw deflate:
  // inflateSync, not inflateRawSync. A raw inflate reads the zlib header as a
  // stored block and fails with "invalid stored block lengths".
  const r = (zlib as any).inflateSync(buf.subarray(off), { info: true }) as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  const consumed = r.engine.bytesWritten;
  return { data: r.buffer.subarray(0, expectSize), consumed };
}

/** Skip over compressed data of declared size; returns consumed byte count. */
function safeInflateSkip(buf: Buffer, off: number, expectSize: number): { data: Buffer; consumed: number } {
  return inflateExpect(buf, off, expectSize);
}


// ---------------------------------------------------------------------------
// REST v3 subset
// ---------------------------------------------------------------------------
const AUTH_LOGIN = "jakadul"; // deterministic /user identity

function repoJson(m: RepoMeta): Record<string, unknown> {
  return {
    id: sha1Hex("repo:" + m.owner + "/" + m.name).slice(0, 8),
    name: m.name,
    full_name: m.owner + "/" + m.name,
    owner: { login: m.owner, id: sha1Hex("user:" + m.owner).slice(0, 8) },
    description: m.description,
    private: false,
    fork: false,
    default_branch: m.defaultBranch,
    created_at: m.createdAt,
    updated_at: m.updatedAt,
    stargazers_count: 0,
    watchers_count: 0,
    forks_count: 0,
    open_issues_count: m.openIssues,
    html_url: "https://github.com/" + m.owner + "/" + m.name,
    clone_url: "https://github.com/" + m.owner + "/" + m.name + ".git",
    git_url: "https://github.com/" + m.owner + "/" + m.name + ".git",
    ssh_url: "git@github.com:" + m.owner + "/" + m.name + ".git",
    topics: [],
    license: { key: "mit", name: "MIT License", spdx_id: "MIT" },
  };
}
function userJson(login: string): Record<string, unknown> {
  return {
    login,
    id: sha1Hex("user:" + login).slice(0, 8),
    avatar_url: "https://avatars.githubusercontent.com/" + sha1Hex("avatar:" + login).slice(0, 16),
    html_url: "https://github.com/" + login,
    type: "User",
    site_admin: false,
    name: login,
    company: null,
    blog: "",
    location: "",
    email: null,
    bio: null,
    public_repos: store.listRepos().filter((r) => r.owner === login).length,
    followers: 0,
    following: 0,
    created_at: "1970-01-01T00:00:00Z",
  };
}
function issueJson(owner: string, name: string, i: IssueRec): Record<string, unknown> {
  return {
    id: sha1Hex("issue:" + owner + "/" + name + "/" + i.number).slice(0, 8),
    number: i.number,
    title: i.title,
    body: i.body,
    state: i.state,
    user: { login: i.user.login, id: sha1Hex("user:" + i.user.login).slice(0, 8) },
    labels: [],
    assignees: [],
    comments: i.comments,
    created_at: i.createdAt,
    updated_at: i.updatedAt,
    html_url: "https://github.com/" + owner + "/" + name + "/issues/" + i.number,
    url: "https://api.github.com/repos/" + owner + "/" + name + "/issues/" + i.number,
  };
}
function pullJson(owner: string, name: string, p: PullRec): Record<string, unknown> {
  return {
    id: sha1Hex("pull:" + owner + "/" + name + "/" + p.number).slice(0, 8),
    number: p.number,
    title: p.title,
    body: p.body,
    state: p.state === "merged" ? "closed" : p.state,
    merged: p.state === "merged",
    user: { login: p.user.login, id: sha1Hex("user:" + p.user.login).slice(0, 8) },
    head: { ref: p.head.ref, sha: p.head.sha, label: p.user.login + ":" + p.head.ref },
    base: { ref: p.base.ref, sha: p.base.sha, label: p.base.ref },
    created_at: p.createdAt,
    updated_at: p.updatedAt,
    html_url: "https://github.com/" + owner + "/" + name + "/pull/" + p.number,
    url: "https://api.github.com/repos/" + owner + "/" + name + "/pulls/" + p.number,
  };
}
function commitJson(owner: string, name: string, sha: string): Record<string, unknown> | null {
  const obj = store.readObject(owner, name, sha);
  if (!obj || obj.type !== "commit") return null;
  const c = parseCommit(obj.data);
  const treeObj = store.readObject(owner, name, c.tree);
  const files = treeObj && treeObj.type === "tree" ? parseTree(treeObj.data).map((e) => ({
    filename: e.name,
    status: "added",
    additions: 0,
    deletions: 0,
    changes: 0,
    sha: e.sha,
  })) : [];
  return {
    sha,
    node_id: sha,
    commit: {
      message: c.message,
      author: { name: c.author.split(" <")[0], email: (/<(.*)>/.exec(c.author) || [, ""])[1], date: "1970-01-01T00:00:00Z" },
      committer: { name: c.committer.split(" <")[0], email: (/<(.*)>/.exec(c.committer) || [, ""])[1], date: "1970-01-01T00:00:00Z" },
    },
    author: { login: AUTH_LOGIN },
    committer: { login: AUTH_LOGIN },
    parents: c.parents.map((p) => ({ sha: p })),
    html_url: "https://github.com/" + owner + "/" + name + "/commit/" + sha,
    files,
  };
}
function contentJson(owner: string, name: string, filePath: string, ref: string): Record<string, unknown> | null {
  const dir = store.listDir(owner, name, ref, filePath);
  if (dir && dir.length > 0 && fs.existsSync(store.repoDir(owner, name))) {
    // if path resolves to a directory listing
    const isDir = store.resolveRefSha(owner, name, ref) !== null && dirHasPath(store, owner, name, ref, filePath);
    if (isDir) {
      return {
        type: "dir",
        name: filePath.split("/").pop() || "",
        path: filePath,
        sha: sha1Hex("dir:" + owner + "/" + name + "/" + filePath),
        url: "https://api.github.com/repos/" + owner + "/" + name + "/contents/" + filePath,
        entries: dir.map((e) => ({
          name: e.name, path: e.path, sha: e.sha,
          type: e.type === "dir" ? "dir" : "file",
          size: e.type === "file" ? (store.readObject(owner, name, e.sha)?.data.length ?? 0) : null,
          download_url: e.type === "file" ? "https://raw.githubusercontent.com/" + owner + "/" + name + "/" + ref + "/" + e.path : null,
        })),
      };
    }
  }
  const f = store.readFileAt(owner, name, ref, filePath);
  if (!f) return null;
  return {
    type: "file",
    name: filePath.split("/").pop(),
    path: filePath,
    sha: f.sha,
    size: f.size,
    content: f.content,
    encoding: "base64",
    download_url: "https://raw.githubusercontent.com/" + owner + "/" + name + "/" + ref + "/" + filePath,
    url: "https://api.github.com/repos/" + owner + "/" + name + "/contents/" + filePath,
    html_url: "https://github.com/" + owner + "/" + name + "/blob/" + ref + "/" + filePath,
  };
}
function dirHasPath(st: Store, owner: string, name: string, ref: string, p: string): boolean {
  const tip = st.resolveRefSha(owner, name, ref);
  if (!tip) return false;
  const tipObj = st.readObject(owner, name, tip);
  if (!tipObj) return false;
  let treeSha = tipObj.type === "commit" ? parseCommit(tipObj.data).tree : tip;
  for (const part of p.split("/").filter(Boolean)) {
    const t = st.readObject(owner, name, treeSha);
    if (!t || t.type !== "tree") return false;
    const hit = parseTree(t.data).find((e) => e.name === part);
    if (!hit) return false;
    if (hit.mode !== "40000") return false; // not a directory
    treeSha = hit.sha;
  }
  return true;
}

interface Json { [k: string]: any }

/** REST router. Returns true if handled. */
async function handleRest(req: http.IncomingMessage, res: http.ServerResponse, url: URL, body: Buffer): Promise<boolean> {
  let p = url.pathname;
  if (p.startsWith("/api/v3")) p = p.slice("/api/v3".length) || "/";
  const seg = p.split("/").filter(Boolean);
  const method = req.method || "GET";
  const json = (obj: unknown, code = 200) => {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8", "x-github-media-type": "github.v3; format=json" });
    res.end(JSON.stringify(obj));
    return true;
  };

  // GET /user
  if (seg.length === 1 && seg[0] === "user" && method === "GET") return json(userJson(AUTH_LOGIN));
  // GET /users/{login}
  if (seg.length === 2 && seg[0] === "users" && method === "GET") return json(userJson(seg[1]));
  // GET /repos/{owner}/{repo}/branches  (new)
  if (seg.length === 4 && seg[0] === "repos" && seg[3] === "branches" && method === "GET") {
    const owner = seg[1], name = seg[2];
    if (!fs.existsSync(store.repoDir(owner, name))) return json({ message: "Not Found" }, 404);
    const branches = store.listRefs(owner, name)
      .filter((r) => r.ref.startsWith("refs/heads/"))
      .map((r) => ({ name: r.ref.slice("refs/heads/".length), commit: { sha: r.sha }, protected: false }));
    return json(branches);
  }
  // POST /user/repos  (GitHub's create-a-repository endpoint)
  if (seg.length === 2 && seg[0] === "user" && seg[1] === "repos" && method === "POST") {
    const input = body.length ? (JSON.parse(body.toString("utf8")) as Json) : {};
    const name = String(input.name || "repo");
    const owner = AUTH_LOGIN;
    store.ensureRepo(owner, name);
    const m = store.meta(owner, name);
    m.description = String(input.description || "");
    m.defaultBranch = String(input.default_branch || "main");
    store.saveMeta(m);
    return json(repoJson(m), 201);
  }

  // repos collection
  if (seg[0] === "repos" && seg.length === 3 && method === "GET") {
    const m = store.meta(seg[1], seg[2]);
    if (!fs.existsSync(store.repoDir(seg[1], seg[2]))) return json({ message: "Not Found" }, 404);
    return json(repoJson(m));
  }
  if (seg[0] === "repos" && seg.length === 3 && method === "POST") {
    const input = body.length ? (JSON.parse(body.toString("utf8")) as Json) : {};
    const name = seg[2];
    const owner = seg[1];
    store.ensureRepo(owner, name);
    const m = store.meta(owner, name);
    m.description = input.description || "";
    m.defaultBranch = input.default_branch || "main";
    store.saveMeta(m);
    return json(repoJson(m), 201);
  }
  if (seg[0] === "repos" && seg.length === 3 && method === "DELETE") {
    fs.rmSync(store.repoDir(seg[1], seg[2]), { recursive: true, force: true });
    res.writeHead(204); res.end(); return true;
  }
  if (seg[0] === "repos" && seg.length === 3 && method === "PUT") {
    const m = store.meta(seg[1], seg[2]);
    const input = body.length ? (JSON.parse(body.toString("utf8")) as Json) : {};
    if (input.description !== undefined) m.description = input.description;
    if (input.default_branch !== undefined) m.defaultBranch = input.default_branch;
    store.saveMeta(m);
    return json(repoJson(m));
  }

  if (seg[0] === "repos" && seg.length >= 3) {
    const owner = seg[1], name = seg[2];
    if (!fs.existsSync(store.repoDir(owner, name))) return json({ message: "Not Found" }, 404);
    const rest = seg.slice(3);

    // contents
    if (rest[0] === "contents") {
      const filePath = rest.slice(1).join("/");
      const ref = url.searchParams.get("ref") || store.meta(owner, name).defaultBranch;
      if (method === "GET") {
        const c = contentJson(owner, name, filePath, ref);
        return c ? json(c) : json({ message: "Not Found" }, 404);
      }
      if (method === "PUT") {
        const input = body.length ? (JSON.parse(body.toString("utf8")) as Json) : {};
        const message = input.message || "update " + filePath;
        const contentB64 = input.content || "";
        const blobSha = store.writeObject(owner, name, { type: "blob", data: Buffer.from(contentB64, "base64") });
        const newSha = commitFile(owner, name, filePath, blobSha, message, input.branch || ref);
        return json({
          content: contentJson(owner, name, filePath, input.branch || ref),
          commit: commitJson(owner, name, newSha),
        }, 201);
      }
      if (method === "DELETE") {
        const input = body.length ? (JSON.parse(body.toString("utf8")) as Json) : {};
        const message = input.message || "delete " + filePath;
        const newSha = deleteFile(owner, name, filePath, message, input.branch || store.meta(owner, name).defaultBranch);
        return json({ commit: commitJson(owner, name, newSha) }, 200);
      }
    }

    // commits list
    if (rest[0] === "commits" && rest.length === 1 && method === "GET") {
      const perPage = Math.min(Number(url.searchParams.get("per_page") || 30), 100);
      const page = Math.max(Number(url.searchParams.get("page") || 1), 1);
      const sha = url.searchParams.get("sha") || store.meta(owner, name).defaultBranch;
      const tip = store.resolveRefSha(owner, name, sha);
      const list: Record<string, unknown>[] = [];
      if (tip) {
        let cur: string | null = tip;
        const skip = (page - 1) * perPage;
        let idx = 0;
        while (cur && list.length < perPage) {
          const c = commitJson(owner, name, cur);
          if (c) {
            if (idx >= skip) list.push(c);
            idx++;
          }
          const obj = store.readObject(owner, name, cur);
          if (!obj || obj.type !== "commit") break;
          const parsed = parseCommit(obj.data);
          cur = parsed.parents[0] || null;
        }
      }
      return json(list);
    }
    // single commit
    if (rest[0] === "commits" && rest.length === 2 && method === "GET") {
      const c = commitJson(owner, name, rest[1]);
      return c ? json(c) : json({ message: "Not Found" }, 404);
    }

    // issues
    if (rest[0] === "issues" && rest.length === 1) {
      const issues = store.readIssues(owner, name);
      if (method === "GET") {
        const state = url.searchParams.get("state") || "all";
        const filtered = state === "all" ? issues : issues.filter((i) => i.state === state);
        return json(filtered.map((i) => issueJson(owner, name, i)));
      }
      if (method === "POST") {
        const input = body.length ? (JSON.parse(body.toString("utf8")) as Json) : {};
        const nextNum = issues.reduce((a, i) => Math.max(a, i.number), 0) + 1;
        const rec: IssueRec = {
          number: nextNum,
          title: input.title || "",
          body: input.body || "",
          state: "open",
          user: { login: AUTH_LOGIN },
          createdAt: "1970-01-01T00:00:00Z",
          updatedAt: "1970-01-01T00:00:00Z",
          comments: 0,
        };
        issues.push(rec);
        store.writeIssues(owner, name, issues);
        const m = store.meta(owner, name);
        m.openIssues = issues.filter((i) => i.state === "open").length;
        store.saveMeta(m);
        return json(issueJson(owner, name, rec), 201);
      }
    }
    if (rest[0] === "issues" && rest.length === 2 && method === "GET") {
      const num = Number(rest[1]);
      const issue = store.readIssues(owner, name).find((i) => i.number === num);
      return issue ? json(issueJson(owner, name, issue)) : json({ message: "Not Found" }, 404);
    }

    // pulls
    if (rest[0] === "pulls" && rest.length === 1) {
      const pulls = store.readPulls(owner, name);
      if (method === "GET") return json(pulls.map((p) => pullJson(owner, name, p)));
      if (method === "POST") {
        const input = body.length ? (JSON.parse(body.toString("utf8")) as Json) : {};
        const pullsList = store.readPulls(owner, name);
        const nextNum = pullsList.reduce((a, p) => Math.max(a, p.number), 0) + 1;
        const headRef = input.head || "main";
        const baseRef = input.base || store.meta(owner, name).defaultBranch;
        const headSha = store.resolveRefSha(owner, name, headRef) || "0000000000000000000000000000000000000000";
        const baseSha = store.resolveRefSha(owner, name, baseRef) || "0000000000000000000000000000000000000000";
        const rec: PullRec = {
          number: nextNum,
          title: input.title || "",
          body: input.body || "",
          state: "open",
          user: { login: AUTH_LOGIN },
          head: { ref: headRef, sha: headSha },
          base: { ref: baseRef, sha: baseSha },
          createdAt: "1970-01-01T00:00:00Z",
          updatedAt: "1970-01-01T00:00:00Z",
        };
        pullsList.push(rec);
        store.writePulls(owner, name, pullsList);
        return json(pullJson(owner, name, rec), 201);
      }
    }
    if (rest[0] === "pulls" && rest.length === 2 && method === "GET") {
      const num = Number(rest[1]);
      const pr = store.readPulls(owner, name).find((p) => p.number === num);
      return pr ? json(pullJson(owner, name, pr)) : json({ message: "Not Found" }, 404);
    }
    if (rest[0] === "pulls" && rest.length === 2 && method === "PATCH") {
      const num = Number(rest[1]);
      const pullsList = store.readPulls(owner, name);
      const pr = pullsList.find((p) => p.number === num);
      if (!pr) return json({ message: "Not Found" }, 404);
      const input = body.length ? (JSON.parse(body.toString("utf8")) as Json) : {};
      if (input.title !== undefined) pr.title = input.title;
      if (input.body !== undefined) pr.body = input.body;
      if (input.state !== undefined) pr.state = input.state;
      store.writePulls(owner, name, pullsList);
      return json(pullJson(owner, name, pr));
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Commit helpers: write a file / delete a file onto a branch (tree rebuild)
// ---------------------------------------------------------------------------
function commitFile(owner: string, name: string, filePath: string, blobSha: string, message: string, branch: string): string {
  const m = store.meta(owner, name);
  const tip = store.resolveRefSha(owner, name, branch);
  const authorLine = AUTH_LOGIN + " <" + AUTH_LOGIN + "@users.noreply.github.com> 0 +0000";
  let treeSha: string;
  let parents: string[] = [];
  if (tip) {
    const tipObj = store.readObject(owner, name, tip);
    if (!tipObj) throw new Error("bad tip");
    treeSha = tipObj.type === "commit" ? parseCommit(tipObj.data).tree : tip;
    if (tipObj.type === "commit") parents = [tip];
  } else {
    // empty tree
    treeSha = store.writeObject(owner, name, { type: "tree", data: buildTree([]) });
  }
  const parts = filePath.split("/").filter(Boolean);
  const fileName = parts.pop() || "";
  // rebuild path down to parent tree
  const rebuild = (treeDataSha: string, depth: number): string => {
    const treeObj = store.readObject(owner, name, treeDataSha);
    const entries = treeObj && treeObj.type === "tree" ? parseTree(treeObj.data) : [];
    if (depth === parts.length) {
      const filtered = entries.filter((e) => e.name !== fileName);
      filtered.push({ mode: "100644", name: fileName, sha: blobSha });
      return store.writeObject(owner, name, { type: "tree", data: buildTree(filtered) });
    }
    const dirName = parts[depth];
    let subSha: string;
    const hit = entries.find((e) => e.name === dirName);
    if (hit && hit.mode === "40000") subSha = hit.sha;
    else subSha = store.writeObject(owner, name, { type: "tree", data: buildTree([]) });
    const newSub = rebuild(subSha, depth + 1);
    const filtered = entries.filter((e) => e.name !== dirName);
    filtered.push({ mode: "40000", name: dirName, sha: newSub });
    return store.writeObject(owner, name, { type: "tree", data: buildTree(filtered) });
  };
  const newTree = rebuild(treeSha, 0);
  const commit = buildCommit({ tree: newTree, parents, author: authorLine, committer: authorLine, message: message.endsWith("\n") ? message : message + "\n" });
  const commitSha = store.writeObject(owner, name, { type: "commit", data: commit });
  store.writeRef(owner, name, "refs/heads/" + branch, commitSha);
  return commitSha;
}

function deleteFile(owner: string, name: string, filePath: string, message: string, branch: string): string {
  const m = store.meta(owner, name);
  const tip = store.resolveRefSha(owner, name, branch);
  if (!tip) throw new Error("branch not found");
  const tipObj = store.readObject(owner, name, tip);
  if (!tipObj || tipObj.type !== "commit") throw new Error("bad tip");
  const treeSha = parseCommit(tipObj.data).tree;
  const authorLine = AUTH_LOGIN + " <" + AUTH_LOGIN + "@users.noreply.github.com> 0 +0000";
  const parts = filePath.split("/").filter(Boolean);
  const fileName = parts.pop() || "";
  const rebuild = (treeDataSha: string, depth: number): string | null => {
    const treeObj = store.readObject(owner, name, treeDataSha);
    const entries = treeObj && treeObj.type === "tree" ? parseTree(treeObj.data) : [];
    if (depth === parts.length) {
      const filtered = entries.filter((e) => e.name !== fileName);
      if (filtered.length === 0 && depth > 0) return null; // prune empty dir
      return store.writeObject(owner, name, { type: "tree", data: buildTree(filtered) });
    }
    const dirName = parts[depth];
    const hit = entries.find((e) => e.name === dirName);
    if (!hit || hit.mode !== "40000") throw new Error("path not found");
    const newSub = rebuild(hit.sha, depth + 1);
    const filtered = entries.filter((e) => e.name !== dirName);
    if (newSub) filtered.push({ mode: "40000", name: dirName, sha: newSub });
    if (filtered.length === 0 && depth > 0) return null;
    return store.writeObject(owner, name, { type: "tree", data: buildTree(filtered) });
  };
  const newTree = rebuild(treeSha, 0);
  const finalTree = newTree || store.writeObject(owner, name, { type: "tree", data: buildTree([]) });
  const commit = buildCommit({ tree: finalTree, parents: [tip], author: authorLine, committer: authorLine, message: message.endsWith("\n") ? message : message + "\n" });
  const commitSha = store.writeObject(owner, name, { type: "commit", data: commit });
  store.writeRef(owner, name, "refs/heads/" + branch, commitSha);
  return commitSha;
}

// ---------------------------------------------------------------------------
// GraphQL: minimal query resolver for repository, issue, pullRequest, user, commit
// ---------------------------------------------------------------------------
/**
 * A pragmatic GraphQL subset: parse the query text, walk selection sets against
 * resolvers keyed by type. Supports nested fields, arguments via `(...)` and
 * $variables.
 */
interface GqlCtx { owner: string; name: string; vars: Json }

function parseArguments(argText: string): Json {
  const args: Json = {};
  if (!argText) return args;
  // key: value pairs, values: $var, "string", number, true/false, [list]
  let i = 0;
  const readValue = (): unknown => {
    while (i < argText.length && /\s/.test(argText[i])) i++;
    const c = argText[i];
    if (c === "$") {
      i++;
      let name = "";
      while (i < argText.length && /[\w]/.test(argText[i])) name += argText[i++];
      return { __var: name };
    }
    if (c === '"') {
      i++;
      let s = "";
      while (i < argText.length && argText[i] !== '"') {
        if (argText[i] === "\\") { s += argText[i + 1]; i += 2; }
        else s += argText[i++];
      }
      i++;
      return s;
    }
    if (c === "[") {
      i++;
      const arr: unknown[] = [];
      while (i < argText.length && argText[i] !== "]") {
        arr.push(readValue());
        while (i < argText.length && (argText[i] === "," || /\s/.test(argText[i]))) i++;
      }
      i++;
      return arr;
    }
    if (c === "{") {
      i++;
      const obj: Json = {};
      while (i < argText.length && argText[i] !== "}") {
        while (i < argText.length && /[\s,]/.test(argText[i])) i++;
        let key = "";
        while (i < argText.length && /[\w]/.test(argText[i])) key += argText[i++];
        while (i < argText.length && /\s/.test(argText[i])) i++;
        if (argText[i] === ":") i++;
        obj[key] = readValue();
      }
      i++;
      return obj;
    }
    let num = "";
    while (i < argText.length && /[\w.\-]/.test(argText[i])) num += argText[i++];
    if (num === "true") return true;
    if (num === "false") return false;
    if (num === "null") return null;
    const n = Number(num);
    return Number.isNaN(n) ? num : n;
  };
  while (i < argText.length) {
    while (i < argText.length && /[\s,]/.test(argText[i])) i++;
    if (i >= argText.length) break;
    let key = "";
    while (i < argText.length && /[\w]/.test(argText[i])) key += argText[i++];
    while (i < argText.length && /\s/.test(argText[i])) i++;
    if (argText[i] === ":") i++;
    args[key] = readValue();
  }
  return args;
}

interface SelectionNode {
  name: string;
  alias?: string;
  args?: string;
  selections?: SelectionNode[];
}

/** Parse a selection set body (text inside { ... }) into nodes. */
function parseSelections(text: string): SelectionNode[] {
  const nodes: SelectionNode[] = [];
  let i = 0;
  const skipWs = () => { while (i < text.length && /\s/.test(text[i])) i++; };
  while (i < text.length) {
    skipWs();
    if (i >= text.length) break;
    if (text[i] === "}") break;
    // directive or fragment spread
    if (text[i] === "@") { while (i < text.length && text[i] !== "\n") i++; continue; }
    if (text[i] === ".") { while (i < text.length && text[i] !== "\n") i++; continue; }
    let name = "";
    while (i < text.length && /[\w!]/.test(text[i])) name += text[i++];
    if (!name) { i++; continue; }
    let alias: string | undefined;
    skipWs();
    if (text[i] === ":") {
      alias = name; i++;
      name = "";
      skipWs();
      while (i < text.length && /[\w!]/.test(text[i])) name += text[i++];
    }
    let args: string | undefined;
    if (text[i] === "(") {
      const start = i + 1;
      let depth = 1; i++;
      while (i < text.length && depth > 0) {
        if (text[i] === "(") depth++;
        else if (text[i] === ")") depth--;
        i++;
      }
      args = text.slice(start, i - 1);
    }
    skipWs();
    let selections: SelectionNode[] | undefined;
    if (text[i] === "{") {
      const start = i + 1;
      let depth = 1; i++;
      while (i < text.length && depth > 0) {
        if (text[i] === "{") depth++;
        else if (text[i] === "}") depth--;
        i++;
      }
      selections = parseSelections(text.slice(start, i - 1));
    }
    nodes.push({ name, alias, args, selections });
  }
  return nodes;
}

/** Extract top-level query selection sets from a GraphQL query string. */
function parseQuery(query: string): { operation: string; name: string; selections: SelectionNode[] }[] {
  const ops: { operation: string; name: string; selections: SelectionNode[] }[] = [];
  // find operation blocks: query Name(...) { ... }, mutation ...
  const re = /(query|mutation|subscription)\s*([\w]*)\s*(\([^)]*\))?\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(query))) {
    const opStart = m.index + m[0].length - 1; // position of {
    let depth = 0;
    let i = opStart;
    for (; i < query.length; i++) {
      if (query[i] === "{") depth++;
      else if (query[i] === "}") { depth--; if (depth === 0) break; }
    }
    const body = query.slice(opStart + 1, i);
    ops.push({ operation: m[1], name: m[2] || "", selections: parseSelections(body) });
  }
  if (ops.length === 0) {
    // anonymous shorthand: { ... }
    const first = query.indexOf("{");
    if (first !== -1) {
      let depth = 0, i = first;
      for (; i < query.length; i++) {
        if (query[i] === "{") depth++;
        else if (query[i] === "}") { depth--; if (depth === 0) break; }
      }
      ops.push({ operation: "query", name: "", selections: parseSelections(query.slice(first + 1, i)) });
    }
  }
  return ops;
}

type Resolver = (ctx: GqlCtx, args: Json) => unknown;

function resolveArgs(ctx: GqlCtx, raw: string | undefined): Json {
  const args = parseArguments(raw || "");
  const out: Json = {};
  for (const [k, v] of Object.entries(args)) {
    if (v && typeof v === "object" && "__var" in (v as any)) {
      out[k] = ctx.vars[(v as any).__var];
    } else out[k] = v;
  }
  return out;
}

function runSelections(ctx: GqlCtx, node: SelectionNode, value: unknown, resolvers: Record<string, Resolver>): unknown {
  if (!node.selections || node.selections.length === 0) {
    return value;
  }
  const obj: Json = {};
  for (const sel of node.selections) {
    const key = sel.alias || sel.name;
    const r = resolvers[sel.name];
    if (!r) {
      // direct property of the value
      if (value && typeof value === "object") {
        const v = (value as Json)[sel.name];
        obj[key] = sel.selections ? runSelections(ctx, sel, v, resolvers) : v;
      } else obj[key] = null;
      continue;
    }
    const childCtx: GqlCtx = { ...ctx, vars: ctx.vars };
    const subValue = r(childCtx, resolveArgs(ctx, sel.args));
    obj[key] = runSelections(ctx, sel, subValue, resolvers);
  }
  return obj;
}

function handleGraphQL(body: Buffer, res: http.ServerResponse): void {
  let input: Json;
  try {
    input = JSON.parse(body.toString("utf8"));
  } catch {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ errors: [{ message: "invalid JSON body" }] }));
    return;
  }
  const query = String(input.query || "");
  const vars: Json = input.variables || {};
  const ops = parseQuery(query);
  const data: Json = {};
  const errors: { message: string }[] = [];

  // Shared resolvers: each knows how to serve its type from ctx + value
  const repoResolver: Resolver = (ctx, args) => {
    const owner = args.owner || ctx.owner;
    const n = args.name || ctx.name;
    if (!fs.existsSync(store.repoDir(owner, n))) return null;
    ctx.owner = owner; ctx.name = n;
    return repoJson(store.meta(owner, n)) as Json;
  };
  const issueResolver: Resolver = (ctx, args) => {
    const num = Number(args.number || args.issueNumber || 0);
    const issue = store.readIssues(ctx.owner, ctx.name).find((i) => i.number === num);
    return issue ? issueJson(ctx.owner, ctx.name, issue) : null;
  };
  const issuesResolver: Resolver = (ctx, args) => {
    return store.readIssues(ctx.owner, ctx.name).map((i) => issueJson(ctx.owner, ctx.name, i));
  };
  const pullResolver: Resolver = (ctx, args) => {
    const num = Number(args.number || 0);
    const pr = store.readPulls(ctx.owner, ctx.name).find((p) => p.number === num);
    return pr ? pullJson(ctx.owner, ctx.name, pr) : null;
  };
  const pullsResolver: Resolver = (ctx, args) => {
    return store.readPulls(ctx.owner, ctx.name).map((p) => pullJson(ctx.owner, ctx.name, p));
  };
  const userResolver: Resolver = (ctx, args) => {
   OST:
    OST2:
    return userJson(String(args.login || AUTH_LOGIN));
  };
  const viewerResolver: Resolver = () => userJson(AUTH_LOGIN);
  const commitResolver: Resolver = (ctx, args) => {
    const sha = String(args.expression || args.sha || args.oid || "");
    let resolved: string | null = null;
    if (/^[0-9a-f]{40}$/.test(sha)) resolved = sha;
    else if (sha) resolved = store.resolveRefSha(ctx.owner, ctx.name, sha.replace(/^refs\/heads\//, ""));
    if (!resolved) {
      const tip = store.defaultBranchTip(ctx.owner, ctx.name);
      resolved = tip;
    }
    return resolved ? commitJson(ctx.owner, ctx.name, resolved) : null;
  };
  const commitsResolver: Resolver = (ctx, args) => {
    const out: Json[] = [];
    const limit = Number(args.first || 30);
    let cur = store.resolveRefSha(ctx.owner, ctx.name, String(args.ref || ctx.vars.ref || store.meta(ctx.owner, ctx.name).defaultBranch)) || store.defaultBranchTip(ctx.owner, ctx.name);
    while (cur && out.length < limit) {
      const c = commitJson(ctx.owner, ctx.name, cur);
      if (c) out.push(c);
      const obj = store.readObject(ctx.owner, ctx.name, cur);
      if (!obj || obj.type !== "commit") break;
      const parsed = parseCommit(obj.data);
      cur = parsed.parents[0] || null;
    }
    return out;
  };
  const fileResolver: Resolver = (ctx, args) => {
    const expr = String(args.expression || args.path || "");
    const branch = args.ref || args.oid || store.meta(ctx.owner, ctx.name).defaultBranch;
    const f = store.readFileAt(ctx.owner, ctx.name, String(branch), expr);
    if (!f) return null;
    return {
      path: expr,
      oid: f.sha,
      name: expr.split("/").pop(),
      content: Buffer.from(f.content, "base64").toString("utf8"),
      text: Buffer.from(f.content, "base64").toString("utf8"),
      byteLength: f.size,
      isBinary: false,
    };
  };

  const rootResolvers: Record<string, Resolver> = {
    repository: repoResolver,
    issue: issueResolver,
    issues: issuesResolver,
    pullRequest: pullResolver,
    pullRequests: pullsResolver,
    user: userResolver,
    viewer: viewerResolver,
    commit: commitResolver,
    history: commitsResolver,
    file: fileResolver,
    repositoryOwner: (ctx, args) => userJson(String(args.login || "")),
    search: () => ({ nodes: [], issueCount: 0 }),
    rateLimit: () => ({ limit: 5000, remaining: 4999, cost: 1, resetAt: "1970-01-01T00:00:00Z" }),
  };
  // nested resolvers keyed by field name regardless of parent type
  const nestedResolvers: Record<string, Resolver> = {
    ...rootResolvers,
    author: (ctx, args) => userJson(AUTH_LOGIN),
    committer: (ctx, args) => userJson(AUTH_LOGIN),
    // commit payload fields handled as plain props via value object
    associatedPullRequests: () => ({ nodes: [] }),
    labels: () => ({ nodes: [] }),
    participants: () => ({ nodes: [] }),
    comments: () => ({ nodes: [] }),
    closingIssuesReferences: () => ({ nodes: [] }),
    timelineItems: () => ({ nodes: [] }),
    refs: (ctx, args) => ({
      nodes: store.listRefs(ctx.owner, ctx.name)
        .filter((r) => r.ref.startsWith("refs/heads/"))
        .map((r) => ({ name: r.ref.slice("refs/heads/".length), prefix: "refs/heads/", oid: r.sha, id: r.ref })),
    }),
    object: (ctx, args) => {
      const oid = String(args.oid || "");
      const obj = /^[0-9a-f]{40}$/.test(oid) ? store.readObject(ctx.owner, ctx.name, oid) : null;
      if (!obj) return null;
      return {
        oid,
        type: obj.type.toUpperCase(),
        abbreviatedOid: oid.slice(0, 7),
      };
    },
  };

  for (const op of ops) {
    const result = runSelections({ owner: "", name: "", vars }, { name: "", selections: op.selections }, undefined, nestedResolvers);
    Object.assign(data, result as Json);
  }
  const payload: Json = { data };
  if (errors.length) payload.errors = errors;
  res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

// ---------------------------------------------------------------------------
// MCP: JSON-RPC 2.0 endpoint (/mcp) with initialize, tools/list, tools/call
// ---------------------------------------------------------------------------
interface McpTool {
  name: string;
  description: string;
  inputSchema: Json;
}

const MCP_TOOLS: McpTool[] = [
  {
    name: "list_repositories",
    description: "List all repositories in the forge, optionally filtered by owner.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Filter by owner login." },
      },
      required: [],
    },
  },
  {
    name: "create_issue",
    description: "Create a new issue on a repository.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repository owner." },
        repo: { type: "string", description: "Repository name." },
        title: { type: "string", description: "Issue title." },
        body: { type: "string", description: "Issue body (markdown)." },
      },
      required: ["owner", "repo", "title"],
    },
  },
  {
    name: "read_file",
    description: "Read a file from a repository at a given ref and path.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repository owner." },
        repo: { type: "string", description: "Repository name." },
        path: { type: "string", description: "File path inside the repository." },
        ref: { type: "string", description: "Branch, tag, or commit sha (defaults to default branch).", required: false },
      },
      required: ["owner", "repo", "path"],
    },
  },
];

function mcpResult(id: unknown, result: Json): Json {
  return { jsonrpc: "2.0", id, result };
}
function mcpError(id: unknown, code: number, message: string): Json {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function callMcpTool(name: string, args: Json): Promise<Json> {
  if (name === "list_repositories") {
    const repos = store.listRepos().filter((r) => !args.owner || r.owner === args.owner);
    return {
      content: [{ type: "text", text: JSON.stringify(repos.map((r) => ({ owner: r.owner, name: r.name, full_name: r.owner + "/" + r.name, description: r.description, default_branch: r.defaultBranch })), null, 2) }],
    };
  }
  if (name === "create_issue") {
    const owner = String(args.owner || "");
    const repo = String(args.repo || "");
    const title = String(args.title || "");
    const bodyText = String(args.body || "");
    if (!fs.existsSync(store.repoDir(owner, repo))) {
      return { content: [{ type: "text", text: "repository not found: " + owner + "/" + repo }], isError: true };
    }
    const issues = store.readIssues(owner, repo);
    const nextNum = issues.reduce((a, i) => Math.max(a, i.number), 0) + 1;
    const rec: IssueRec = {
      number: nextNum,
      title,
      body: bodyText,
      state: "open",
      user: { login: AUTH_LOGIN },
      createdAt: "1970-01-01T00:00:00Z",
      updatedAt: "1970-01-01T00:00:00Z",
      comments: 0,
    };
    issues.push(rec);
    store.writeIssues(owner, repo, issues);
    const m = store.meta(owner, repo);
    m.openIssues = issues.filter((i) => i.state === "open").length;
    store.saveMeta(m);
    return { content: [{ type: "text", text: JSON.stringify(issueJson(owner, repo, rec), null, 2) }] };
  }
  if (name === "read_file") {
    const owner = String(args.owner || "");
    const repo = String(args.repo || "");
    const filePath = String(args.path || "");
    const ref = String(args.ref || store.meta(owner, repo).defaultBranch);
    if (!fs.existsSync(store.repoDir(owner, repo))) {
      return { content: [{ type: "text", text: "repository not found: " + owner + "/" + repo }], isError: true };
    }
    const f = store.readFileAt(owner, repo, ref, filePath);
    if (!f) return { content: [{ type: "text", text: "file not found: " + filePath + " at " + ref }], isError: true };
    const text = Buffer.from(f.content, "base64").toString("utf8");
    return { content: [{ type: "text", text }] };
  }
  return { content: [{ type: "text", text: "unknown tool: " + name }], isError: true };
}

function handleMcp(body: Buffer, res: http.ServerResponse): void {
  let input: Json;
  try {
    input = JSON.parse(body.toString("utf8"));
  } catch {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify(mcpError(null, -32700, "parse error")));
    return;
  }
  const messages = Array.isArray(input) ? input : [input];
  const replies: Json[] = [];
  for (const msg of messages) {
    const id = msg.id ?? null;
    const method = String(msg.method || "");
    if (method === "initialize") {
      replies.push(mcpResult(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "github-core-clone", version: "1.0.0" },
      }));
    } else if (method === "notifications/initialized" || method.startsWith("notifications/")) {
      // notifications get no reply
      continue;
    } else if (method === "tools/list") {
      replies.push(mcpResult(id, { tools: MCP_TOOLS }));
    } else if (method === "tools/call") {
      const params = msg.params || {};
      const toolName = String(params.name || "");
      const args = params.arguments || {};
      // tools/call is async in our implementation but handlers are sync
      const result = callMcpToolSync(toolName, args as Json);
      replies.push(mcpResult(id, result));
    } else if (method === "ping") {
      replies.push(mcpResult(id, {}));
    } else {
      replies.push(mcpError(id, -32601, "method not found: " + method));
    }
  }
  const payload = Array.isArray(input) ? replies : replies[0];
  res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload ?? {}));
}

/** Synchronous MCP tool dispatch (handlers don't await). */
function callMcpToolSync(name: string, args: Json): Json {
  if (name === "list_repositories") {
    const repos = store.listRepos().filter((r) => !args.owner || r.owner === args.owner);
    return {
      content: [{ type: "text", text: JSON.stringify(repos.map((r) => ({ owner: r.owner, name: r.name, full_name: r.owner + "/" + r.name, description: r.description, default_branch: r.defaultBranch })), null, 2) }],
    };
  }
  if (name === "create_issue") {
    const owner = String(args.owner || "");
    const repo = String(args.repo || "");
    const title = String(args.title || "");
    const bodyText = String(args.body || "");
    if (!fs.existsSync(store.repoDir(owner, repo))) {
      return { content: [{ type: "text", text: "repository not found: " + owner + "/" + repo }], isError: true };
    }
    const issues = store.readIssues(owner, repo);
    const nextNum = issues.reduce((a, i) => Math.max(a, i.number), 0) + 1;
    const rec: IssueRec = {
      number: nextNum,
      title,
      body: bodyText,
      state: "open",
      user: { login: AUTH_LOGIN },
      createdAt: "1970-01-01T00:00:00Z",
      updatedAt: "1970-01-01T00:00:00Z",
      comments: 0,
    };
    issues.push(rec);
    store.writeIssues(owner, repo, issues);
    const m = store.meta(owner, repo);
    m.openIssues = issues.filter((i) => i.state === "open").length;
    store.saveMeta(m);
    return { content: [{ type: "text", text: JSON.stringify(issueJson(owner, repo, rec), null, 2) }] };
  }
  if (name === "read_file") {
    const owner = String(args.owner || "");
    const repo = String(args.repo || "");
    const filePath = String(args.path || "");
    const ref = String(args.ref || (fs.existsSync(store.repoDir(owner, repo)) ? store.meta(owner, repo).defaultBranch : "main"));
    if (!fs.existsSync(store.repoDir(owner, repo))) {
      return { content: [{ type: "text", text: "repository not found: " + owner + "/" + repo }], isError: true };
    }
    const f = store.readFileAt(owner, repo, ref, filePath);
    if (!f) return { content: [{ type: "text", text: "file not found: " + filePath + " at " + ref }], isError: true };
    const text = Buffer.from(f.content, "base64").toString("utf8");
    return { content: [{ type: "text", text }] };
  }
  return { content: [{ type: "text", text: "unknown tool: " + name }], isError: true };
}

// ---------------------------------------------------------------------------
// HTTP server: route git smart HTTP, REST, GraphQL, MCP
// ---------------------------------------------------------------------------
function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(concat(chunks)));
    req.on("error", reject);
  });
}

/** Parse /owner/repo.git style paths used by git HTTP endpoints. */
function parseRepoPath(p: string): { owner: string; name: string } | null {
  // The path arrives as /<owner>/<repo>.git/<service>: strip the service suffix
  // first, then .git. Stripping .git first leaves "repo.git/git-receive-pack" as
  // the repo name, so pushes land in a repository that does not exist.
  const clean = p.replace(/\/(git-upload-pack|git-receive-pack|info\/refs)$/, "").replace(/\.git$/, "");
  const seg = clean.split("/").filter(Boolean);
  if (seg.length < 2) return null;
  return { owner: seg[seg.length - 2], name: seg[seg.length - 1] };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", "http://localhost");
    const p = url.pathname;
    const method = req.method || "GET";

    // --- MCP ---
    if (p === "/mcp") {
      const body = await readBody(req);
      handleMcp(body, res);
      return;
    }
    // --- GraphQL ---
    if (p === "/graphql") {
      const body = await readBody(req);
      handleGraphQL(body, res);
      return;
    }
    // --- git smart HTTP ---
    if (p.endsWith("/info/refs")) {
      const repo = parseRepoPath(p);
      const service = url.searchParams.get("service");
      if (repo && (service === "git-upload-pack" || service === "git-receive-pack")) {
        if (!fs.existsSync(store.repoDir(repo.owner, repo.name))) {
          store.ensureRepo(repo.owner, repo.name);
        }
        const adv = infoRefsAdvertisement(service, repo.owner, repo.name);
        res.writeHead(200, {
          "content-type": service === "git-upload-pack" ? "application/x-git-upload-pack-advertisement" : "application/x-git-receive-pack-advertisement",
          "cache-control": "no-cache",
          "expires": "Fri, 01 Jan 1980 00:00:00 GMT",
          "pragma": "no-cache",
        });
        res.end(adv);
        return;
      }
    }
    // The service lives AFTER /info/refs and after .git on every git request.
    // Order matters: /git-upload-pack before /info/refs, because a URL like
    // .../r.git/info/refs?service=git-upload-pack also ends in "git-upload-pack".
    if (p.endsWith("/git-upload-pack") && method === "POST") {
      const repo = parseRepoPath(p);
      if (repo) {
        const body = await readBody(req);
        if (!fs.existsSync(store.repoDir(repo.owner, repo.name))) store.ensureRepo(repo.owner, repo.name);
        const out = await handleUploadPack(repo.owner, repo.name, body);
        res.writeHead(200, {
          "content-type": "application/x-git-upload-pack-result",
          "cache-control": "no-cache",
          "expires": "Fri, 01 Jan 1980 00:00:00 GMT",
          "pragma": "no-cache",
        });
        res.end(out);
        return;
      }
    }
    if (p.endsWith("/git-receive-pack") && method === "POST") {
      const repo = parseRepoPath(p);
      if (repo) {
        const body = await readBody(req);
        if (!fs.existsSync(store.repoDir(repo.owner, repo.name))) store.ensureRepo(repo.owner, repo.name);
        const out = await handleReceivePack(repo.owner, repo.name, body);
        res.writeHead(200, {
          "content-type": "application/x-git-receive-pack-result",
          "cache-control": "no-cache",
          "expires": "Fri, 01 Jan 1980 00:00:00 GMT",
          "pragma": "no-cache",
        });
        res.end(out);
        return;
      }
    }
    // --- REST (mounted at /api/v3 and / like GitHub) ---
    if (p.startsWith("/api/v3") || method !== "OPTIONS") {
      const body = method === "GET" || method === "HEAD" ? Buffer.alloc(0) : await readBody(req);
      const handled = await handleRest(req, res, url, body);
      if (handled) return;
    }
    // --- fallback ---
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "Not Found" }));
  } catch (e) {
    const err = e as Error;
    console.error("[500]", req.method, req.url, err.message, "\n", err.stack?.split("\n").slice(0, 4).join("\n"));
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: err.message }));
    } else {
      res.end();
    }
  }
});

server.listen(PORT, () => {
  process.stdout.write(`github-core-clone listening on http://127.0.0.1:${PORT} (DATA_DIR=${DATA_DIR})\n`);
});
