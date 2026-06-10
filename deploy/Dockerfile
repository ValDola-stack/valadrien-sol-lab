# Containerized health check runner — alternative to the systemd unit.
#
# Build:  docker build -f deploy/Dockerfile -t valadrien-health-runner .
# Run:    docker run -d --name health-runner --restart=always \
#           --env-file .env valadrien-health-runner
# Logs:   docker logs -f health-runner
#
# The image carries no secrets; all config is injected at runtime via --env-file
# (see deploy/README.md for the required variables).

FROM node:22-alpine

WORKDIR /app

# Install deps first for layer caching. Only runtime deps are needed; tsx +
# typescript are devDependencies, so install everything (the runner executes
# TypeScript directly via tsx).
COPY package.json package-lock.json ./
RUN npm ci

# App sources.
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts

# Restart-on-failure is handled by the container runtime (--restart=always) or
# the orchestrator; the runner itself also loops forever.
CMD ["npm", "run", "health-check:run"]
