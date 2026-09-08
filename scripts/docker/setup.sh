#!/bin/sh
# Docker-only operator setup for macOS and Linux. This wrapper intentionally
# mounts no Docker socket: the temporary Node container only writes operator
# files through the explicit bind mounts below.
set -eu

usage() {
  cat <<'EOF'
Usage: sh scripts/docker/setup.sh [options]

Creates an ignored .env.local and secret files outside this checkout using a
temporary Node 24 container. Node and pnpm are not required on the host.

Options:
  --repository <path>  Read-only repository mounted at /repos/projeto
  --config-dir <path>  Secret directory (default: ~/.local/share/okami-sentinel)
  --origin <url>       http://127.0.0.1:8787 or an HTTPS public origin
  --help               Show this help
EOF
}

checkout_path=$(pwd -P)
repository_input=$checkout_path
config_dir_input=${CSB_DOCKER_CONFIG_DIR:-"${HOME:?HOME must be set}/.local/share/okami-sentinel"}
origin_input=http://127.0.0.1:8787

while [ "$#" -gt 0 ]; do
  case "$1" in
    --repository|--config-dir|--origin)
      if [ "$#" -lt 2 ] || [ -z "$2" ]; then
        printf '%s\n' "Missing value for $1" >&2
        exit 2
      fi
      case "$1" in
        --repository) repository_input=$2 ;;
        --config-dir) config_dir_input=$2 ;;
        --origin) origin_input=$2 ;;
      esac
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      printf '%s\n' "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [ ! -f "$checkout_path/scripts/docker/setup.mjs" ]; then
  printf '%s\n' "Run this script from the Sentinel checkout." >&2
  exit 2
fi
if ! command -v docker >/dev/null 2>&1; then
  printf '%s\n' "Docker is required for the Docker-only setup." >&2
  exit 2
fi
if [ ! -d "$repository_input" ]; then
  printf '%s\n' "Repository is not a directory: $repository_input" >&2
  exit 2
fi

repository_path=$(cd "$repository_input" && pwd -P)
mkdir -p "$config_dir_input"
chmod 700 "$config_dir_input"
config_dir_path=$(cd "$config_dir_input" && pwd -P)

case "$config_dir_path" in
  "$checkout_path"|"$checkout_path"/*)
    printf '%s\n' "Secret directory must be outside the Git checkout." >&2
    exit 2
    ;;
esac
case "$config_dir_path" in
  "$repository_path"|"$repository_path"/*)
    printf '%s\n' "Secret directory must be outside the authorized repository." >&2
    exit 2
    ;;
esac

set -- \
  --rm \
  --user "$(id -u):$(id -g)" \
  --workdir "$checkout_path" \
  --env HOME=/tmp \
  --mount "type=bind,source=$checkout_path,target=$checkout_path" \
  --mount "type=bind,source=$config_dir_path,target=$config_dir_path" \
  node:24.17.0-bookworm \
  node scripts/docker/setup.mjs \
  --repository "$repository_path" \
  --config-dir "$config_dir_path" \
  --origin "$origin_input"

if [ "$repository_path" != "$checkout_path" ]; then
  set -- \
    --rm \
    --user "$(id -u):$(id -g)" \
    --workdir "$checkout_path" \
    --env HOME=/tmp \
    --mount "type=bind,source=$checkout_path,target=$checkout_path" \
    --mount "type=bind,source=$config_dir_path,target=$config_dir_path" \
    --mount "type=bind,source=$repository_path,target=$repository_path,readonly" \
    node:24.17.0-bookworm \
    node scripts/docker/setup.mjs \
    --repository "$repository_path" \
    --config-dir "$config_dir_path" \
    --origin "$origin_input"
fi

exec docker run "$@"
