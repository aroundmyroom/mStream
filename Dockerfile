FROM node:24-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --g npm@latest
RUN npm install --production

COPY . .

EXPOSE 3000

CMD ["node", "cli-boot-wrapper.js"]
