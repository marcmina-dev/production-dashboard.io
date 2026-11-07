FROM node:22-alpine

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@11.25.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile

COPY server.js shared-sync.js attendance-report.js index.html protrack-mark.svg manus-routes.json ./
COPY db/migrations ./db/migrations

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
