# Sandbox Runner: Claude Code (Agent SDK) を実行するコンテナ
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
# エージェントの開発環境: Python 3 + Node.js 22 + ビルドツール。
# 他の言語（Go, Java など）が必要ならここに追加する。
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates git tar gzip zstd xz-utils unzip curl jq ripgrep procps lsof \
      build-essential pkg-config \
      python3 python3-dev python3-pip python3-venv \
      sqlite3 libsqlite3-dev libssl-dev libffi-dev \
    && rm -rf /var/lib/apt/lists/*
# uv（Python のパッケージ管理）と pnpm / yarn
RUN pip3 install --no-cache-dir --break-system-packages uv \
    && npm install -g pnpm yarn \
    && npm cache clean --force
# "python" / "pip" でも呼べるように
RUN ln -s /usr/bin/python3 /usr/local/bin/python
# 非 root ユーザーで実行
RUN useradd --create-home --uid 10001 agent && mkdir -p /sandbox /store && chown agent:agent /sandbox /store
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
