# Build stage: the TypeScript toolchain and the compiler for better-sqlite3's
# native addon live here and never reach the runtime image.
FROM node:22-slim AS build

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
# The lockfile makes production builds reproducible. It is generated with
# legacy peer resolution because React Native is only a peer of a browser/
# WebRTC dependency and is not used by this Node-only RPC client; installing it
# would ship Metro and an unused parser surface in the API image.
RUN npm ci --legacy-peer-deps

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build \
  && npm prune --omit=dev --legacy-peer-deps

# Runtime stage: one node process on compiled JavaScript. Running the sources
# through `npm start` -> `tsx` cost each instance three extra processes (npm,
# tsx, esbuild), a second V8 isolate for tsx's loader thread, and — because tsx
# turns source-map support on — Node decoding pkc-js's shipped source maps into
# ~235 MB of heap as its chunks loaded. Measured on the same 68-board crawl:
# ~660 MB RSS via tsx versus ~290 MB here, with the JS heap flat at ~45 MB.
FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# ESM needs the package's "type": "module" next to dist/.
COPY package.json ./

EXPOSE 4000
CMD ["node", "dist/index.js"]
