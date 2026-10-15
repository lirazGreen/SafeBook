FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
COPY config ./config
# The spec is loaded at boot and ENFORCED at runtime, so it is part of the
# image rather than documentation that can be left behind. Its absence crashed
# the container on startup.
COPY openapi.yaml ./openapi.yaml
