#!/usr/bin/env bash
# Retain Sentinel CI images on the shared self-hosted Docker host.
#
# Five runners share one daemon. A successful push to main retags the image
# that this job built and keeps the two newest csb-sentinel:main-* tags
# (main-latest is a moving alias and does not take a slot). Every other run
# deletes only its own plain sha tag, so a concurrent pull request is left
# alone. The retention sweep never passes -f to docker rmi: an image a
# container still references is skipped.
#
# Environment:
#   IMAGE_REPO          Repository name (default: csb-sentinel)
#   IMAGE_SHA           Plain tag this job built (default: $GITHUB_SHA)
#   GITHUB_EVENT_NAME   push, pull_request, ...
#   GITHUB_REF          Full ref (refs/heads/main, refs/pull/N/merge, ...)
#   JOB_STATUS          success, failure, or cancelled
#   KEEP_MAIN           How many main-* tags to keep (default: 2)
#   CACHE_UNTIL         Builder prune age filter (default: 24h)
#   CACHE_CAP           Builder cache size cap (default: 8GB)
#   DRY_RUN             1 prints the tags and prunes it would apply
set -euo pipefail

IMAGE_REPO="${IMAGE_REPO:-csb-sentinel}"
IMAGE_SHA="${IMAGE_SHA:-${GITHUB_SHA:-}}"
KEEP_MAIN="${KEEP_MAIN:-2}"
CACHE_UNTIL="${CACHE_UNTIL:-24h}"
CACHE_CAP="${CACHE_CAP:-8GB}"
DRY_RUN="${DRY_RUN:-0}"

INSPECT_TAGS_FORMAT='{{range .RepoTags}}{{$.Created}}{{"\t"}}{{.}}{{"\n"}}{{end}}'
INSPECT_CREATED_FORMAT='{{.Created}}'
PROMOTION_CREATED=""

usage() {
  cat <<'EOF'
Usage: bash scripts/docker/ci-retention.sh

Reads IMAGE_SHA, GITHUB_EVENT_NAME, GITHUB_REF, and JOB_STATUS. DRY_RUN=1
prints the tags and cache prunes that would run and does not mutate Docker.
EOF
}

die() {
  printf '%s\n' "$*" >&2
  exit 1
}

is_dry() {
  [ "$DRY_RUN" = "1" ]
}

is_successful_main_push() {
  [ "${JOB_STATUS:-}" = "success" ] \
    && [ "${GITHUB_EVENT_NAME:-}" = "push" ] \
    && [ "${GITHUB_REF:-}" = "refs/heads/main" ]
}

valid_repo() {
  case "$1" in
    [a-z0-9]*) ;;
    *) return 1 ;;
  esac
  case "$1" in
    *[!a-z0-9._-]*) return 1 ;;
    *..*|*[._-][._-]*|*[._-]) return 1 ;;
  esac
}

valid_tag() {
  local tag="$1"
  local length="${#tag}"
  [ "$length" -ge 1 ] && [ "$length" -le 128 ] || return 1
  case "$tag" in
    [A-Za-z0-9_]*) ;;
    *) return 1 ;;
  esac
  case "$tag" in
    *[!A-Za-z0-9_.-]*) return 1 ;;
  esac
}

validate() {
  valid_repo "$IMAGE_REPO" || die "IMAGE_REPO is not a local Docker repository name: ${IMAGE_REPO}"
  [ -n "$IMAGE_SHA" ] || die "IMAGE_SHA is required"
  valid_tag "$IMAGE_SHA" || die "IMAGE_SHA is not a Docker tag: ${IMAGE_SHA}"
  valid_tag "main-${IMAGE_SHA}" || die "main-${IMAGE_SHA} is not a Docker tag"
  case "$IMAGE_SHA" in
    main-*|latest) die "IMAGE_SHA must be the plain build tag, not ${IMAGE_SHA}" ;;
  esac
  case "$KEEP_MAIN" in
    0|[1-9]|[1-9][0-9]) ;;
    *) die "KEEP_MAIN must be an integer from 0 to 99" ;;
  esac
  if [[ ! "$CACHE_UNTIL" =~ ^([0-9]+(ns|us|ms|h|m|s))+$ ]]; then
    die "CACHE_UNTIL must be a Docker duration such as 24h"
  fi
  if [[ ! "$CACHE_CAP" =~ ^[1-9][0-9]*([bB]|[kKmMgGtT]i?[bB])?$ ]]; then
    die "CACHE_CAP must be a size such as 8GB"
  fi
  case "$DRY_RUN" in
    0|1) ;;
    *) die "DRY_RUN must be 0 or 1" ;;
  esac
}

plain_ref() {
  printf '%s:%s\n' "$IMAGE_REPO" "$IMAGE_SHA"
}

promote_successful_image() {
  local src retained latest created
  src="$(plain_ref)"
  retained="${IMAGE_REPO}:main-${IMAGE_SHA}"
  latest="${IMAGE_REPO}:main-latest"
  PROMOTION_CREATED=""

  if is_dry; then
    created="$(docker image inspect --format "$INSPECT_CREATED_FORMAT" "$src" 2>/dev/null || true)"
    if [ -z "$created" ]; then
      printf 'would delete %s\n' "$src"
      return 0
    fi
    printf 'would tag %s %s\n' "$src" "$retained"
    printf 'would tag %s %s\n' "$src" "$latest"
    printf 'would delete %s\n' "$src"
    PROMOTION_CREATED="$created"
    return 0
  fi

  if docker tag "$src" "$retained"; then
    printf 'tag %s %s\n' "$src" "$retained"
    if docker tag "$src" "$latest"; then
      printf 'tag %s %s\n' "$src" "$latest"
    else
      printf 'tag failed %s %s\n' "$src" "$latest" >&2
    fi
    printf 'delete %s\n' "$src"
    docker rmi "$src" || true
  else
    printf 'promotion failed for %s; removing plain tag\n' "$src" >&2
    printf 'delete %s\n' "$src"
    docker rmi -f "$src" || true
  fi
}

collect_main_tags() {
  local ids formatted created ref tag
  ids="$(docker image ls -q "$IMAGE_REPO" 2>/dev/null || true)"
  [ -n "$ids" ] || return 0
  ids="$(printf '%s\n' "$ids" | awk 'NF && !seen[$0]++')"
  # Image ids are hex (optionally sha256-prefixed) and contain no whitespace.
  # shellcheck disable=SC2086
  formatted="$(docker image inspect --format "$INSPECT_TAGS_FORMAT" $ids 2>/dev/null || true)"
  [ -n "$formatted" ] || return 0
  printf '%s\n' "$formatted" | while IFS="$(printf '\t')" read -r created ref; do
    [ -n "${created:-}" ] || continue
    [ -n "${ref:-}" ] || continue
    case "$ref" in
      "${IMAGE_REPO}:main-latest")
        continue
        ;;
      "${IMAGE_REPO}:main-"*)
        tag="${ref#"${IMAGE_REPO}:"}"
        printf '%s\t%s\n' "$created" "$tag"
        ;;
    esac
  done
}

retain_main_images() {
  local lines sorted created tag kept ref
  lines="$(collect_main_tags || true)"
  if is_dry && [ -n "$PROMOTION_CREATED" ]; then
    if ! printf '%s\n' "$lines" | awk -F '\t' -v tag="main-${IMAGE_SHA}" '$2 == tag { found = 1 } END { exit found ? 0 : 1 }'; then
      if [ -n "$lines" ]; then
        lines="${lines}"$'\n'"${PROMOTION_CREATED}"$'\t'"main-${IMAGE_SHA}"
      else
        lines="${PROMOTION_CREATED}"$'\t'"main-${IMAGE_SHA}"
      fi
    fi
  fi
  sorted="$(
    printf '%s\n' "$lines" \
      | LC_ALL=C sort -t "$(printf '\t')" -k1,1r -k2,2r \
      | awk -F '\t' '($2 != "") && !seen[$2]++'
  )"
  [ -n "$sorted" ] || return 0
  kept=0
  while IFS="$(printf '\t')" read -r created tag; do
    [ -n "${tag:-}" ] || continue
    case "$tag" in
      main-latest) continue ;;
      main-*) ;;
      *) continue ;;
    esac
    kept=$((kept + 1))
    ref="${IMAGE_REPO}:${tag}"
    if [ "$kept" -le "$KEEP_MAIN" ]; then
      printf 'keep %s\n' "$ref"
      continue
    fi
    if is_dry; then
      printf 'would delete %s\n' "$ref"
      continue
    fi
    # No -f: docker refuses while a container still references this image.
    printf 'delete %s\n' "$ref"
    docker rmi "$ref" || true
  done <<< "$sorted"
  return 0
}

remove_plain_tag_forced() {
  local ref
  ref="$(plain_ref)"
  if is_dry; then
    printf 'would delete %s\n' "$ref"
    return 0
  fi
  printf 'delete %s\n' "$ref"
  docker rmi -f "$ref" || true
}

prune_dangling_images() {
  if is_dry; then
    printf 'would run: docker image prune -f\n'
    return 0
  fi
  printf 'prune dangling images\n'
  docker image prune -f || true
}

prune_builder_cache() {
  local help flag
  help="$(docker builder prune --help 2>&1 || true)"
  if [[ "$help" == *"--max-used-space"* ]]; then
    flag="--max-used-space"
  elif [[ "$help" == *"--keep-storage"* ]]; then
    flag="--keep-storage"
  else
    flag=""
  fi

  if is_dry; then
    printf 'would run: docker builder prune -f --filter until=%s\n' "$CACHE_UNTIL"
  else
    printf 'prune builder --filter until=%s\n' "$CACHE_UNTIL"
    docker builder prune -f --filter "until=${CACHE_UNTIL}" || true
  fi

  if [ -z "$flag" ]; then
    printf 'builder prune size cap unavailable; skipped\n' >&2
    return 0
  fi
  if is_dry; then
    printf 'would run: docker builder prune -f %s %s\n' "$flag" "$CACHE_CAP"
    return 0
  fi
  printf 'prune builder %s %s\n' "$flag" "$CACHE_CAP"
  docker builder prune -f "$flag" "$CACHE_CAP" || true
}

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  usage
  exit 0
fi
if [ "$#" -gt 0 ]; then
  die "unexpected argument: $1"
fi

validate
if is_successful_main_push; then
  promote_successful_image
  retain_main_images
  prune_dangling_images
else
  remove_plain_tag_forced
fi
prune_builder_cache
