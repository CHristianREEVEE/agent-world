FROM node:22-alpine

WORKDIR /app

# 安装依赖
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

# 拷贝代码
COPY server/src ./src
COPY web /app/web
COPY worlds /app/worlds

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/app/data

VOLUME ["/app/data"]
EXPOSE 3000

CMD ["node", "src/index.js"]
