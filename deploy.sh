#!/usr/bin/env bash
# deploy.sh: publish this site to Columbia CS web space at https://www.cs.columbia.edu/~$CS_USER/
# Usage: bash deploy.sh [--dry-run]   (Git Bash, Linux or macOS; needs ssh plus rsync or tar)
#   --dry-run  print the plan and the file list without contacting the server (no network)
# Env: CS_USER (default benyang), CS_HOST (default compute.cs.columbia.edu), CS_DIR (default html)
# Copies with rsync --delete when both ends have rsync, else tar over ssh plus chmod -R o+rX,
# then mirrors into ~/secure_html when that is a real directory (older accounts), not a link.
#
# Guide: https://www.cs.columbia.edu/crf/guides/how-to-set-up-a-web-site/ (Apache needs
# directories world-executable and files world-readable). DEPLOY_METHOD=rsync|tar forces a
# transfer method, e.g. when a Cygwin rsync such as cwRsync misbehaves under Git Bash.
# An ssh key on the server saves a password prompt for each of the 2 to 4 ssh connections.
set -euo pipefail

CS_USER="${CS_USER:-benyang}"
CS_HOST="${CS_HOST:-compute.cs.columbia.edu}"
CS_DIR="${CS_DIR:-html}"
DEPLOY_METHOD="${DEPLOY_METHOD:-auto}"
DRY_RUN=0

usage() { sed -n '2,7p' "$0"; }
die() { echo "deploy.sh: error: $*" >&2; exit 1; }
say() { echo "deploy.sh: $*"; }

for arg in "$@"; do
  case "$arg" in
    --dry-run|-n) DRY_RUN=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "deploy.sh: unknown argument '$arg'" >&2; usage >&2; exit 2 ;;
  esac
done

# rsync --delete removes everything else in the target, so accept only a plain relative path.
[[ "$CS_DIR" =~ ^[A-Za-z0-9_-][A-Za-z0-9._-]*(/[A-Za-z0-9._-]+)*$ && "$CS_DIR" != *..* ]] ||
  die "refusing CS_DIR='$CS_DIR'; use a directory relative to your home, such as html"
[[ "$CS_USER" =~ ^[A-Za-z0-9._-]+$ ]] || die "refusing CS_USER='$CS_USER'"
[[ "$CS_HOST" =~ ^[A-Za-z0-9.-]+$ ]] || die "refusing CS_HOST='$CS_HOST'"
case "$DEPLOY_METHOD" in
  auto|rsync|tar) ;;
  *) die "DEPLOY_METHOD must be auto, rsync or tar (got '$DEPLOY_METHOD')" ;;
esac

SITE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REMOTE="$CS_USER@$CS_HOST"
URL="https://www.cs.columbia.edu/~$CS_USER/"
case "$CS_DIR" in
  html|secure_html) ;;
  html/*) URL="$URL${CS_DIR#html/}/" ;;
  secure_html/*) URL="$URL${CS_DIR#secure_html/}/" ;;
  *) URL="(none: ~/$CS_DIR is outside ~/html, so the web server does not publish it)" ;;
esac
# In a submodule checkout .git is a file rather than a directory, so it is matched as either.
EXCLUDES=(.git .claude/ CLAUDE.md AGENTS.md deploy.sh gen.js node_modules/ '*.bak')
RSYNC_EXCLUDES=()
for pat in "${EXCLUDES[@]}"; do RSYNC_EXCLUDES+=(--exclude "$pat"); done
SSH_OPTS=(-o ConnectTimeout=20)

# The HTTPS copy that older accounts keep in a separate ~/secure_html directory.
case "$CS_DIR" in
  html) SECURE_DIR=secure_html ;;
  html/*) SECURE_DIR="secure_html/${CS_DIR#html/}" ;;
  *) SECURE_DIR="" ;;
esac

# Files to publish, relative to SITE_DIR (call from inside it); the same rules as EXCLUDES.
list_files() {
  find . \( -name .git -o \( -type d \( -name .claude -o -name node_modules \) \) \) -prune -o \
    -type f ! -name CLAUDE.md ! -name AGENTS.md ! -name deploy.sh ! -name gen.js ! -name '*.bak' -print |
    sed 's|^\./||' | LC_ALL=C sort
}

# Runs a POSIX sh snippet on the server whatever the login shell is. Snippets hold no single quotes.
remote_sh() { ssh "${SSH_OPTS[@]}" "$REMOTE" "sh -c '$1'"; }

upload_rsync() {  # $1: target directory relative to the server home directory
  # A relative source keeps Git Bash from turning the path into C:/..., which rsync reads as host "C".
  (cd "$SITE_DIR" && rsync -avz --delete --chmod=Do+rx,Fo+r "${RSYNC_EXCLUDES[@]}" \
    -e "ssh ${SSH_OPTS[*]}" ./ "$REMOTE:$1/")
}
upload_tar() {    # $1: target directory relative to the server home directory
  (cd "$SITE_DIR" && list_files | COPYFILE_DISABLE=1 tar -cf - -T -) |
    remote_sh "mkdir -p $1 && tar -xf - -C $1 && chmod -R o+rX $1"
}

LOCAL_RSYNC="$(command -v rsync || true)"
RSYNC_NOTE=""
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    if [ "$DEPLOY_METHOD" != tar ] && [ -n "$LOCAL_RSYNC" ] && [ "${LOCAL_RSYNC#/usr/}" = "$LOCAL_RSYNC" ]; then
      RSYNC_NOTE="$LOCAL_RSYNC is not the MSYS rsync (it may be cwRsync); if it fails, rerun with DEPLOY_METHOD=tar"
    fi ;;
esac

if (( DRY_RUN )); then
  say "dry run: nothing is uploaded and the server is not contacted"
  say "site:    $SITE_DIR"
  say "target:  $REMOTE:$CS_DIR/  ->  $URL"
  case "$DEPLOY_METHOD" in
    rsync) plan="rsync -avz --delete --chmod=Do+rx,Fo+r (forced by DEPLOY_METHOD)" ;;
    tar) plan="tar over ssh, then chmod -R o+rX ~/$CS_DIR (forced by DEPLOY_METHOD)" ;;
    *) if [ -n "$LOCAL_RSYNC" ]; then
         plan="rsync -avz --delete --chmod=Do+rx,Fo+r ($LOCAL_RSYNC) if $CS_HOST has rsync, else tar over ssh + chmod -R o+rX"
       else
         plan="tar over ssh, then chmod -R o+rX ~/$CS_DIR (no local rsync)"
       fi ;;
  esac
  say "method:  $plan"
  [ -z "$RSYNC_NOTE" ] || say "note:    $RSYNC_NOTE"
  say "exclude: ${EXCLUDES[*]}"
  if [ -n "$SECURE_DIR" ]; then
    say "then:    mirror into ~/$SECURE_DIR if ~/secure_html is a real directory; skip it if it is a link"
  fi
  n=0; total=0
  while IFS= read -r f; do
    size=$(( $(wc -c < "$SITE_DIR/$f") ))
    n=$(( n + 1 )); total=$(( total + size ))
    printf '  %9d  %s\n' "$size" "$f"
  done < <(cd "$SITE_DIR" && list_files)
  say "would upload $n files ($total bytes)"
  exit 0
fi

command -v ssh >/dev/null 2>&1 || die "ssh not found"
method="$DEPLOY_METHOD"
if [ "$method" = auto ]; then
  method=tar
  if [ -n "$LOCAL_RSYNC" ]; then
    rc=0
    remote_sh 'if command -v rsync >/dev/null 2>&1; then exit 0; else exit 3; fi' || rc=$?
    case "$rc" in
      0) method=rsync ;;
      3) say "rsync is missing on $CS_HOST; falling back to tar over ssh" ;;
      *) die "ssh $REMOTE failed (exit $rc); check the network or VPN and your CS credentials" ;;
    esac
  else
    say "rsync is missing locally; falling back to tar over ssh"
  fi
fi
case "$method" in
  rsync) [ -n "$LOCAL_RSYNC" ] || die "DEPLOY_METHOD=rsync but rsync is not installed"
         [ -z "$RSYNC_NOTE" ] || say "note: $RSYNC_NOTE"
         upload=upload_rsync ;;
  tar)   command -v tar >/dev/null 2>&1 || die "tar not found"
         upload=upload_tar ;;
esac

say "uploading $SITE_DIR to $REMOTE:$CS_DIR/ with $method"
"$upload" "$CS_DIR" || die "upload to ~/$CS_DIR failed (with $method)"
if [ "$method" = tar ]; then
  say "note: tar mode does not delete server files that were removed locally"
fi

if [ -n "$SECURE_DIR" ]; then
  kind="$(remote_sh 'if [ -L secure_html ]; then echo link; elif [ -d secure_html ]; then echo dir; else echo none; fi')" ||
    die "could not inspect ~/secure_html on $CS_HOST"
  case "$kind" in
    dir)  say "~/secure_html is a separate directory (older account); mirroring into ~/$SECURE_DIR"
          "$upload" "$SECURE_DIR" || die "mirror into ~/$SECURE_DIR failed (with $method)" ;;
    link) say "~/secure_html is a link, so the HTTPS site already serves ~/html" ;;
    none) say "no ~/secure_html on $CS_HOST; nothing more to copy" ;;
    *)    die "unexpected answer about ~/secure_html: '$kind'" ;;
  esac
fi
say "done: $URL"
