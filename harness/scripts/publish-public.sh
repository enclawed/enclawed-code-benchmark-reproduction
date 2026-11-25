#!/usr/bin/env bash
# Snapshot the current working tree to every public mirror as a single orphan
# commit on `main`, after wiping every branch and tag on each mirror. The SAME
# snapshot commit is pushed to all mirrors, so they end up byte-identical. The
# private remote (`origin`, a *-private repository with the full history) and
# the local working tree / HEAD are not touched.
#
# Public mirrors = every remote whose name matches `public-*`. Set one up with:
#   git remote add public-enclawed git@github.com:enclawed/<name>.git
#
# Usage: scripts/publish-public.sh [--yes]
#   --yes  skip the interactive confirmation
#
# Notes:
#   - The snapshot includes uncommitted changes and new files (anything
#     `git add -A` would stage). It respects .gitignore.
#   - GitHub-managed `refs/pull/*` refs cannot be deleted by push; left as-is.

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

mapfile -t PUBLIC_REMOTES < <(git remote | grep -E '^public-.+$' | sort)
if [ "${#PUBLIC_REMOTES[@]}" -eq 0 ]; then
  echo "error: no public mirror configured (need a remote named 'public-*')" >&2
  exit 1
fi

# This force-replaces every branch and tag on each mirror with one orphan
# commit. Pointed at the wrong repository by a typo, it would flatten the
# private history. Refuse the private source, any *-private repository, the
# enterprise tree, and anything outside the enclawed organization.
ORIGIN_URL=$(git remote get-url origin 2>/dev/null || echo "")
repo_of() { # owner/name from an ssh, https or ssh-alias GitHub URL
  echo "$1" | sed -E 's#^[a-z+]+://##; s#^git@##; s#^[^:/]+[:/]##; s#\.git$##; s#/$##'
}
for r in "${PUBLIC_REMOTES[@]}"; do
  url=$(git remote get-url "$r")
  repo=$(repo_of "$url")
  if [ -n "$ORIGIN_URL" ] && [ "$repo" = "$(repo_of "$ORIGIN_URL")" ]; then
    echo "REFUSING TO PUBLISH: $r points at origin ($url), the private source." >&2
    exit 1
  fi
  case "$repo" in
    *-private | */enclawed-enclaved | */*-enclaved)
      echo "REFUSING TO PUBLISH: $r points at $repo, which is private." >&2
      exit 1
      ;;
    enclawed/*) ;;
    *)
      echo "REFUSING TO PUBLISH: $r points at $repo, which is not an enclawed repository." >&2
      exit 1
      ;;
  esac
done


# A public snapshot is a copy of a RECORDED private commit, never of whatever is
# on disk: refuse a dirty tree, and refuse a HEAD that is not on the private
# origin yet. The snapshot is then built from HEAD's tree, so the public mirror
# can never be newer than the private repository it is cut from.
if [ -n "$(git status --porcelain --untracked-files=normal)" ]; then
  echo "REFUSING TO PUBLISH: the working tree has uncommitted changes." >&2
  echo "  commit them and push to origin first; the snapshot is taken from HEAD." >&2
  git status --short | head -20 >&2
  exit 1
fi
git fetch -q origin
UPSTREAM=$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)
if [ -z "$UPSTREAM" ] || [ "$(git rev-parse HEAD)" != "$(git rev-parse "$UPSTREAM")" ]; then
  echo "REFUSING TO PUBLISH: HEAD is not pushed to the private origin (upstream: ${UPSTREAM:-none})." >&2
  echo "  push first: git push origin HEAD" >&2
  exit 1
fi

SNAP_INDEX=$(mktemp -u)
trap 'rm -f "$SNAP_INDEX"' EXIT
GIT_INDEX_FILE="$SNAP_INDEX" git read-tree HEAD
# Public mirrors carry no CI/automation: drop GitHub Actions workflows and the
# Dependabot config from the snapshot (index only; the working tree and origin
# keep them).
GIT_INDEX_FILE="$SNAP_INDEX" git rm -r --cached --quiet --ignore-unmatch \
  .github/workflows .github/dependabot.yml >/dev/null 2>&1 || true

SNAP_FILES=$(GIT_INDEX_FILE="$SNAP_INDEX" git ls-files --cached)

# Filenames that look sensitive stop the publish (a small repo has no reason
# to ship them; move the file or add it to .gitignore).
SUSPECT=$(echo "$SNAP_FILES" \
  | grep -iE '(^|/)\.env($|\.[^e]|_)|\.pem$|\.key$|id_rsa|id_ed25519|\.netrc|\.p12$|\.pfx$|credentials\.json$' || true)
if [ -n "$SUSPECT" ]; then
  echo "REFUSING TO PUBLISH: sensitive-looking files are in the snapshot:" >&2
  echo "$SUSPECT" >&2
  exit 1
fi

# Secret-shaped content stops the publish. Obvious test placeholders are
# allowed only when they say so (test-only / placeholder / AAAA... / example).
echo "checking the snapshot for secret-shaped text ..."
HITS=$(echo "$SNAP_FILES" | while IFS= read -r f; do
  [ -f "$f" ] || continue
  grep -I -n -H -E 'BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY|sk-ant-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}' "$f" 2>/dev/null \
    | grep -v -i -E 'test-only|placeholder|AAAAAAAAAA|example|fake|dummy' || true
done)
if [ -n "$HITS" ]; then
  echo "REFUSING TO PUBLISH: secret-shaped text found:" >&2
  echo "$HITS" | cut -c1-200 >&2
  exit 1
fi
echo "  ok"

# Dependency audit at zero when the repo has a lockfile, every time.
if [ -f package-lock.json ] || [ -f pnpm-lock.yaml ]; then
  echo "checking the dependency tree for known vulnerabilities ..."
  if [ -f pnpm-lock.yaml ]; then AUDIT="pnpm audit"; else AUDIT="npm audit --omit=dev"; fi
  if ! $AUDIT >/dev/null 2>&1; then
    echo "REFUSING TO PUBLISH: '$AUDIT' is not clean, or could not run." >&2
    $AUDIT 2>&1 | tail -20 >&2 || true
    exit 1
  fi
  echo "  ok"
fi

DIRTY=$(git status --short | wc -l | tr -d ' ')
HEAD_SHA=$(git rev-parse --short HEAD)
BRANCH=$(git symbolic-ref --short HEAD 2>/dev/null || echo "(detached)")

echo
echo "About to publish one identical snapshot to ${#PUBLIC_REMOTES[@]} public mirror(s):"
for r in "${PUBLIC_REMOTES[@]}"; do
  echo "  - $r  ($(git remote get-url "$r"))"
done
echo "  source branch : $BRANCH @ $HEAD_SHA"
echo "  snapshot of   : HEAD (committed and pushed to origin)"
echo "  destination   : <remote>/main (force-replace, single orphan commit)"
echo

if [ "${1:-}" != "--yes" ]; then
  read -r -p "Proceed? [y/N] " ans
  case "$ans" in
    y|Y|yes|YES) ;;
    *) echo "aborted"; exit 1 ;;
  esac
fi

TREE=$(GIT_INDEX_FILE="$SNAP_INDEX" git write-tree)
COMMIT=$(git commit-tree "$TREE" -m "Snapshot $(date -u +%Y-%m-%d)")
echo "built snapshot commit $COMMIT (tree $TREE)"

for r in "${PUBLIC_REMOTES[@]}"; do
  echo "publishing to $r ..."
  git ls-remote --heads "$r" | awk '$2 != "refs/heads/main" {print $2}' | sed 's|^|:|' | xargs -r -n1 git push "$r"
  git ls-remote --tags "$r" | awk '{print $2}' | sed 's|^|:|' | xargs -r -n1 git push "$r"
  git push "$r" "$COMMIT:refs/heads/main" --force
  echo "  $r/main -> $COMMIT"
done
echo
echo "done. all public mirrors -> $COMMIT"
