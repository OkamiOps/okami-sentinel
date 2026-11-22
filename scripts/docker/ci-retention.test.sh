#!/usr/bin/env bash
# Exercises scripts/docker/ci-retention.sh against a fake docker binary.
# The fake store is the contract: plain sha tags are never swept, and a
# successful main push keeps only the two newest main-* tags.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
script="${root}/scripts/docker/ci-retention.sh"
FAKE_BIN="$(mktemp -d)"
STATE=""
IMAGE_SHA="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
PLAIN_OTHER="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

cleanup() {
  rm -rf "$FAKE_BIN" ${STATE:+"$STATE"}
}
trap cleanup EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  if [ -n "$STATE" ]; then
    printf '%s\n' '--- stdout ---' >&2
    cat "$STATE/stdout" >&2 || true
    printf '%s\n' '--- stderr ---' >&2
    cat "$STATE/stderr" >&2 || true
    printf '%s\n' '--- docker log ---' >&2
    cat "$STATE/log" >&2 || true
    printf '%s\n' '--- images ---' >&2
    cat "$STATE/images.tsv" >&2 || true
  fi
  exit 1
}

assert_eq() {
  local label="$1" expected="$2" got="$3"
  if [ "$expected" != "$got" ]; then
    printf 'FAIL %s\nexpected:\n%s\ngot:\n%s\n' "$label" "$expected" "$got" >&2
    fail "$label"
  fi
}

install_fake_docker() {
  cat > "${FAKE_BIN}/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
state="${FAKE_DOCKER_STATE:?}"
printf '%s\n' "$*" >> "${state}/log"

die() {
  printf '%s\n' "$*" >&2
  exit 1
}

repo_of() { printf '%s\n' "${1%%:*}"; }
tag_of() { printf '%s\n' "${1#*:}"; }

find_row() {
  local repo="$1" tag="$2"
  awk -F '\t' -v repo="$repo" -v tag="$tag" '$3 == repo && $4 == tag { print; exit }' "${state}/images.tsv"
}

cmd="${1:-}"
shift || true
case "$cmd" in
  image)
    sub="${1:-}"
    shift || true
    case "$sub" in
      ls)
        quiet=0
        repo=""
        while [ "$#" -gt 0 ]; do
          case "$1" in
            -q) quiet=1; shift ;;
            -*) die "unsupported image ls arg $1" ;;
            *)
              [ -z "$repo" ] || die "unexpected image ls argument $1"
              repo="$1"
              shift
              ;;
          esac
        done
        [ "$quiet" = 1 ] || die "image ls must be quiet"
        [ -n "$repo" ] || die "image ls requires a repository"
        awk -F '\t' -v repo="$repo" '$3 == repo { print $1 }' "${state}/images.tsv" | awk 'NF && !seen[$0]++'
        ;;
      inspect)
        format=""
        targets=()
        while [ "$#" -gt 0 ]; do
          case "$1" in
            --format)
              shift
              format="${1:-}"
              shift || die "missing --format"
              ;;
            --format=*)
              format="${1#--format=}"
              shift
              ;;
            *)
              targets+=("$1")
              shift
              ;;
          esac
        done
        [ "${#targets[@]}" -gt 0 ] || die "inspect needs a target"
        tags_format='{{range .RepoTags}}{{$.Created}}{{"\t"}}{{.}}{{"\n"}}{{end}}'
        if [ "$format" = '{{.Created}}' ]; then
          [ "${#targets[@]}" -eq 1 ] || die "created inspect accepts one ref"
          row="$(find_row "$(repo_of "${targets[0]}")" "$(tag_of "${targets[0]}")")"
          [ -n "$row" ] || die "No such image: ${targets[0]}"
          printf '%s\n' "$row" | awk -F '\t' '{ print $2 }'
        elif [ "$format" = "$tags_format" ]; then
          for id in "${targets[@]}"; do
            awk -F '\t' -v id="$id" '$1 == id { printf "%s\t%s:%s\n", $2, $3, $4 }' "${state}/images.tsv"
          done
        else
          die "unsupported inspect format"
        fi
        ;;
      prune)
        [ "${1:-}" = "-f" ] || die "image prune must be -f and dangling-only"
        [ "$#" -eq 1 ] || die "image prune refuses extra arguments: $*"
        ;;
      *)
        die "unsupported image subcommand ${sub}"
        ;;
    esac
    ;;
  tag)
    [ "$#" -eq 2 ] || die "tag expects source and target"
    src="$1"
    dst="$2"
    row="$(find_row "$(repo_of "$src")" "$(tag_of "$src")")"
    [ -n "$row" ] || die "No such image: ${src}"
    id="$(printf '%s\n' "$row" | awk -F '\t' '{ print $1 }')"
    created="$(printf '%s\n' "$row" | awk -F '\t' '{ print $2 }')"
    awk -F '\t' -v repo="$(repo_of "$dst")" -v tag="$(tag_of "$dst")" '!($3 == repo && $4 == tag)' \
      "${state}/images.tsv" > "${state}/images.tsv.next"
    mv "${state}/images.tsv.next" "${state}/images.tsv"
    printf '%s\t%s\t%s\t%s\n' "$id" "$created" "$(repo_of "$dst")" "$(tag_of "$dst")" >> "${state}/images.tsv"
    ;;
  rmi)
    force=0
    refs=()
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -f|--force) force=1; shift ;;
        -*) die "unsupported rmi flag $1" ;;
        *) refs+=("$1"); shift ;;
      esac
    done
    [ "${#refs[@]}" -gt 0 ] || die "rmi needs a ref"
    status=0
    for ref in "${refs[@]}"; do
      row="$(find_row "$(repo_of "$ref")" "$(tag_of "$ref")")"
      if [ -z "$row" ]; then
        printf 'No such image: %s\n' "$ref" >&2
        status=1
        continue
      fi
      id="$(printf '%s\n' "$row" | awk -F '\t' '{ print $1 }')"
      if [ "$force" -ne 1 ] && grep -Fxq "$id" "${state}/in-use"; then
        printf 'Error: image %s is in use by a container\n' "$id" >&2
        status=1
        continue
      fi
      awk -F '\t' -v repo="$(repo_of "$ref")" -v tag="$(tag_of "$ref")" '!($3 == repo && $4 == tag)' \
        "${state}/images.tsv" > "${state}/images.tsv.next"
      mv "${state}/images.tsv.next" "${state}/images.tsv"
    done
    exit "$status"
    ;;
  builder)
    [ "${1:-}" = "prune" ] || die "unsupported builder subcommand ${1:-}"
    shift
    if [ "${1:-}" = "--help" ]; then
      cat "${state}/help.txt"
      exit 0
    fi
    printf '%s\n' "$*" >> "${state}/prune-log"
    ;;
  *)
    die "unsupported docker command ${cmd}"
    ;;
esac
EOF
  chmod 700 "${FAKE_BIN}/docker"
}

reset_state() {
  STATE="$(mktemp -d)"
  cat > "${STATE}/help.txt" <<'EOF'
Usage:  docker builder prune

Options:
  -f, --force                  Do not prompt for confirmation
      --filter filter          Provide filter values (e.g. until=24h)
      --keep-storage bytes     Amount of disk space to keep for cache
      --max-used-space bytes   Maximum amount of disk space allowed to keep for cache
EOF
  : > "${STATE}/images.tsv"
  : > "${STATE}/in-use"
  : > "${STATE}/log"
  : > "${STATE}/prune-log"
  : > "${STATE}/stdout"
  : > "${STATE}/stderr"
}

add_image() {
  local id="$1" created="$2" tag="$3"
  printf '%s\t%s\t%s\t%s\n' "$id" "$created" "csb-sentinel" "$tag" >> "${STATE}/images.tsv"
}

seed_history() {
  add_image img-a "2020-01-01T00:00:00.000000000Z" "main-a"
  add_image img-b "2021-01-01T00:00:00.000000000Z" "main-b"
  add_image img-c "2022-01-01T00:00:00.000000000Z" "main-c"
  add_image img-current "2023-01-01T00:00:00.000000000Z" "$IMAGE_SHA"
  add_image img-plain "2024-01-01T00:00:00.000000000Z" "$PLAIN_OTHER"
}

run_script() {
  local event="$1" ref="$2" status="$3" dry="${4:-0}"
  set +e
  env \
    PATH="${FAKE_BIN}:${PATH}" \
    FAKE_DOCKER_STATE="$STATE" \
    IMAGE_REPO=csb-sentinel \
    IMAGE_SHA="$IMAGE_SHA" \
    GITHUB_EVENT_NAME="$event" \
    GITHUB_REF="$ref" \
    JOB_STATUS="$status" \
    DRY_RUN="$dry" \
    KEEP_MAIN=2 \
    bash "$script" >"${STATE}/stdout" 2>"${STATE}/stderr"
  local exit_code=$?
  set -e
  printf '%s\n' "$exit_code" > "${STATE}/status"
}

tags() {
  awk -F '\t' '{ print $4 }' "${STATE}/images.tsv" | LC_ALL=C sort | paste -sd' ' -
}

assert_tags() {
  local expected
  expected="$(printf '%s\n' "$@" | LC_ALL=C sort | paste -sd' ' -)"
  assert_eq "tags" "$expected" "$(tags)"
}

require_status() {
  local expected="$1"
  local got
  got="$(cat "${STATE}/status")"
  [ "$got" = "$expected" ] || fail "exit ${got}, expected ${expected}"
}

require_log_line() {
  grep -Fxq "$1" "${STATE}/log" || fail "docker log missing: $1"
}

refuse_log_line() {
  if grep -Fxq "$1" "${STATE}/log"; then
    fail "docker log should not contain: $1"
  fi
}

install_fake_docker

grep -q 'set -euo pipefail' "$script" || fail "script must enable pipefail"
bash -n "$script"
bash -n "${FAKE_BIN}/docker"
if grep -nE 'system prune|volume prune|container prune|image prune -a|image prune --all' "$script"; then
  fail "script contains a forbidden prune"
fi

printf '== missing IMAGE_SHA ==\n'
reset_state
set +e
env -u IMAGE_SHA -u GITHUB_SHA PATH="${FAKE_BIN}:${PATH}" FAKE_DOCKER_STATE="$STATE" \
  JOB_STATUS=success GITHUB_EVENT_NAME=push GITHUB_REF=refs/heads/main \
  bash "$script" >"${STATE}/stdout" 2>"${STATE}/stderr"
status=$?
set -e
[ "$status" -eq 1 ] || fail "missing IMAGE_SHA should exit 1"
[ ! -s "${STATE}/log" ] || fail "missing IMAGE_SHA must not call docker"

printf '== help ==\n'
reset_state
bash "$script" --help >"${STATE}/stdout"
grep -q 'DRY_RUN=1' "${STATE}/stdout" || fail "help should mention DRY_RUN"

printf '== pull request removes only its sha tag ==\n'
reset_state
seed_history
run_script pull_request refs/pull/7/merge success 0
require_status 0
assert_tags main-a main-b main-c "$PLAIN_OTHER"
require_log_line "rmi -f csb-sentinel:${IMAGE_SHA}"
refuse_log_line "rmi csb-sentinel:${PLAIN_OTHER}"
refuse_log_line "rmi csb-sentinel:main-a"
refuse_log_line "image prune -f"
assert_eq "pr prune order" "-f --filter until=24h
-f --max-used-space 8GB" "$(cat "${STATE}/prune-log")"
assert_eq "pr stdout" "delete csb-sentinel:${IMAGE_SHA}
prune builder --filter until=24h
prune builder --max-used-space 8GB" "$(cat "${STATE}/stdout")"

printf '== failed main push matches the pull-request cleanup ==\n'
reset_state
seed_history
run_script push refs/heads/main failure 0
require_status 0
assert_tags main-a main-b main-c "$PLAIN_OTHER"
require_log_line "rmi -f csb-sentinel:${IMAGE_SHA}"

printf '== cancelled main push matches the pull-request cleanup ==\n'
reset_state
seed_history
run_script push refs/heads/main cancelled 0
require_status 0
assert_tags main-a main-b main-c "$PLAIN_OTHER"

printf '== other ref on a successful push does not promote ==\n'
reset_state
seed_history
run_script push refs/heads/feature success 0
require_status 0
assert_tags main-a main-b main-c "$PLAIN_OTHER"
require_log_line "rmi -f csb-sentinel:${IMAGE_SHA}"

printf '== successful main keeps the two newest main tags ==\n'
reset_state
seed_history
run_script push refs/heads/main success 0
require_status 0
assert_tags "main-${IMAGE_SHA}" main-c main-latest "$PLAIN_OTHER"
require_log_line "tag csb-sentinel:${IMAGE_SHA} csb-sentinel:main-${IMAGE_SHA}"
require_log_line "tag csb-sentinel:${IMAGE_SHA} csb-sentinel:main-latest"
require_log_line "rmi csb-sentinel:${IMAGE_SHA}"
refuse_log_line "rmi -f csb-sentinel:${IMAGE_SHA}"
require_log_line "rmi csb-sentinel:main-a"
require_log_line "rmi csb-sentinel:main-b"
refuse_log_line "rmi csb-sentinel:main-c"
refuse_log_line "rmi csb-sentinel:main-${IMAGE_SHA}"
refuse_log_line "rmi csb-sentinel:main-latest"
refuse_log_line "rmi csb-sentinel:${PLAIN_OTHER}"
require_log_line "image prune -f"
assert_eq "main prune order" "-f --filter until=24h
-f --max-used-space 8GB" "$(cat "${STATE}/prune-log")"
current_id="$(awk -F '\t' -v tag="main-${IMAGE_SHA}" '$4 == tag { print $1 }' "${STATE}/images.tsv")"
latest_id="$(awk -F '\t' -v tag="main-latest" '$4 == tag { print $1 }' "${STATE}/images.tsv")"
[ "$current_id" = "img-current" ] || fail "main tag should stay on the built image"
[ "$latest_id" = "img-current" ] || fail "main-latest should follow the built image"

printf '== dry-run prints deletions and does not mutate ==\n'
reset_state
seed_history
checksum="$(cksum "${STATE}/images.tsv")"
run_script push refs/heads/main success 1
require_status 0
[ "$checksum" = "$(cksum "${STATE}/images.tsv")" ] || fail "dry-run mutated the image store"
assert_eq "dry-run stdout" "would tag csb-sentinel:${IMAGE_SHA} csb-sentinel:main-${IMAGE_SHA}
would tag csb-sentinel:${IMAGE_SHA} csb-sentinel:main-latest
would delete csb-sentinel:${IMAGE_SHA}
keep csb-sentinel:main-${IMAGE_SHA}
keep csb-sentinel:main-c
would delete csb-sentinel:main-b
would delete csb-sentinel:main-a
would run: docker image prune -f
would run: docker builder prune -f --filter until=24h
would run: docker builder prune -f --max-used-space 8GB" "$(cat "${STATE}/stdout")"
if grep -Eq '^(tag |rmi |image prune -f|builder prune -f)' "${STATE}/log"; then
  fail "dry-run invoked a mutating docker command"
fi

printf '== in-use main image is skipped without -f ==\n'
reset_state
seed_history
printf 'img-a\n' > "${STATE}/in-use"
run_script push refs/heads/main success 0
require_status 0
assert_tags "main-${IMAGE_SHA}" main-a main-c main-latest "$PLAIN_OTHER"
require_log_line "rmi csb-sentinel:main-a"
if grep -F 'rmi -f csb-sentinel:main-' "${STATE}/log"; then
  fail "sweep used docker rmi -f"
fi

printf '== fewer than two previous main tags deletes nothing else ==\n'
reset_state
add_image img-c "2022-01-01T00:00:00.000000000Z" "main-c"
add_image img-current "2023-01-01T00:00:00.000000000Z" "$IMAGE_SHA"
add_image img-plain "2024-01-01T00:00:00.000000000Z" "$PLAIN_OTHER"
run_script push refs/heads/main success 0
require_status 0
assert_tags "main-${IMAGE_SHA}" main-c main-latest "$PLAIN_OTHER"
refuse_log_line "rmi csb-sentinel:main-c"

printf '== keep-storage is the size-cap fallback ==\n'
reset_state
seed_history
cat > "${STATE}/help.txt" <<'EOF'
Usage:  docker builder prune
      --filter filter
      --keep-storage bytes
EOF
run_script push refs/heads/main failure 0
require_status 0
assert_eq "keep-storage prune" "-f --filter until=24h
-f --keep-storage 8GB" "$(cat "${STATE}/prune-log")"

printf '== missing size-cap flag still applies the age filter ==\n'
reset_state
seed_history
cat > "${STATE}/help.txt" <<'EOF'
Usage:  docker builder prune
      --filter filter
      --force
EOF
run_script pull_request refs/pull/7/merge success 0
require_status 0
assert_eq "age-only prune" "-f --filter until=24h" "$(cat "${STATE}/prune-log")"
grep -q 'builder prune size cap unavailable; skipped' "${STATE}/stderr" || fail "expected size-cap skip notice"

printf '== promotion failure still removes the plain tag ==\n'
reset_state
add_image img-a "2020-01-01T00:00:00.000000000Z" "main-a"
run_script push refs/heads/main success 0
require_status 0
assert_tags main-a
require_log_line "rmi -f csb-sentinel:${IMAGE_SHA}"

printf '== plain sha that looks like a main tag is rejected ==\n'
reset_state
set +e
env PATH="${FAKE_BIN}:${PATH}" FAKE_DOCKER_STATE="$STATE" \
  IMAGE_SHA=main-abcdef JOB_STATUS=failure GITHUB_EVENT_NAME=pull_request GITHUB_REF=refs/pull/1/merge \
  bash "$script" >"${STATE}/stdout" 2>"${STATE}/stderr"
status=$?
set -e
[ "$status" -eq 1 ] || fail "main-* IMAGE_SHA should be rejected"
[ ! -s "${STATE}/log" ] || fail "rejected IMAGE_SHA must not call docker"

printf 'ci-retention tests passed\n'
