# ── Build stage ──────────────────────────────────────────────────────
FROM node:22-alpine AS build

# better-sqlite3 requires build tools for native addon compilation
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── Production stage ─────────────────────────────────────────────────
FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN apk add --no-cache python3 make g++ && \
    npm ci --omit=dev && \
    apk del python3 make g++

COPY --from=build /app/dist ./dist

# Ensure the data directory exists for the token cache
RUN mkdir -p /app/data

# Ensure ink can detect terminal capabilities when a TTY is allocated
ENV TERM=xterm-256color

ENTRYPOINT ["node", "dist/index.js"]
