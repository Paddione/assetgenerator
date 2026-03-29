FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js worker-manager.js library.json visual-library.json ./
COPY adapters/ ./adapters/
COPY config/ ./config/
COPY projects/ ./projects/
COPY scripts/ ./scripts/
COPY index.html ./

EXPOSE 5200

CMD ["node", "server.js", "--project", "arena"]
