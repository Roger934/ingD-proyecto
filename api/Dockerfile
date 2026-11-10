# API del e-commerce (rol app). Se construye con: cd roles/app && docker compose build
FROM node:22.12.0-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
# /estado: volumen del vigilante (al montarse vacío hereda este dueño)
RUN mkdir -p /estado && chown node:node /estado
USER node
EXPOSE 8080
CMD ["node", "src/index.js"]
