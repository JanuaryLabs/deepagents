# Self-contained image for the text2sql demo daemon. Shared by both backend
# demos: the plain-Docker demo builds it on the fly (createDockerSandbox passes
# this Dockerfile + the repo root as context), and the Daytona demo boots a
# prebuilt tag of it. Build standalone from the repo root with:
#
#   docker build -f demo/text2sql-daemon/Dockerfile -t deepagents-text2sql .
#
# This package is image-only — the daemon, shim, and adapters run INSIDE the
# sandbox and are referenced by the host demos purely by path (the baked
# /repo/demo/text2sql-daemon/daemon location), never imported as a module.
#
# Build context is the REPO ROOT so the whole npm workspace is available to
# `npm ci` + `nx build`. The repo's root .dockerignore already excludes
# node_modules, dist, tests, .env, etc., so the image builds its own dependency
# tree and built packages from source.
#
# The builder stage installs the workspace, builds the packages the daemon
# imports at runtime (context, agent, text2sql) and their dist, then prunes
# devDependencies. The runtime stage carries only the pruned tree and runs the
# daemon as its main process (the Daytona demo starts it explicitly instead).

FROM node:lts-alpine AS builder
WORKDIR /repo
ENV NODE_NO_WARNINGS=1 NX_DAEMON=false HUSKY=0
COPY . .
RUN npm ci
RUN npx nx run-many -t build -p context agent text2sql
RUN npm prune --omit=dev

FROM node:lts-alpine
WORKDIR /repo
ENV NODE_NO_WARNINGS=1
# strace enables createBashTool({ trackFileChanges: true }) — per-tool-call
# filesystem-change tracking. Needs a native-arch image + ptrace (both hold
# under default Docker/Daytona). Placed before COPY so it caches independently.
RUN apk add --no-cache strace
COPY --from=builder /repo /repo
RUN ln -sf /repo/demo/text2sql-daemon/daemon/sql-shim.ts /usr/local/bin/sql \
 && mkdir -p /tmp/deepagents-demo/sql
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||4747)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "/repo/demo/text2sql-daemon/daemon/demo-daemon.ts"]
