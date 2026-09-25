FROM node:26-slim

# TZ=UTC is a convenience for log readability only. Correctness does not depend on it: venue times are read
# with Intl.DateTimeFormat in the venue's own zone, and the test suite runs under four host timezones.
# TRUST_PROXY_HOPS=1: behind Railway's edge the client is the last X-Forwarded-For entry (rateLimit.ts).
# Nothing here is secret, and the service needs no volume: all of its state is in memory.
ENV TZ=UTC \
    NODE_ENV=production \
    PORT=8080 \
    TRUST_PROXY_HOPS=1

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY src ./src

EXPOSE 8080
CMD ["node", "--experimental-strip-types", "src/main.ts"]
