# Trading desk image: runs the bot, its dashboard and the remote Claude connector on one port.
FROM node:22-slim
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
COPY public ./public

ENV HOST=0.0.0.0 \
    PORT=8787 \
    DATA_DIR=/data
EXPOSE 8787

# tsx runs the TypeScript directly; state lives in /data (mount a volume there so restarts resume)
CMD ["npx", "tsx", "src/index.ts"]
