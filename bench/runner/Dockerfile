# ACBench cloud runner: the frozen Agent Command build beside its PlayerThree checkout, OpenCode 1.19.5 and the
# campaign orchestrator (bench/runner/orchestrate.ts). Built from the context `bench/runner/context.sh` assembles:
#   ac/        git archive of this repository at the runner commit (heavy docs media left out)
#   p3/        git archive of PlayerThree at the commit the build links (its digest is the suite's runnerDigest)
#   opencode/  the local OpenCode install's package.json + package-lock.json (exact 1.19.5)
FROM node:26.10.0-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates util-linux procps && rm -rf /var/lib/apt/lists/* \
  && npm install -g pnpm@10.22.0
COPY opencode /opt/opencode-1.19.5
RUN cd /opt/opencode-1.19.5 && npm ci --omit=dev --no-audit --no-fund \
  && /opt/opencode-1.19.5/node_modules/opencode-linux-x64/bin/opencode --version
COPY p3 /work/player-three
RUN cd /work/player-three && pnpm install --frozen-lockfile
COPY ac /work/agent-command
WORKDIR /work/agent-command
COPY BUILD /work/BUILD
RUN pnpm install --frozen-lockfile && pnpm --filter @agent-command/game bots:build
ENV ACBENCH_OPENCODE=/opt/opencode-1.19.5/node_modules/opencode-linux-x64/bin/opencode
CMD ["node", "bench/runner/orchestrate.ts"]
