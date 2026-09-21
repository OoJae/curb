FROM python:3.9-slim

ENV PYTHONUNBUFFERED=1 \
    TZ=UTC \
    OUT=/data/hkex_flip.jsonl

WORKDIR /app
COPY observe_hkex_flip.py /app/observe_hkex_flip.py

# 21 days of observation; the script appends, so a restart loses nothing already written.
CMD ["python", "-u", "/app/observe_hkex_flip.py", "1814400"]
