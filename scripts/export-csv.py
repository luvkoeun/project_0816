#!/usr/bin/env python3
"""Supabase 에 쌓인 사용 기록을 CSV 로 내려받습니다.

쓰는 법 (PowerShell):

    $env:SUPABASE_URL = "https://<프로젝트>.supabase.co"
    $env:SUPABASE_SERVICE_KEY = "<service_role 키>"
    python scripts/export-csv.py

service_role 키는 RLS 를 우회하는 비밀 키입니다. 파일에 적어 커밋하지 말고
위처럼 환경변수로만 넘기세요. 대시보드 > Project Settings > API 에 있습니다.

설치할 패키지는 없습니다. 파이썬 표준 라이브러리만 씁니다.
"""

import csv
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import date
from pathlib import Path

TABLES = ["sessions", "swipes", "picks", "feedback", "session_summary"]
PAGE_SIZE = 1000  # PostgREST 가 한 번에 주는 최대치


def fail(message):
    print(f"\n[export] {message}\n", file=sys.stderr)
    raise SystemExit(1)


def read_config():
    url = (os.environ.get("SUPABASE_URL") or "").strip()
    key = (os.environ.get("SUPABASE_SERVICE_KEY") or "").strip()
    if not url or not key:
        fail(
            "환경변수가 없습니다.\n"
            '  $env:SUPABASE_URL = "https://<프로젝트>.supabase.co"\n'
            '  $env:SUPABASE_SERVICE_KEY = "<service_role 키>"'
        )
    # 앱과 같은 규칙으로 끝의 /rest/v1 과 슬래시를 떼어냅니다.
    url = url.rstrip("/")
    if url.lower().endswith("/rest/v1"):
        url = url[: -len("/rest/v1")].rstrip("/")
    return url, key


def fetch_page(url, key, table, offset):
    request = urllib.request.Request(
        f"{url}/rest/v1/{table}?select=*&order=created_at.asc"
        f"&limit={PAGE_SIZE}&offset={offset}",
        headers={"apikey": key, "Authorization": f"Bearer {key}"},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", "replace")[:200]
        if error.code == 404:
            return None  # 표가 없으면 건너뜁니다.
        if error.code in (401, 403):
            fail(f"{table}: 키가 거부됐습니다({error.code}). service_role 키가 맞는지 확인하세요.")
        fail(f"{table}: 요청 실패({error.code}) {body}")
    except urllib.error.URLError as error:
        fail(f"{table}: 서버에 닿지 못했습니다 ({error.reason}).")


def fetch_all(url, key, table):
    rows, offset = [], 0
    while True:
        page = fetch_page(url, key, table, offset)
        if page is None:
            return None
        rows.extend(page)
        if len(page) < PAGE_SIZE:
            return rows
        offset += PAGE_SIZE


def flatten(value):
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, list):
        # cuisines, tags 같은 배열은 세미콜론으로 이어 붙입니다.
        return "; ".join(str(item) for item in value)
    if isinstance(value, (dict,)):
        return json.dumps(value, ensure_ascii=False)
    return str(value)


def write_csv(path, rows):
    # utf-8-sig 로 써야 엑셀에서 한글이 깨지지 않습니다.
    columns = list(dict.fromkeys(key for row in rows for key in row))
    with open(path, "w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns)
        writer.writeheader()
        for row in rows:
            writer.writerow({column: flatten(row.get(column)) for column in columns})
    return columns


def main():
    url, key = read_config()
    out_dir = Path(__file__).resolve().parent.parent / "export" / date.today().isoformat()
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"[export] {url}")
    print(f"[export] 저장 위치: {out_dir}\n")

    total = 0
    for table in TABLES:
        rows = fetch_all(url, key, table)
        if rows is None:
            print(f"  {table:<16} 건너뜀 (표 없음)")
            continue
        if not rows:
            print(f"  {table:<16} 0건 — 파일을 만들지 않았습니다")
            continue
        path = out_dir / f"{table}.csv"
        columns = write_csv(path, rows)
        total += len(rows)
        print(f"  {table:<16} {len(rows):>5}건  ({len(columns)}개 열)  -> {path.name}")

    print(f"\n[export] 총 {total}건 저장했습니다.")
    if total:
        print("[export] 엑셀로 열면 됩니다. 한글이 깨지지 않도록 BOM 을 넣어 저장했습니다.")


if __name__ == "__main__":
    main()
