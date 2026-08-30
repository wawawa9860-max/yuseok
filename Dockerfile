# RF CIP Mobile Field Control — 운영 컨테이너 (PHASE 15)
# Railway/Render 등 클라우드가 이 파일 하나로 서버를 만든다.
# 사용자가 직접 빌드할 일은 없다 — docs/CLOUD_DEPLOY_GUIDE.md 참고.
FROM node:20-slim AS build
WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci
COPY server/ ./
RUN npx tsc -p tsconfig.json

FROM node:20-slim
ENV NODE_ENV=production
WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/server/dist ./dist
# 마이그레이션 SQL 과 모바일 앱은 저장소 경로 그대로 쓴다
COPY db/ /app/db/
COPY web/ /app/web/
# 업로드 파일 저장 위치 (클라우드 볼륨을 여기에 붙인다)
RUN mkdir -p /app/storage
EXPOSE 3000
# 시작하면 마이그레이션 → 첫 계정 부트스트랩 → 서버가 순서대로 돈다 (index.ts)
CMD ["node", "dist/index.js"]
