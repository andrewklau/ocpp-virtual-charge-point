FROM node:18-alpine
RUN apk add --no-cache libc6-compat
WORKDIR /app
COPY . ./
RUN npm install

USER node
WORKDIR /app
ENV NODE_ENV production

EXPOSE 8080

CMD ["npx", "tsx", "index_multi.ts"]
