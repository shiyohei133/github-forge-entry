// Domain logic shared by REST, GraphQL and MCP: issues, pull requests, merges, JSON shapes.

import {
  store, VIEWER, type Repo, type IssueRec, type Label,
  parseCommit, buildCommit, parseTree, identToIso, identName, makeIdent,
} from './store.ts';

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function userJson(): Record<string, unknown> {
  return { login: VIEWER.login, id: VIEWER.id, type: 'User', site_admin: false, name: VIEWER.name, email: VIEWER.email };
}

export function nodeId(kind: string, id: number): string {
  return Buffer.from(`${kind}:${id}`, 'utf8').toString('base64');
}

export function repoJson(repo: Repo): Record<string, unknown> {
  const fullName = `${repo.owner}/${repo.name}`;
  return {
    id: repo.id,
    node_id: nodeId('Repository', repo.id),
    name: repo.name,
    full_name: fullName,
    private: repo.isPrivate,
    owner: userJson(),
    html_url: `https://github.com/${fullName}`,
    description: repo.description,
    fork: false,
    url: `https://api.github.com/repos/${fullName}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    forks_count: 0,
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length,
    default_branch: repo.defaultBranch,
    visibility: repo.isPrivate ? 'private' : 'public',
    topics: [],
    archived: false,
    disabled: false,
  };
}

export function labelJson(label: Label): Record<string, unknown> {
  return {
    id: label.id,
    node_id: nodeId('Label', label.id),
    name: label.name,
    color: label.color,
    description: label.description,
    default: false,
  };
}

export function issueJson(repo: Repo, rec: IssueRec): Record<string, unknown> {
  const fullName = `${repo.owner}/${repo.name}`;
  const out: Record<string, unknown> = {
    id: rec.id,
    node_id: nodeId(rec.isPull ? 'PullRequest' : 'Issue', rec.id),
    number: rec.number,
    title: rec.title,
    user: userJson(),
    labels: rec.labels.map((name) => {
      const label = repo.labels.get(name);
      return label ? labelJson(label) : { id: 0, name, color: 'ededed', description: null, default: false };
    }),
    state: rec.state,
    locked: false,
    assignee: null,
    assignees: [],
    milestone: null,
    comments: rec.comments.length,
    created_at: rec.createdAt,
    updated_at: rec.updatedAt,
    closed_at: rec.closedAt,
    body: rec.body,
    url: `https://api.github.com/repos/${fullName}/issues/${rec.number}`,
    repository_url: `https://api.github.com/repos/${fullName}`,
    html_url: `https://github.com/${fullName}/issues/${rec.number}`,
  };
  if (rec.isPull) {
    out.html_url = `https://github.com/${fullName}/pull/${rec.number}`;
    out.pull_request = {
      url: `https://api.github.com/repos/${fullName}/pulls/${rec.number}`,
      html_url: `https://github.com/${fullName}/pull/${rec.number}`,
      diff_url: `https://github.com/${fullName}/pull/${rec.number}.diff`,
      patch_url: `https://github.com/${fullName}/pull/${rec.number}.patch`,
      merged_at: rec.mergedAt ?? null,
    };
  }
  return out;
}

/** Three-way tree merge. Returns merged flat map, or null on conflict. */
export function mergeTrees(
  repo: Repo,
  baseTreeSha: string,
  oursTreeSha: string,
  theirsTreeSha: string,
): Map<string, { mode: string; sha: string }> | null {
  const base = store.flattenTree(repo, baseTreeSha);
  const ours = store.flattenTree(repo, oursTreeSha);
  const theirs = store.flattenTree(repo, theirsTreeSha);
  const result = new Map(ours);
  const paths = new Set([...base.keys(), ...theirs.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    const sameOT = o?.sha === t?.sha && o?.mode === t?.mode;
    if (sameOT) continue;
    const oursChanged = o?.sha !== b?.sha || o?.mode !== b?.mode;
    const theirsChanged = t?.sha !== b?.sha || t?.mode !== b?.mode;
    if (theirsChanged && !oursChanged) {
      if (t) result.set(path, t);
      else result.delete(path);
    } else if (oursChanged && theirsChanged) {
      return null; // both changed the same path differently
    }
  }
  return result;
}

export function commitTreeSha(repo: Repo, commitSha: string): string {
  const obj = repo.objects.get(commitSha);
  if (!obj || obj.type !== 'commit') throw new HttpError(422, `unknown commit ${commitSha}`);
  return parseCommit(obj.data).tree;
}

export interface FileChange {
  filename: string;
  status: 'added' | 'modified' | 'removed' | 'renamed';
  sha: string | null;
  additions: number;
  deletions: number;
  changes: number;
}

function lineDiffCounts(oldText: string, newText: string): { additions: number; deletions: number } {
  if (oldText === newText) return { additions: 0, deletions: 0 };
  const a = oldText.split('\n');
  const b = newText.split('\n');
  // LCS on lines (files in the suite are small).
  const m = a.length;
  const n = b.length;
  const dp: number[] = new Array((m + 1) * (n + 1)).fill(0);
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i * (n + 1) + j] = a[i] === b[j] ? dp[(i + 1) * (n + 1) + j + 1] + 1 : Math.max(dp[(i + 1) * (n + 1) + j], dp[i * (n + 1) + j + 1]);
    }
  }
  const common = dp[0];
  return { additions: n - common, deletions: m - common };
}

/** Files changed between the PR's merge base and its head. */
export function pullFiles(repo: Repo, rec: IssueRec): FileChange[] {
  const headSha = repo.refs.get(`refs/heads/${rec.headRef}`);
  const baseSha = repo.refs.get(`refs/heads/${rec.baseRef}`);
  if (!headSha || !baseSha) return [];
  const mb = store.mergeBase(repo, baseSha, headSha) ?? baseSha;
  const from = store.flattenTree(repo, commitTreeSha(repo, mb));
  const to = store.flattenTree(repo, commitTreeSha(repo, headSha));
  const changes: FileChange[] = [];
  const paths = new Set([...from.keys(), ...to.keys()]);
  for (const path of [...paths].sort()) {
    const f = from.get(path);
    const t = to.get(path);
    if (f?.sha === t?.sha) continue;
    const oldText = f ? repo.objects.get(f.sha)?.data.toString('utf8') ?? '' : '';
    const newText = t ? repo.objects.get(t.sha)?.data.toString('utf8') ?? '' : '';
    const { additions, deletions } = lineDiffCounts(oldText, newText);
    changes.push({
      filename: path,
      status: !f ? 'added' : !t ? 'removed' : 'modified',
      sha: t?.sha ?? null,
      additions,
      deletions,
      changes: additions + deletions,
    });
  }
  return changes;
}

/** Whether the PR can be merged cleanly right now (dry-run three-way merge). */
export function pullMergeable(repo: Repo, rec: IssueRec): boolean {
  if (rec.merged) return false;
  const headSha = repo.refs.get(`refs/heads/${rec.headRef}`);
  const baseSha = repo.refs.get(`refs/heads/${rec.baseRef}`);
  if (!headSha || !baseSha) return false;
  if (store.isAncestor(repo, headSha, baseSha)) return false; // nothing to merge
  const mb = store.mergeBase(repo, baseSha, headSha);
  if (!mb) return false;
  return mergeTrees(repo, commitTreeSha(repo, mb), commitTreeSha(repo, baseSha), commitTreeSha(repo, headSha)) !== null;
}

export function pullJson(repo: Repo, rec: IssueRec): Record<string, unknown> {
  const base = issueJson(repo, rec);
  const headSha = repo.refs.get(`refs/heads/${rec.headRef}`) ?? rec.headSha ?? '';
  const baseSha = repo.refs.get(`refs/heads/${rec.baseRef}`) ?? '';
  const refJson = (ref: string, sha: string) => ({
    label: `${repo.owner}:${ref}`,
    ref,
    sha,
    user: userJson(),
    repo: repoJson(repo),
  });
  return {
    ...base,
    state: rec.state,
    merged: rec.merged ?? false,
    merged_at: rec.mergedAt ?? null,
    merge_commit_sha: rec.mergeCommitSha ?? null,
    mergeable: rec.merged ? null : pullMergeable(repo, rec),
    mergeable_state: rec.merged ? 'clean' : pullMergeable(repo, rec) ? 'clean' : 'dirty',
    draft: false,
    head: refJson(rec.headRef ?? '', headSha),
    base: refJson(rec.baseRef ?? '', baseSha),
    additions: pullFiles(repo, rec).reduce((s, f) => s + f.additions, 0),
    deletions: pullFiles(repo, rec).reduce((s, f) => s + f.deletions, 0),
    changed_files: pullFiles(repo, rec).length,
  };
}

export function createIssue(
  repo: Repo,
  input: { title: string; body?: string | null; labels?: string[] },
): IssueRec {
  for (const name of input.labels ?? []) {
    if (!repo.labels.has(name)) throw new HttpError(422, `label "${name}" does not exist`);
  }
  const ts = store.nowIso();
  const rec: IssueRec = {
    id: store.nextIssueId++,
    number: repo.nextIssueNumber++,
    title: input.title,
    body: input.body ?? null,
    state: 'open',
    labels: [...(input.labels ?? [])],
    isPull: false,
    createdAt: ts,
    updatedAt: ts,
    closedAt: null,
    comments: [],
  };
  repo.issues.set(rec.number, rec);
  repo.updatedAt = ts;
  return rec;
}

export function createPull(
  repo: Repo,
  input: { title: string; body?: string | null; head: string; base: string },
): IssueRec {
  const stripOwner = (ref: string) => (ref.includes(':') ? ref.split(':').slice(1).join(':') : ref);
  const headRef = stripOwner(input.head);
  const baseRef = stripOwner(input.base);
  const headSha = repo.refs.get(`refs/heads/${headRef}`);
  const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
  if (!headSha) throw new HttpError(422, `head branch "${headRef}" does not exist`);
  if (!baseSha) throw new HttpError(422, `base branch "${baseRef}" does not exist`);
  const ts = store.nowIso();
  const rec: IssueRec = {
    id: store.nextIssueId++,
    number: repo.nextIssueNumber++,
    title: input.title,
    body: input.body ?? null,
    state: 'open',
    labels: [],
    isPull: true,
    createdAt: ts,
    updatedAt: ts,
    closedAt: null,
    comments: [],
    headRef,
    baseRef,
    headSha,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
  };
  repo.issues.set(rec.number, rec);
  repo.updatedAt = ts;
  return rec;
}

/** Merge a pull request (squash by default; "merge" makes a two-parent merge commit). Returns the merge commit sha. */
export function mergePull(repo: Repo, rec: IssueRec, method: string, title?: string, message?: string): string {
  if (rec.merged) throw new HttpError(405, 'Pull Request is not mergeable');
  const headSha = repo.refs.get(`refs/heads/${rec.headRef}`);
  const baseSha = repo.refs.get(`refs/heads/${rec.baseRef}`);
  if (!headSha || !baseSha) throw new HttpError(405, 'Pull Request is not mergeable');
  if (store.isAncestor(repo, headSha, baseSha)) throw new HttpError(405, 'Pull Request is not mergeable');
  const mb = store.mergeBase(repo, baseSha, headSha);
  if (!mb) throw new HttpError(405, 'Pull Request is not mergeable');
  const mergedFlat = mergeTrees(repo, commitTreeSha(repo, mb), commitTreeSha(repo, baseSha), commitTreeSha(repo, headSha));
  if (!mergedFlat) throw new HttpError(405, 'Pull Request is not mergeable');
  const treeSha = store.buildTreeFromFlat(repo, mergedFlat);
  const when = store.nowSec();
  const ident = makeIdent(VIEWER.name, VIEWER.email, when);
  const commitTitle = title ?? `${rec.title} (#${rec.number})`;
  const commitMessage = method === 'merge'
    ? `Merge pull request #${rec.number} from ${repo.owner}/${rec.headRef}\n\n${rec.title}${message ? `\n\n${message}` : ''}`
    : `${commitTitle}${message ? `\n\n${message}` : ''}`;
  const parents = method === 'merge' ? [baseSha, headSha] : [baseSha];
  const sha = store.putObject(repo, 'commit', buildCommit({
    tree: treeSha,
    parents,
    author: ident,
    committer: ident,
    message: commitMessage.endsWith('\n') ? commitMessage : commitMessage + '\n',
  }));
  repo.refs.set(`refs/heads/${rec.baseRef}`, sha);
  const ts = store.nowIso();
  rec.merged = true;
  rec.mergedAt = ts;
  rec.state = 'closed';
  rec.closedAt = ts;
  rec.updatedAt = ts;
  rec.mergeCommitSha = sha;
  repo.updatedAt = ts;
  return sha;
}

export function commitJson(repo: Repo, sha: string): Record<string, unknown> {
  const obj = repo.objects.get(sha);
  if (!obj || obj.type !== 'commit') throw new HttpError(404, 'commit not found');
  const c = parseCommit(obj.data);
  const fullName = `${repo.owner}/${repo.name}`;
  const person = (ident: string) => ({
    name: identName(ident),
    email: /<([^>]*)>/.exec(ident)?.[1] ?? '',
    date: identToIso(ident),
  });
  const asUser = (ident: string) => (/adaiversen@example\.invalid/.test(ident) ? userJson() : null);
  return {
    sha,
    node_id: nodeId('Commit', parseInt(sha.slice(0, 8), 16)),
    commit: {
      author: person(c.author),
      committer: person(c.committer),
      message: c.message.replace(/\n$/, ''),
      tree: { sha: c.tree, url: `https://api.github.com/repos/${fullName}/git/trees/${c.tree}` },
      url: `https://api.github.com/repos/${fullName}/git/commits/${sha}`,
      comment_count: 0,
    },
    url: `https://api.github.com/repos/${fullName}/commits/${sha}`,
    html_url: `https://github.com/${fullName}/commit/${sha}`,
    author: asUser(c.author),
    committer: asUser(c.committer),
    parents: c.parents.map((p) => ({ sha: p, url: `https://api.github.com/repos/${fullName}/commits/${p}`, html_url: `https://github.com/${fullName}/commit/${p}` })),
  };
}

export { parseTree };
