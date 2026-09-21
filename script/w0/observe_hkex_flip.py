#!/usr/bin/env python3
"""
W0 risk #1 -- the binary that decides the demo.

Does the xStocks issuer API actually flip `currentPeriod` away from `market`
across the HKEX lunch recess (12:00-13:00 HKT), and does the applicable
primary order cap really become 0? And how long after the boundary?

HKEX published schedule (GET /exchanges/XHKG):
  Extended 09:00-09:30 | Regular 09:30-12:00 | Regular 13:00-16:00 | Extended 16:00-16:10
There is NO session covering 12:00-13:00. SGT == HKT == UTC+8.
The OKX Dev Day finale is 6 Oct 10:00-14:00 SGT, so the recess falls inside it.

History: the first copy ran under nohup on a MacBook and died when the laptop
entered clamshell sleep at 2026-09-12 20:12 UTC. This version is built to run
in a container on an always-on host.

Behaviour
- Appends JSONL to $OUT and prints every row to stdout, so host logs are a
  second copy of the evidence.
- Inside the transition windows it polls every 5s and writes EVERY row, so the
  lag between a boundary and the API flip can be measured to the second.
- Outside them it polls every 60s and writes on any state change, plus a
  heartbeat row whenever 600s have passed since the last write.
- Pings $HC_URL (healthchecks.io) after each successful snapshot, if set.
- Never dies on a network error. Python 3.9 compatible.
"""
import json, os, sys, time, urllib.request, datetime as dt

DEFAULT_OUT = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "artifacts", "w0", "hkex_flip.jsonl")
)
OUT = os.environ.get("OUT", DEFAULT_OUT)
HC_URL = os.environ.get("HC_URL", "").strip()
UA = {"User-Agent": "curb-w0-observer/1.0 (+research)"}
API = "https://api.xstocks.fi/api/v2/public"

HK_ASSETS = ["TCENTx", "XIAOx", "MEITx", "SHEINx"]   # XHKG, Regular mode
US_CONTROLS = ["NVDAx", "AAPLx"]                     # XNAS, TwentyFourFive -- the contrast panel
SYMBOLS = HK_ASSETS + US_CONTROLS

DEFAULT_DURATION_S = 21 * 86400
HEARTBEAT_S = 600
FAST_POLL_S = 5
SLOW_POLL_S = 60

# Dense-capture windows in UTC minutes-of-day, applied on weekdays.
#   00:50-01:40  HKEX pre-open and open (09:00, 09:30 HKT)
#   03:50-05:10  the recess (12:00 and 13:00 HKT) -- the one that decides the demo
#   07:50-08:20  HKEX close (16:00, 16:10 HKT)
#   23:50-24:00 and 00:00-00:10  US 20:00 ET, extended -> overnight
WINDOWS_UTC = [(0, 0, 0, 10), (0, 50, 1, 40), (3, 50, 5, 10), (7, 50, 8, 20), (23, 50, 24, 0)]


def get(path, timeout=20):
    req = urllib.request.Request(API + "/" + path, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, json.loads(r.read())


def utc_now():
    return dt.datetime.now(dt.timezone.utc)


def in_dense_window(now):
    # Weekday check in UTC. The 23:50-24:00 slot belongs to Sun-Thu evenings (US 20:00 ET
    # falls at 00:00Z on the following Mon-Fri), so it is allowed on Sunday too.
    mins = now.hour * 60 + now.minute
    for h0, m0, h1, m1 in WINDOWS_UTC:
        if h0 * 60 + m0 <= mins < h1 * 60 + m1:
            late_evening = h0 == 23
            if now.weekday() < 5 or (late_evening and now.weekday() == 6):
                return True
    return False


def snap():
    now = utc_now()
    row = {
        "ts": now.isoformat(),
        "hkt": (now + dt.timedelta(hours=8)).isoformat(),
        "dense": in_dense_window(now),
    }
    ok = False
    try:
        status, ex = get("exchanges/XHKG")
        row["xhkg"] = {
            "http": status,
            "isOpen": ex.get("isOpen"),
            "currentSession": ex.get("currentSession"),
            "nextChangeAt": ex.get("nextChangeAt"),
        }
        ok = True
    except Exception as e:
        row["xhkg_err"] = str(e)[:160]
    for sym in SYMBOLS:
        try:
            status, a = get("assets/" + sym + "?network=XLayer")
            t = a.get("trading", {}) or {}
            lim = t.get("limitsPerPeriod") or {}
            per = t.get("currentPeriod")
            cap = (lim.get(per) or {}).get("maxOrderFiatValue") if per else None
            row[sym] = {
                "http": status,
                "mode": t.get("tradingHoursMode"),
                "period": per,
                "openNow": t.get("openNow"),
                "nextChangeAt": t.get("nextChangeAt"),
                "applicableCap": cap,
                "halted": t.get("isTradingHalted"),
            }
            ok = True
        except Exception as e:
            row[sym + "_err"] = str(e)[:160]
    return row, ok


def ping_healthcheck():
    if not HC_URL:
        return
    try:
        urllib.request.urlopen(urllib.request.Request(HC_URL, headers=UA), timeout=10).read()
    except Exception:
        pass  # a failed ping must never stop the observation


def state_key(row):
    """The fields whose change is evidence. Excludes timestamps and HTTP status."""
    out = {}
    for k in SYMBOLS:
        v = row.get(k)
        if isinstance(v, dict):
            out[k] = {f: v.get(f) for f in ("period", "openNow", "applicableCap", "halted", "nextChangeAt")}
    x = row.get("xhkg")
    if isinstance(x, dict):
        out["xhkg"] = {f: x.get(f) for f in ("isOpen", "currentSession", "nextChangeAt")}
    return out


def main():
    duration = float(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_DURATION_S
    end = time.time() + duration
    d = os.path.dirname(OUT)
    if d:
        os.makedirs(d, exist_ok=True)
    print(json.dumps({"event": "start", "ts": utc_now().isoformat(), "out": OUT,
                      "duration_s": duration, "hc": bool(HC_URL)}), flush=True)

    last_state = None
    last_write = 0.0
    while time.time() < end:
        row, ok = snap()
        state = state_key(row)
        row["changed"] = last_state is not None and state != last_state
        if last_state is None:
            row["changed"] = True
        last_state = state

        write = row["dense"] or row["changed"] or (time.time() - last_write) >= HEARTBEAT_S
        print(json.dumps(row), flush=True)
        if write:
            try:
                with open(OUT, "a") as f:
                    f.write(json.dumps(row) + "\n")
                last_write = time.time()
            except Exception as e:
                print(json.dumps({"event": "write_error", "err": str(e)[:160]}), flush=True)
        if ok:
            ping_healthcheck()
        time.sleep(FAST_POLL_S if row["dense"] else SLOW_POLL_S)


if __name__ == "__main__":
    main()
