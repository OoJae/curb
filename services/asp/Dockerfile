# Pinned by digest to the node:26-slim that Railway resolved for the deployment of 25 Sep 2026 (02f64cd2), the
# runtime curb-asp has run on since. A bare tag is re-resolved at build time, which would change Node in the same
# step as a code change. Move it on purpose, with the suites run in the new image first.
FROM node:26-slim@sha256:ec7758ee051e457b468b32bde57b0879010b325bb9862718e9615225ce4aaae1

# TZ=UTC is a convenience for log readability only. Correctness does not depend on it: the calendar reads
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
