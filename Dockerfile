FROM node:20-slim
WORKDIR /app
RUN corepack enable
COPY package.json ./
COPY tsconfig.json ./
COPY src ./src
COPY config ./config
COPY sql ./sql
RUN pnpm install
RUN pnpm build
ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
