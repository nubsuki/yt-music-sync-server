FROM node:20-alpine

WORKDIR /app

# Copy package files first for better layer caching
COPY package*.json ./
RUN npm ci --only=production

# Copy source
COPY . .

EXPOSE 3000

CMD ["node", "index.js"]
