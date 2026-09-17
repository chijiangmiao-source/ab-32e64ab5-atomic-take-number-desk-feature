# syntax=docker/dockerfile:1

# 一次性验收服务镜像：Python（pytest，含并发/重启/故障注入用例）+ Node（Vitest）。
FROM node:20-slim AS node

FROM python:3.12-slim
COPY --from=node /usr/local /usr/local

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /verify

COPY api/requirements.txt api/requirements.txt
COPY tests/requirements.txt tests/requirements.txt
RUN pip install --no-cache-dir -r api/requirements.txt -r tests/requirements.txt

COPY web/package.json web/package-lock.json web/
RUN npm --prefix web ci

COPY api ./api
COPY tests ./tests
COPY web ./web
COPY verify/run.sh ./run.sh

CMD ["sh", "/verify/run.sh"]
