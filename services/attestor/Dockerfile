# Pinned by digest to node:26-slim as the VPS has cached it since 9 Sep 2026 (Node 26.8.2), the runtime host B
# and the keeper have run on since September. A bare tag is re-resolved at build time (on Railway, and by the
# VPS's containerd image store), which would change Node in the same step as a code change and pull a new base
# onto a nearly full disk. Move it on purpose, with the suites run in the new image first.
FROM node:26-slim@sha256:14bf3eac4bf209d906d3c41256597d3ab1f926b2e93a79e9bdfe1efd32454239

# TZ=UTC is a convenience for log readability only. Correctness does not depend on it: regime.ts reads
# venue-local time with Intl.DateTimeFormat, and the test suite runs under four host timezones.
ENV TZ=UTC \
    NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8080

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY src ./src

EXPOSE 8080
CMD ["node", "--experimental-strip-types", "src/main.ts"]
