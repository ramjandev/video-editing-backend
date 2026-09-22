# Stage 1: Build
FROM node:20-alpine AS builder

WORKDIR /app

# Install ffmpeg dependencies & system utilities if needed
RUN apk add --no-cache ffmpeg python3 make g++ linux-headers

# Copy package dependency manifests
COPY package*.json ./
COPY prisma ./prisma/
COPY prisma.config.ts ./

# Install all dependencies (including devDependencies for build)
RUN npm ci

# Copy backend source code
COPY . .

# Generate Prisma Client
RUN npx --no prisma generate

# Build NestJS production dist
RUN npm run build

# Stage 2: Production Runner
FROM node:20-alpine AS runner

WORKDIR /app

# Install system ffmpeg & font packages for video rendering stability
RUN apk add --no-cache ffmpeg font-dejavu ttf-freefont fontconfig

ENV NODE_ENV=production
ENV PORT=3000

# Copy node_modules & built files from builder stage
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./

# Create persistent uploads directory with node user ownership
RUN mkdir -p uploads && chown -R node:node /app/uploads

USER node

EXPOSE 3000

CMD ["npm", "run", "start:prod"]
