FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=10000 \
    MAX_ACTIVE_JOBS=1 \
    YT_DLP_PATH=yt-dlp

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip ca-certificates \
    && python3 -m pip install --break-system-packages --no-cache-dir yt-dlp \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY --chown=node:node . .

USER node
EXPOSE 10000
CMD ["npm", "start"]