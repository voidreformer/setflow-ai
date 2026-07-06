# Use official Node.js Alpine base image
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Copy dependency files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --omit=dev

# Copy application source files
COPY public/ ./public/
COPY db.js ./
COPY server.js ./

# Create data directory for persistent SQLite database
RUN mkdir -p /app/data

# Expose server port
EXPOSE 3000

# Set environment defaults
ENV PORT=3000
ENV NODE_ENV=production
ENV DATABASE_PATH=/app/data/appointment_setter.db

# Command to run the application
CMD ["node", "server.js"]
