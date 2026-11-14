# Build context is prepared by scripts/deploy-railway.mjs from committed sibling repos.
FROM node:26-bookworm-slim
RUN npm install --global pnpm@10.22.0
WORKDIR /app
COPY player-three/ ./player-three/
COPY agent-command/ ./agent-command/
# Both repos' revisions (written by deploy-railway.mjs), stamped into the client's version tag.
COPY release.json ./release.json
# Public home-screen links, baked into the client at build time (Railway passes service variables as build args).
ARG VITE_SOCIAL_X_URL
ARG VITE_SOCIAL_DISCORD_URL
ARG VITE_SOCIAL_PATREON_URL
# The built-in bots' policy packages (gitignored build output): without them every bot seat plays createBot.
RUN cd player-three && pnpm install --frozen-lockfile \
    && cd ../agent-command && pnpm install --frozen-lockfile \
    && pnpm --filter @agent-command/game bots:build \
    && pnpm --filter @agent-command/web build
ENV NODE_ENV=production HOST=0.0.0.0 PLAYERTHREE_DEVTOOLS=0
USER node
WORKDIR /app/agent-command
CMD ["node", "apps/server/src/main.ts"]
