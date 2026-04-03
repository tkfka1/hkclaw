FROM node:22-bookworm-slim AS build

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
COPY tsconfig.json ./
COPY runners/agent-runner/package.json runners/agent-runner/package.json
COPY runners/agent-runner/tsconfig.json runners/agent-runner/tsconfig.json
COPY runners/codex-runner/package.json runners/codex-runner/package.json
COPY runners/codex-runner/tsconfig.json runners/codex-runner/tsconfig.json

RUN npm ci
RUN npm --prefix runners/agent-runner install
RUN npm --prefix runners/codex-runner install

COPY src ./src
COPY setup ./setup
COPY runners ./runners

RUN npm run build:runners
RUN npm run build
RUN npm prune --omit=dev
RUN npm --prefix runners/agent-runner prune --omit=dev
RUN npm --prefix runners/codex-runner prune --omit=dev

FROM node:22-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV HKCLAW_STORE_DIR=/app/store
ENV HKCLAW_GROUPS_DIR=/app/groups
ENV HKCLAW_DATA_DIR=/app/data

COPY --from=build /app/package*.json ./
COPY --from=build /app/dist ./dist
COPY --from=build /app/runners ./runners
COPY --from=build /app/src/admin-web-game.html ./src/admin-web-game.html
COPY --from=build /app/node_modules ./node_modules

RUN mkdir -p /app/data /app/store /app/groups /app/cache /app/logs /app/admin-assets \
  && chown -R node:node /app

USER node

CMD ["node", "dist/index.js"]
