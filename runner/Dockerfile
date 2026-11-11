# Sandbox Runner: Claude Code (Agent SDK) を実行するコンテナ
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
# エージェントが使う基本ツール。必要に応じて言語ランタイム等を追加する。
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates git tar gzip curl jq ripgrep python3 python3-pip python3-venv \
    && rm -rf /var/lib/apt/lists/*
# 非 root ユーザーで実行
RUN useradd --create-home --uid 10001 agent && mkdir -p /sandbox /state && chown agent:agent /sandbox /state
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER agent
ENV NODE_ENV=production \
    HOME=/home/agent \
    SANDBOX_ROOT=/sandbox \
    PORT=8080
EXPOSE 8080
CMD ["node", "dist/server.js"]
