FROM node:24-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --g npm@latest
RUN npm install --production

COPY . .

# Pre-create runtime directories so SQLite and the config writer
# can initialise even when no volume is mounted on first start.
RUN mkdir -p save/conf save/db save/logs save/sync image-cache waveform-cache

EXPOSE 3000

CMD ["node", "cli-boot-wrapper.js"]
