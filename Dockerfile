FROM node:22-alpine
WORKDIR /app
COPY . .
ENV NODE_ENV=production PORT=3000 TRUST_PROXY=1
VOLUME /app/data
EXPOSE 3000
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
