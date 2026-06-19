# Debian/glibc base — workerd (wrangler's local runtime) ships glibc binaries and
# misbehaves on alpine's musl, so do NOT switch this to node:*-alpine.
FROM node:22-slim

WORKDIR /app

# Install deps first for layer caching. No package-lock is committed, so use
# `npm install` (swap to `npm ci` once a lockfile exists). Pulls @anthropic-ai/sdk.
COPY package.json ./
RUN npm install

# App source (public/ and src/ are also bind-mounted in docker-compose for hot edits).
COPY . .

EXPOSE 8787

# Run the same local Cloudflare runtime production uses — no login required. If
# ANTHROPIC_API_KEY is passed into the container, write it to .dev.vars so wrangler
# dev exposes it to the Worker (enables live chat + study); otherwise run keyless.
CMD ["sh", "-c", "if [ -n \"$ANTHROPIC_API_KEY\" ]; then echo \"ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY\" > /app/.dev.vars; fi; exec npm run dev"]
