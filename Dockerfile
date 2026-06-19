# Debian/glibc base — workerd (wrangler's local runtime) ships glibc binaries and
# misbehaves on alpine's musl, so do NOT switch this to node:*-alpine.
FROM node:22-slim

WORKDIR /app

# Install deps first for layer caching. No package-lock is committed, so use
# `npm install` (falls back gracefully); swap to `npm ci` once a lockfile exists.
COPY package.json ./
RUN npm install

# App source (public/ is also bind-mounted in docker-compose for hot edits).
COPY . .

EXPOSE 8787

# Run the same local Cloudflare runtime that production uses — no login required.
CMD ["npm", "run", "dev"]
