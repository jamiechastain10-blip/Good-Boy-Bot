# Basic Ghost Labs - Good Boy: run it in Docker (see docs/ALWAYS-ONLINE.md)
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production DASHBOARD_HOST=0.0.0.0
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY . .
RUN mkdir -p data && chown -R node:node /app
USER node
EXPOSE 3000
VOLUME ["/app/data"]
CMD ["node", "--env-file-if-exists=.env", "--disable-warning=ExperimentalWarning", "scripts/supervise.js"]
