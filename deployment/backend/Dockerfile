# The Proteus backend, for Cloud Run.
#
# Bundled rather than compiled: `@proteus/schema` exports TypeScript source and
# is consumed through a path alias, so a plain `tsc` emit leaves an import
# nothing can resolve at runtime (TD-012). esbuild inlines the workspace and
# leaves `node_modules` external, which is the smaller and more honest change.
#
# The engine assets are copied in rather than bundled. They are data the product
# reads at startup — a ruleset edit should not require a rebuild, and
# `ENGINE_DIR` exists so an operator can point at a mounted volume instead.

FROM node:22-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY schema/package.json ./schema/
COPY src/backend/package.json ./src/backend/
COPY src/frontend/package.json ./src/frontend/
RUN npm ci --workspaces --include-workspace-root

COPY schema ./schema
COPY src/backend ./src/backend
RUN npm run build -w @proteus/backend

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# git is a runtime dependency, not a build one: the migration clones, branches
# and commits by shelling out to it.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY schema/package.json ./schema/
COPY src/backend/package.json ./src/backend/
RUN npm ci --omit=dev --workspace @proteus/backend --include-workspace-root \
 && npm cache clean --force

COPY --from=build /app/src/backend/dist ./src/backend/dist
COPY engine ./engine
ENV ENGINE_DIR=/app/engine

# Cloud Run sets PORT; the config reads it and defaults for a local run.
ENV PORT=8080
EXPOSE 8080

# Non-root, and the working copies the migration clones go somewhere writable.
RUN useradd --system --create-home --uid 10001 proteus \
 && mkdir -p /tmp/proteus && chown -R proteus:proteus /tmp/proteus /app
USER proteus

CMD ["node", "src/backend/dist/server.js"]
