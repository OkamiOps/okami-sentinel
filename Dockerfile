# syntax=docker/dockerfile:1.7
# Node patch is pinned deliberately. Update it with the CI Node version after
# validating the resulting Linux amd64 image.
FROM node:24.17.0-bookworm-slim AS base

ENV DEBIAN_FRONTEND=noninteractive \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH

WORKDIR /app

FROM base AS build

# better-sqlite3 and keytar can need a Linux native build. Keep compilers out
# of the final image.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    build-essential \
    libsecret-1-dev \
    pkg-config \
    python3 \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@11.5.2 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/gate-cli/package.json apps/gate-cli/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/gate-core/package.json packages/gate-core/package.json
COPY packages/gate-runtime/package.json packages/gate-runtime/package.json
COPY packages/shared/package.json packages/shared/package.json

COPY scripts/setup-graphify.mjs scripts/setup-graphify.mjs
RUN CSB_SKIP_GRAPHIFY_SETUP=1 pnpm install --frozen-lockfile

COPY . .

# The API intentionally remains TypeScript executed by tsx. The frontend is
# the only artifact compiled for the final image.
RUN pnpm --filter @csb/web build \
  && pnpm --filter @csb/api build \
  && CSB_SKIP_GRAPHIFY_SETUP=1 pnpm --filter @csb/api deploy --prod --legacy /opt/api-runtime

FROM base AS sentinel-engines

ARG CODEX_VERSION=0.153.4
ARG CODEX_SECURITY_VERSION=0.1.25

# These packages are installed during the image build only. No scan, model
# request, package update, or CLI execution is performed here.
RUN npm install --prefix /opt/sentinel-engines/codex-cli \
      --omit=dev --no-audit --no-fund "@openai/codex@${CODEX_VERSION}" \
  && npm install --prefix /opt/sentinel-engines/codex-security \
      --omit=dev --no-audit --no-fund "@openai/codex-security@${CODEX_SECURITY_VERSION}" \
  && test -x /opt/sentinel-engines/codex-cli/node_modules/.bin/codex \
  && test -x /opt/sentinel-engines/codex-security/node_modules/.bin/codex-security

FROM base AS sentinel-graphify

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY scripts/setup-graphify.mjs /app/scripts/setup-graphify.mjs
RUN CSB_GRAPHIFY_INSTALL_DIR=/opt/sentinel-engines/graphify node /app/scripts/setup-graphify.mjs \
  && rm -rf /opt/sentinel-engines/graphify/cache

FROM base AS runtime

ARG CSB_GITHUB_ACTIONS_WORKFLOW_SHA

ENV NODE_ENV=production \
    CSB_BUNDLED_RUNTIME_DIR=/opt/sentinel-engines \
    CSB_GRAPHIFY_BIN=/opt/sentinel-engines/graphify/venv/bin/graphify \
    PATH=/opt/sentinel-engines/codex-cli/node_modules/.bin:/opt/sentinel-engines/codex-security/node_modules/.bin:$PATH \
    CSB_GITHUB_ACTIONS_WORKFLOW_SHA=${CSB_GITHUB_ACTIONS_WORKFLOW_SHA}

# Runtime utilities used by bounded repository operations and external engine
# processes. The image does not include compilers, Playwright, or a browser.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    git \
    gh \
    libsecret-1-0 \
    python3 \
    ripgrep \
    tini \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /repos /var/lib/sentinel

# `pnpm deploy` produces the production dependency closure for the API. Copy
# it as the API directory so `ROOT_DIR` still resolves to /app and worker
# paths remain /app/apps/api/{src,node_modules}; no builder node_modules or
# workspace links leak into the final image.
COPY --from=build /opt/api-runtime ./apps/api
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/scripts/docker/init-volume.mjs ./scripts/docker/init-volume.mjs
COPY --from=build /app/scripts/docker/healthcheck.mjs ./scripts/docker/healthcheck.mjs
COPY --from=sentinel-engines /opt/sentinel-engines /opt/sentinel-engines
COPY --from=sentinel-graphify /opt/sentinel-engines/graphify /opt/sentinel-engines/graphify

# The container is started explicitly as the Node image's non-root account by
# Compose. The directory is initialized separately to avoid recursive chown of
# persisted data on each deployment.
EXPOSE 8787

WORKDIR /app/apps/api

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--import", "tsx", "src/index.ts"]
