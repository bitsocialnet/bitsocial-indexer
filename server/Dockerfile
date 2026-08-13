FROM node:22-slim

# better-sqlite3 compiles a native addon.
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

COPY . .

ENV NODE_ENV=production
EXPOSE 4000
CMD ["npm", "start"]
