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

# Create a non-root user and the directory that holds $sql-export job output.
RUN addgroup -g 1001 -S bunuser && \
    adduser -S bunuser -u 1001 && \
    mkdir -p /app/export && \
    chown -R bunuser:bunuser /app

# Switch to non-root user
USER bunuser

# Expose port
EXPOSE 3000

# Set environment. EXPORT_DIR holds $sql-export job state and output files;
# mount a volume there (or set DB_PATH and EXPORT_DIR under one mount) to keep
# results across restarts.
ENV NODE_ENV=production
ENV EXPORT_DIR=/app/export

# Start the server
CMD ["bun", "run", "server"]
