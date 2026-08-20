FROM node:20-alpine

WORKDIR /app

# Copy package files and Prisma configuration
COPY package*.json ./
COPY prisma.config.ts ./
COPY prisma ./prisma/

# Install all dependencies (including devDependencies required for build)
RUN npm ci

# Copy application source code
COPY . .

# Generate Prisma Client (Prisma v7) and compile NestJS app
RUN npx prisma generate
RUN npm run build

# Set production environment
ENV NODE_ENV=production

# Expose port (Railway overrides via PORT env)
EXPOSE 3000

# Run database migrations and start production server
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/src/main.js"]
