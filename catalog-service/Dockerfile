FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev --omit=optional

COPY . .

USER node

EXPOSE 4001

CMD ["node", "src/index.js"]