FROM node:24-bookworm-slim AS build
WORKDIR /repo
ENV NPM_CONFIG_UPDATE_NOTIFIER=false
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/chain/package.json packages/chain/
COPY packages/app-sdk/package.json packages/app-sdk/
COPY apps/runner/package.json apps/runner/
RUN npm ci --workspace @appgen/runner --workspace @appgen/app-sdk --include-workspace-root --no-audit --no-fund
COPY packages packages
COPY apps/runner apps/runner
COPY template template
COPY data data
COPY tsconfig.base.json ./
RUN npm run build -w @appgen/shared && npm run build -w @appgen/db && npm run build -w @appgen/chain && npm run build -w @appgen/app-sdk && npm run build -w @appgen/runner

FROM node:24-bookworm-slim
WORKDIR /repo
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates git && rm -rf /var/lib/apt/lists/*
COPY --from=build /repo /repo
# Headless Chromium for the Zentro credit-funding automation (apps/runner/src/lib/zentro.ts).
# `chromium-headless-shell` is the headless-only build Playwright runs for `headless: true`
# (about half the size of full Chromium); `--with-deps` pulls its shared libraries via apt.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx playwright install --with-deps chromium-headless-shell && rm -rf /var/lib/apt/lists/* /root/.cache /tmp/*
CMD ["node", "apps/runner/dist/index.js"]
