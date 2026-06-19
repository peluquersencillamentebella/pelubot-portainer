FROM node:20-bullseye-slim

# Instalar git y dependencias necesarias para baileys
RUN apt-get update && apt-get install -y \
    git \
    python3 \
    make \
    g++ \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./

# Instalar con legacy-peer-deps para evitar conflictos
RUN npm install --production --legacy-peer-deps

COPY . .

RUN mkdir -p /app/data /app/auth_info

EXPOSE 3000

CMD ["node", "index.js"]
