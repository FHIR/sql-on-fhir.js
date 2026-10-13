# Build the Tailwind stylesheet, which needs the dev dependencies.
FROM oven/bun:alpine AS css
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY src/ ./src/
COPY public/ ./public/
RUN bunx tailwindcss -i ./public/app.css -o ./public/app.build.css --minify

FROM oven/bun:alpine

# Set working directory
WORKDIR /app

# Copy package files
COPY package.json bun.lock ./

# Install production dependencies
RUN bun install --frozen-lockfile --production

# Copy application files
COPY src/ ./src/
COPY metadata/ ./metadata/
COPY public/ ./public/
COPY tailwind.config.js ./
COPY --from=css /app/public/app.build.css ./public/

# Create a non-root user
RUN addgroup -g 1001 -S bunuser && \
    adduser -S bunuser -u 1001 && \
    chown -R bunuser:bunuser /app

# Switch to non-root user
USER bunuser

# Expose port
EXPOSE 3000

# Set environment
ENV NODE_ENV=production

# Start the server
CMD ["bun", "run", "server"]
