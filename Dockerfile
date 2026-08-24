FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

ENV NEXT_STANDALONE=false
RUN npm run build

ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

# The application does not need to write to the image filesystem at runtime.
# Keep the image compatible with a read-only root filesystem and mount /tmp in
# the CCE workload for the small amount of temporary space Node may need.
RUN chown -R node:node /app
USER node

EXPOSE 3000

CMD ["npm", "run", "start"]
