FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

# The database file lives on a mounted volume so it survives container
# restarts and re-deploys.
ENV SHOT_DB_PATH=/data/shotnumbers.db \
    ALLOW_FAILURE_INJECTION=false

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
