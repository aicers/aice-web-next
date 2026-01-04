FROM node:22.21.1-bookworm-slim@sha256:7378f5a4830ef48eb36d1abf4ef398391db562b5c41a0bded83192fbcea21cc8 AS builder

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN corepack enable
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm run build
RUN pnpm prune --prod

FROM node:22.21.1-bookworm-slim@sha256:7378f5a4830ef48eb36d1abf4ef398391db562b5c41a0bded83192fbcea21cc8 AS runner

WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1

RUN corepack enable
COPY --from=builder /app/package.json /app/pnpm-lock.yaml ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/next.config.ts ./next.config.ts
COPY --from=builder /app/middleware.ts ./middleware.ts
COPY --from=builder /app/messages ./messages

EXPOSE 3000

CMD ["pnpm", "run", "start"]
