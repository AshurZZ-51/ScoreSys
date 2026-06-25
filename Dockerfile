FROM node:20-alpine
WORKDIR /app
COPY . .
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
