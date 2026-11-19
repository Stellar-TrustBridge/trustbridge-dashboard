FROM node:20-alpine AS deps
WORKDIR /app
RUN apk add --no-cache openssl
COPY package.json package-lock.json ./
RUN npm ci
COPY prisma ./prisma
RUN npx prisma generate

FROM deps AS builder
COPY . .
ARG NEXT_PUBLIC_HORIZON_URL=http://localhost:8089
ARG NEXT_PUBLIC_DEFAULT_ASSET_CODE=USDC
ARG NEXT_PUBLIC_DEFAULT_ASSET_ISSUER=GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN
ENV NEXT_PUBLIC_HORIZON_URL=${NEXT_PUBLIC_HORIZON_URL} \
    NEXT_PUBLIC_DEFAULT_ASSET_CODE=${NEXT_PUBLIC_DEFAULT_ASSET_CODE} \
    NEXT_PUBLIC_DEFAULT_ASSET_ISSUER=${NEXT_PUBLIC_DEFAULT_ASSET_ISSUER}
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
RUN apk add --no-cache openssl \
  && addgroup -S nodejs \
  && adduser -S nextjs -G nodejs
ENV NODE_ENV=production \
    PORT=3000 \
    NEXT_TELEMETRY_DISABLED=1
COPY --from=builder /app/package.json ./
COPY --from=builder /app/next.config.mjs ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/prisma ./prisma
USER nextjs
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --retries=5 \
  CMD wget -q -O - http://localhost:3000/api/health >/dev/null || exit 1
CMD ["npm", "start"]
