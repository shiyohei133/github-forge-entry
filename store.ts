// In-memory store for the forge: git objects, repositories, issues, pull requests.
// One process, no persistence: the suite builds everything it needs inside one run.

import { createHash } from 'node:crypto';

export const VIEWER = { id: 1000, login: 'adaiversen', name: 'ada iversen', email: 'adaiversen@example.invalid' };

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export interface TreeEntry {
  mode: string; // "100644", "100755", "120000", "40000"
  name: string;
  sha: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    const mode = data.toString('utf8', i, sp);
    const nul = data.indexOf(0x00, sp + 1);
    const name = data.toString('utf8', sp + 1, nul);
    const sha = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, sha });
    i = nul + 21;
  }
  return entries;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? a.name + '/' : a.name;
    const bn = b.mode === '40000' ? b.name + '/' : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(info: CommitInfo): Buffer {
  let head = `tree ${info.tree}\n`;
  for (const p of info.parents) head += `parent ${p}\n`;
  head += `author ${info.author}\ncommitter ${info.committer}\n\n`;
  return Buffer.from(head + info.message, 'utf8');
}

/** Parse "Name <email> ts tz" into a Date-ish ISO string for API responses. */
export function identToIso(ident: string): string {
  const m = / (\d{9,}) [+-]\d{4}$/.exec(ident);
  if (!m) return new Date(0).toISOString();
  return new Date(Number(m[1]) * 1000).toISOString();
}

export function identName(ident: string): string {
  const lt = ident.indexOf(' <');
  return lt === -1 ? ident : ident.slice(0, lt);
}

export function makeIdent(name: string, email: string, whenSec: number): string {
  return `${name} <${email}> ${whenSec} +0000`;
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

export interface IssueRec {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: string[]; // label names
  isPull: boolean;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  comments: { id: number; body: string; createdAt: string; updatedAt: string }[];
  // pull-only fields
  headRef?: string;
  baseRef?: string;
  headSha?: string;
  merged?: boolean;
  mergedAt?: string | null;
  mergeCommitSha?: string | null;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string | null;
  isPrivate: boolean;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>; // refs/heads/main -> sha ; refs/tags/x -> sha
  issues: Map<number, IssueRec>;
  nextIssueNumber: number;
  labels: Map<string, Label>;
  nextLabelId: number;
  createdAt: string;
  updatedAt: string;
  /** Monotonic counter for synthetic timestamps so ordering is stable. */
  tick: number;
}

export class Store {
  repos = new Map<string, Repo>(); // "owner/name" -> Repo
  nextRepoId = 5000;
  nextIssueId = 20000;
  nextCommentId = 90000;
  private clock = 1763400000; // fixed base epoch; only ever increments (no wall clock dependence for content)

  nowIso(): string {
    this.clock += 1;
    return new Date(this.clock * 1000).toISOString();
  }
  nowSec(): number {
    this.clock += 1;
    return this.clock;
  }

  createRepo(name: string, description: string | null, isPrivate: boolean): Repo {
    const ts = this.nowIso();
    const repo: Repo = {
      id: this.nextRepoId++,
      name,
      owner: VIEWER.login,
      description,
      isPrivate,
      defaultBranch: 'main',
      objects: new Map(),
      refs: new Map(),
      issues: new Map(),
      nextIssueNumber: 1,
      labels: new Map(),
      nextLabelId: 1,
      createdAt: ts,
      updatedAt: ts,
      tick: 0,
    };
    this.repos.set(`${VIEWER.login}/${name}`, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    if (owner !== VIEWER.login) return undefined;
    return this.repos.get(`${owner}/${name}`);
  }

  deleteRepo(owner: string, name: string): boolean {
    if (owner !== VIEWER.login) return false;
    return this.repos.delete(`${owner}/${name}`);
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.id - b.id);
  }

  // ---- git object helpers on a repo ----
  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const sha = hashObject(type, data);
    if (!repo.objects.has(sha)) repo.objects.set(sha, { type, data });
    return sha;
  }

  getObject(repo: Repo, sha: string): GitObject | undefined {
    return repo.objects.get(sha);
  }

  /** Tree (recursive map path-> {mode, sha}) at a commit/tree sha. Returns flat map. */
  flattenTree(repo: Repo, treeSha: string, prefix = '', out = new Map<string, { mode: string; sha: string }>()): Map<string, { mode: string; sha: string }> {
    const obj = repo.objects.get(treeSha);
    if (!obj || obj.type !== 'tree') return out;
    for (const e of parseTree(obj.data)) {
      const path = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.mode === '40000') this.flattenTree(repo, e.sha, path, out);
      else out.set(path, { mode: e.mode, sha: e.sha });
    }
    return out;
  }

  /** Build nested trees from a flat path map; returns the root tree sha. */
  buildTreeFromFlat(repo: Repo, flat: Map<string, { mode: string; sha: string }>): string {
    interface Node { files: Map<string, { mode: string; sha: string }>; dirs: Map<string, Node> }
    const root: Node = { files: new Map(), dirs: new Map() };
    for (const [path, v] of flat) {
      const parts = path.split('/');
      let node = root;
      for (let i = 0; i < parts.length - 1; i++) {
        let next = node.dirs.get(parts[i]);
        if (!next) { next = { files: new Map(), dirs: new Map() }; node.dirs.set(parts[i], next); }
        node = next;
      }
      node.files.set(parts[parts.length - 1], v);
    }
    const write = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, v] of node.files) entries.push({ mode: v.mode, name, sha: v.sha });
      for (const [name, sub] of node.dirs) entries.push({ mode: '40000', name, sha: write(sub) });
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return write(root);
  }

  private commitInfoCache = new Map<string, CommitInfo>();

  /** Parsed commit for a sha, memoized (commit bytes are immutable). */
  commitInfo(repo: Repo, sha: string): CommitInfo | null {
    const hit = this.commitInfoCache.get(sha);
    if (hit) return hit;
    const obj = repo.objects.get(sha);
    if (!obj || obj.type !== 'commit') return null;
    const info = parseCommit(obj.data);
    if (this.commitInfoCache.size > 20000) this.commitInfoCache.clear();
    this.commitInfoCache.set(sha, info);
    return info;
  }

  /** Ancestor set of a commit (including itself), following first+all parents. */
  ancestors(repo: Repo, start: string): Set<string> {
    const seen = new Set<string>();
    const stack = [start];
    while (stack.length) {
      const sha = stack.pop()!;
      if (seen.has(sha)) continue;
      seen.add(sha);
      const info = this.commitInfo(repo, sha);
      if (info) stack.push(...info.parents);
    }
    return seen;
  }

  isAncestor(repo: Repo, maybeAncestor: string, of: string): boolean {
    return this.ancestors(repo, of).has(maybeAncestor);
  }

  /** First common ancestor (BFS from both) — good enough for the suite's histories. */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const ancA = this.ancestors(repo, a);
    const seen = new Set<string>();
    const queue = [b];
    while (queue.length) {
      const sha = queue.shift()!;
      if (seen.has(sha)) continue;
      seen.add(sha);
      if (ancA.has(sha)) return sha;
      const info = this.commitInfo(repo, sha);
      if (info) queue.push(...info.parents);
    }
    return null;
  }
}

export const store = new Store();
