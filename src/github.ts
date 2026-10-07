/**
 * The web URL of a GitHub repository, from a git remote URL such as `https://github.com/o/r.git`,
 * `git@github.com:o/r.git` or `ssh://git@github.com/o/r.git`. Undefined for other remotes.
 *
 * Hosts count as GitHub as they do in GitButler: containing `github.com`, or starting with
 * `github.` (GitHub Enterprise).
 */
export function githubRepoUrl(remoteUrl: string): string | undefined {
  const match = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/]+@)?([^/:]+)(?::\d+)?[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(
    remoteUrl.trim(),
  );
  if (!match) {
    return undefined;
  }
  const [, host, owner, repo] = match;
  const lowerHost = host.toLowerCase();
  if (!lowerHost.includes("github.com") && !lowerHost.startsWith("github.")) {
    return undefined;
  }
  return `https://${lowerHost}/${owner}/${repo}`;
}

/** The URL of a branch's page in a GitHub repository. */
export function githubBranchUrl(repoUrl: string, branch: string): string {
  return `${repoUrl}/tree/${branch.split("/").map(encodeURIComponent).join("/")}`;
}
