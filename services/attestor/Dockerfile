FROM node:26-slim

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
