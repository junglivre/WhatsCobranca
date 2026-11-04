# syntax=docker/dockerfile:1
FROM node:22.18.0-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssl && rm -rf /var/lib/apt/lists/*

FROM base AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --strict-ssl=true
COPY tsconfig.json ./
COPY prisma ./prisma
COPY src ./src
COPY test ./test
RUN npx prisma generate && npm run build

FROM base
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/package-lock.json ./package-lock.json
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/dist ./dist
COPY --from=build /app/test ./test
COPY --from=build /app/src ./src
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]
