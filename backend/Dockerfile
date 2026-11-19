# Build from the repository root:  docker compose build
FROM node:22-slim
WORKDIR /srv
COPY backend/package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY backend/src ./src
COPY frontend ./frontend
ENV NODE_ENV=production
CMD ["node", "src/server.js"]
