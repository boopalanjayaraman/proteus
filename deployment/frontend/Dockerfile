# The Proteus frontend, as static files behind nginx.
#
# Every VITE_* variable is inlined into the bundle at build time and is public
# once shipped. The build args below are the only configuration this image
# takes, and none of them is a secret — the Gemini key, the database URI and the
# GitHub token live in the backend's environment and never reach here.

FROM node:22-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY schema/package.json ./schema/
COPY src/backend/package.json ./src/backend/
COPY src/frontend/package.json ./src/frontend/
RUN npm ci --workspaces --include-workspace-root

COPY schema ./schema
COPY src/frontend ./src/frontend

ARG VITE_API_BASE_URL
ARG VITE_FIREBASE_API_KEY
ARG VITE_FIREBASE_AUTH_DOMAIN
ARG VITE_FIREBASE_PROJECT_ID
# Declared because `firebase.ts` reads it. Missing, it lands as `undefined` in
# the bundle rather than failing the build.
ARG VITE_FIREBASE_APP_ID
RUN npm run build -w @proteus/frontend

FROM nginx:1.27-alpine AS runtime
COPY --from=build /app/src/frontend/dist /usr/share/nginx/html
# A single-page app: every unknown path is the app's own route, not a 404.
RUN printf 'server {\n\
  listen 8080;\n\
  root /usr/share/nginx/html;\n\
  location / { try_files $uri $uri/ /index.html; }\n\
}\n' > /etc/nginx/conf.d/default.conf
EXPOSE 8080
