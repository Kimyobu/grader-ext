#!/usr/bin/env python3
"""
submit_all.py — ส่งไฟล์คำตอบทั้งหมดขึ้น POSN Grader

ใช้งาน:
    python3 submit_all.py                          # default: bwn28/6611, ส่งทุก .cpp
    python3 submit_all.py -u bwn28 -p 6611         # ระบุ user/รหัส
    python3 submit_all.py --lang python            # ส่งไฟล์ .py (language=python)
    python3 submit_all.py --ext .cpp --ext .py     # ส่งหลายนามสกุล
    python3 submit_all.py --dry-run                # แค่โชว์ว่าจะส่งอะไร ไม่ยิงจริง
    python3 submit_all.py --no-poll                # ไม่รอผลตรวจ (submit อย่างเดียว)
    python3 submit_all.py --report results.json    # path ไฟล์ผลลัพธ์

หลักการ:
  1) login -> ได้ token
  2) GET /api/challenges -> map {challenge_code: {title, testcases, ...}}
  3) หาไฟล์ในเครื่องที่ชื่อ (stem) ตรงกับ challenge_code แล้ว POST /api/submit
  4) poll /api/submit_status/<job_id> จนได้คะแนน แล้วสรุปผล
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

BASE = "https://grader.krusomchai.online"


# --------------------------------------------------------------------------- #
# HTTP helpers
# --------------------------------------------------------------------------- #
def _request(method, path, payload=None, timeout=60):
    data = json.dumps(payload).encode() if payload is not None else None
    headers = {"Origin": BASE, "Referer": BASE + "/"}
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        body = r.read().decode("utf-8", "replace")
    return json.loads(body) if body else {}


def login(username, password):
    resp = _request("POST", "/api/login", {"username": username, "password": password})
    if not resp.get("success"):
        sys.exit(f"login ไม่สำเร็จ: {resp}")
    print(f"login สำเร็จ: user={resp.get('username')} "
          f"classroom={resp.get('classroom')} role={resp.get('role')}")
    return resp["token"]


def fetch_challenges():
    resp = _request("GET", "/api/challenges")
    return {c["code"]: c for c in resp.get("challenges", [])}


def submit(token, code, meta, source, language, is_async=True):
    payload = {
        "code": source,
        "testcases": meta.get("testcases", []),
        "challenge_code": code,
        "challenge_title": meta.get("title", ""),
        "token": token,
        "language": language,
        "async": is_async,
    }
    return _request("POST", "/api/submit", payload)


def submit_status(job_id):
    return _request("GET", f"/api/submit_status/{job_id}")


# --------------------------------------------------------------------------- #
# File discovery
# --------------------------------------------------------------------------- #
def collect_files(root, extensions, challenges, include_all):
    """คืน (jobs, skipped) โดย job = (code, relpath, abs_path)"""
    jobs, skipped = [], []
    exts = tuple(extensions)
    for dirpath, _dirs, files in os.walk(root):
        for name in sorted(files):
            if not name.endswith(exts):
                continue
            stem, ext = os.path.splitext(name)
            path = os.path.join(dirpath, name)
            rel = os.path.relpath(path, root)
            language = "python" if ext == ".py" else "cpp"
            if stem not in challenges and not include_all:
                skipped.append(rel)
                continue
            jobs.append((stem, rel, path, language))
    return jobs, skipped


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #
def main():
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser(description="Submit all solutions to POSN Grader")
    ap.add_argument("-u", "--user", default="bwn28")
    ap.add_argument("-p", "--password", default="6611")
    ap.add_argument("--root", default=here, help="โฟลเดอร์รากที่เก็บไฟล์ (default: ที่อยู่สคริปต์)")
    ap.add_argument("--ext", action="append", default=None,
                    help="นามสกุลไฟล์ที่จะส่ง (ใส่ซ้ำได้) default: .cpp")
    ap.add_argument("--lang", choices=["cpp", "python"], default=None,
                    help="บังคับ language ตอน submit (ถ้าไม่ใส่จะเดาจากนามสกุล)")
    ap.add_argument("--include-all", action="store_true",
                    help="ส่งไฟล์ที่ไม่ตรง challenge_code ด้วย (ใช้ challenge_code=stem)")
    ap.add_argument("--no-poll", action="store_true", help="ไม่รอผลตรวจ")
    ap.add_argument("--poll-timeout", type=int, default=120, help="วินาทีที่รอผลตรวจ")
    ap.add_argument("--dry-run", action="store_true", help="ไม่ยิง request จริง")
    ap.add_argument("--report", default=os.path.join(here, "submit_results.json"))
    args = ap.parse_args()

    extensions = args.ext or [".cpp"]
    for e in extensions:
        if not e.startswith("."):
            e = "." + e

    # --- login + challenges ---
    if args.dry_run:
        print("(dry-run) ไม่ login — ใช้ challenges จาก API เพื่อจับคู่เท่านั้น")
        token = None
        challenges = fetch_challenges() if not args.dry_run else _dry_challenges()
    else:
        token = login(args.user, args.password)
        challenges = fetch_challenges()
    print(f"โหลด challenges: {len(challenges)} ข้อ\n")

    # --- discover files ---
    jobs, skipped = collect_files(args.root, extensions, challenges, args.include_all)
    print(f"พบไฟล์ที่จะส่ง {len(jobs)} ไฟล์ | ข้าม {len(skipped)} ไฟล์ "
          f"(นามสกุล {', '.join(extensions)})")
    if skipped:
        for s in skipped:
            print("  skip:", s)

    if args.dry_run:
        print("\nจะส่งต่อไปนี้:")
        for code, rel, _path, lang in jobs:
            print(f"  {code:6s} {rel:35s} lang={args.lang or lang}")
        return

    if not jobs:
        print("ไม่มีไฟล์ให้ส่ง")
        return

    # --- submit ---
    print()
    results = []
    for code, rel, path, lang in jobs:
        language = args.lang or lang
        meta = challenges.get(code, {"title": code, "testcases": []})
        try:
            source = open(path, encoding="utf-8", errors="replace").read()
            resp = submit(token, code, meta, source, language)
            results.append({"code": code, "file": rel, "job_id": resp.get("job_id"),
                            "submit": resp})
            print(f"[submit] {code:6s} {rel:35s} -> success={resp.get('success')} "
                  f"job={resp.get('job_id')}")
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "replace")[:300]
            results.append({"code": code, "file": rel, "error": body, "http": e.code})
            print(f"[submit] {code:6s} {rel:35s} FAILED http={e.code} {body}")

    # --- poll ---
    if not args.no_poll:
        pending = {r["job_id"]: r for r in results if r.get("job_id")}
        deadline = time.time() + args.poll_timeout
        while pending and time.time() < deadline:
            for jid in list(pending):
                try:
                    st = submit_status(jid)
                except Exception:
                    continue
                if st.get("completed_at"):
                    pending.pop(jid)["status"] = st
            if pending:
                time.sleep(3)

    # --- summary ---
    print("\n===== RESULTS =====")
    perfect = []
    zero = []
    other = []
    for r in results:
        st = r.get("status") or {}
        res = st.get("result") or {}
        if res:
            got, mx = res.get("passed"), res.get("max_score")
            r["score"] = f"{got}/{mx}"
            if got == mx:
                perfect.append(r["code"])
            elif got == 0:
                zero.append(r["code"])
            else:
                other.append((r["code"], f"{got}/{mx}"))
            print(f"{r['code']:6s} {r['file']:35s} score={got}/{mx}")
        elif r.get("job_id"):
            print(f"{r['code']:6s} {r['file']:35s} status=queued (ยังไม่เสร็จ)")
        else:
            print(f"{r['code']:6s} {r['file']:35s} ERROR {str(r.get('error'))[:100]}")

    print(f"\nสรุป: เต็ม {len(perfect)} ข้อ | 0 คะแนน {len(zero)} ข้อ | "
          f"บางส่วน {len(other)} ข้อ")
    if perfect:
        print("  SCORE MAX:", " ".join(sorted(perfect)))
    if other:
        print("  บางส่วน :", ", ".join(f"{c}={s}" for c, s in sorted(other)))

    with open(args.report, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)
    print(f"\nบันทึกผลไว้ที่: {args.report}")


def _dry_challenges():
    """สำหรับ dry-run ตอนเน็ตใช้อ่าน challenges ไม่ได้"""
    try:
        return fetch_challenges()
    except Exception as e:
        print(f"เตือน: ดึง challenges ไม่ได้ ({e}) — จะจับคู่จากชื่อไฟล์เท่านั้น")
        return {}


if __name__ == "__main__":
    main()
