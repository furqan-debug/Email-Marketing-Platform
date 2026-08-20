# Stage 1: Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files and Prisma schema
COPY package*.json ./
COPY prisma ./prisma/

# Install dependencies
RUN npm ci

# Copy full application source
COPY . .

# Generate Prisma Client (Prisma v7) and compile NestJS app
RUN npx prisma generate
RUN npm run build

# Stage 2: Production stage
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

# Copy package files, node_modules, compiled dist, and prisma files
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma

# Expose port (defaults to 3000, Railway will override via PORT env)
EXPOSE 3000

# Run database migrations and start NestJS production server
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/src/main.js"]
