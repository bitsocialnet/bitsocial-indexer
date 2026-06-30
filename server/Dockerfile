FROM node:22-slim

# better-sqlite3 compiles a native addon.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install

COPY . .

ENV NODE_ENV=production
EXPOSE 4000
CMD ["npm", "start"]
