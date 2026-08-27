FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=5000

COPY backend-new/package.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY backend-new ./
EXPOSE 5000
CMD ["npm", "start"]
