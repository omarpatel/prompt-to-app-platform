FROM node:24-bookworm-slim AS build
WORKDIR /repo
ENV NPM_CONFIG_UPDATE_NOTIFIER=false
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/chain/package.json packages/chain/
COPY packages/app-sdk/package.json packages/app-sdk/
COPY apps/api/package.json apps/api/
RUN npm ci --workspace @appgen/api --workspace @appgen/app-sdk --include-workspace-root --no-audit --no-fund
COPY packages packages
COPY apps/api apps/api
COPY tsconfig.base.json ./
RUN npm run build -w @appgen/shared && npm run build -w @appgen/db && npm run build -w @appgen/chain && npm run build -w @appgen/app-sdk && npm run build -w @appgen/api

FROM node:24-bookworm-slim
WORKDIR /repo
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /repo /repo
EXPOSE 8080
CMD ["sh", "-c", "npx prisma migrate deploy --schema packages/db/prisma/schema.prisma && node apps/api/dist/index.js"]
