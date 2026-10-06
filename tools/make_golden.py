"""
Generate SYNTHETIC LibreView fixtures and golden outputs from the Python reference
parser (reference/libreview_parser.py). The JavaScript importer must reproduce the
golden outputs exactly (tests/importer.test.js).

Run from the repository root:   python3 tools/make_golden.py
No real personal data is used. The 'account name' in fixtures is a made-up persona.
"""

import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "reference"))

from libreview_parser import AmbiguousDateFormat, ParseError, parse_libreview  # noqa: E402
from test_libreview_parser import HEADER_MG, HEADER_MMOL, build, row, us_ts  # noqa: E402

FIX = os.path.join(ROOT, "tests", "fixtures")
GOLD = os.path.join(ROOT, "tests", "golden")
os.makedirs(FIX, exist_ok=True)
os.makedirs(GOLD, exist_ok=True)


def autos_us(day, start_h, n, step=15, base=100):
    out, minutes = [], start_h * 60
    for i in range(n):
        m = minutes + i * step
        out.append(row(us_ts(day, m // 60 % 24, m % 60), 0, hist=str(base + (i * 3) % 40)))
    return out


cases = {}

# 1. US 12-hour, mg/dL: mixed record types, jitter, a long gap, duplicates, empty rows
rows = autos_us(14, 6, 8)
rows += [row(us_ts(14, 8, 3), 1, scan="111"), row(us_ts(14, 8, 4), 6), row(us_ts(14, 8, 4), 6)]
rows += [row(us_ts(14, 12, 30), 5, food_marker="1"), row(us_ts(14, 12, 31), 6, notes="lunch, light")]
rows += [row(us_ts(14, 12, 40), 4, rapid="6"), row(us_ts(14, 22, 0), 4, long_u="14")]
rows += [row(us_ts(14, 9, 0), 0, strip="105")]
dup = row(us_ts(15, 7, 0), 0, hist="99")
rows += [dup, dup]
rows += [row(us_ts(15, 7, 17), 0, hist="101"), row(us_ts(15, 9, 40), 0, hist="130")]   # 143 min gap
cases["us_basic"] = dict(data=build(rows), tz="America/New_York")

# 2. UK 24-hour, mmol/L
rows = [row(f"14-09-2022 {8 + i // 4:02d}:{(i % 4) * 15:02d}", 0, hist=f"{5.0 + (i % 7) * 0.4:.1f}") for i in range(12)]
rows += [row("14-09-2022 09:50", 1, scan="7.2"), row("14-09-2022 10:00", 5, carbs="45")]
cases["uk_mmol"] = dict(data=build(rows, header=HEADER_MMOL, gen="17-09-2022 15:40 UTC"), tz="Europe/London")

# 3. Semicolon + decimal comma
rows = [row("14-09-2022 08:00", 0, hist="5,5"), row("14-09-2022 08:15", 0, hist="6,1")]
cases["semicolon_comma"] = dict(data=build(rows, header=HEADER_MMOL, delim=";", gen="17-09-2022 15:40 UTC"), tz="Europe/London")

# 4. Tab delimited
rows = [row("14-09-2022 08:00", 0, hist="5.5"), row("14-09-2022 08:15", 0, hist="6.1")]
cases["tab"] = dict(data=build(rows, header=HEADER_MMOL, delim="\t", gen="17-09-2022 15:40 UTC"), tz="Europe/London")

# 5. Provider export (name + DOB row must vanish)
rows = [row("7/14/2021 8:00", 0, hist="100"), row("7/14/2021 8:15", 0, hist="101"), row("7/14/2021 20:00", 0, hist="99")]
cases["provider"] = dict(data=build(rows, meta="provider", gen="07-20-2021 02:05 PM UTC"), tz="America/New_York")

# 6. Ambiguous day/month, resolved by 'Generated on'
rows = [row("03-04-2023 08:00", 0, hist="100"), row("04-04-2023 08:00", 0, hist="101"), row("05-04-2023 08:00", 0, hist="102")]
cases["ambiguous_resolved"] = dict(data=build(rows, gen="06-04-2023 10:00 AM UTC"), tz="Europe/London")

# 7. Truly ambiguous -> error, then forced format
rows = [row("03-04-2023 08:00", 0, hist="100"), row("04-04-2023 08:00", 0, hist="101")]
cases["ambiguous_error"] = dict(data=build(rows, gen="20-09-2023 10:00 AM UTC"), tz="Europe/London")
cases["ambiguous_forced"] = dict(data=build(rows, gen="20-09-2023 10:00 AM UTC"), tz="Europe/London", date_format="%d-%m-%Y %H:%M")

# 8. London daylight saving
rows = [row("26-03-2023 01:30", 0, hist="100"), row("29-10-2023 01:30", 0, hist="101"),
        row("15-06-2023 12:00", 0, hist="102"), row("29-10-2023 02:30", 0, hist="103")]
cases["dst_london"] = dict(data=build(rows, gen="30-10-2023 09:00 UTC"), tz="Europe/London")

# 9. HI/LO text, wrong-length row, unknown extra column
hdr = HEADER_MG + ",Mystery Column"
rows = [row(us_ts(14, 8, 0), 0, hist="HI") + ["x"], row(us_ts(14, 8, 15), 0, hist="LO") + ["y"],
        row(us_ts(14, 8, 30), 0, hist="88") + ["z"]]
raw = build(rows, header=hdr)
raw += b"short,row\n"
cases["hilo_unknown_col"] = dict(data=raw, tz="America/New_York")

# 10. Libre 3 style device name
rows = [row("07-14-2021 08:00 AM", 0, device="FreeStyle Libre 3", hist="100"),
        row("07-14-2021 08:15 AM", 0, device="FreeStyle Libre 3", hist="104")]
cases["libre3_name"] = dict(data=build(rows), tz="America/New_York")

# 11. Error cases
cases["err_empty"] = dict(data=b"", tz="Europe/London")
cases["err_no_header"] = dict(data=b"a,b,c\n1,2,3\n", tz="Europe/London")
cases["err_no_glucose"] = dict(
    data=b"Device,Serial Number,Device Timestamp,Record Type,Notes\nx,y,07-14-2021 08:00 AM,6,hi\n",
    tz="Europe/London")

manifest = []
for name, c in cases.items():
    fname = f"{name}.csv"
    with open(os.path.join(FIX, fname), "wb") as fh:
        fh.write(c["data"])
    entry = {"name": name, "file": fname, "tz": c["tz"], "date_format": c.get("date_format")}
    try:
        res = parse_libreview(c["data"], tz_name=c["tz"], date_format=c.get("date_format"))
        events = [{
            "kind": e.kind,
            "local": e.local_time.isoformat(sep=" "),
            "utc": e.utc_time.isoformat(),
            "source_row": e.source_row,
            "row_hash": e.row_hash,
            "device": e.device,
            "serial": e.serial,
            "flags": e.flags,
            "data": e.data,
        } for e in res.events]
        entry["expect"] = "ok"
        golden = {"report": res.report, "events": events, "file_hash": res.file_hash}
    except AmbiguousDateFormat as ex:
        entry["expect"] = "ambiguous"
        golden = {"candidates": ex.candidates}
    except ParseError:
        entry["expect"] = "error"
        golden = {}
    with open(os.path.join(GOLD, f"{name}.json"), "w") as fh:
        json.dump(golden, fh, indent=1, sort_keys=True, default=str)
    manifest.append(entry)

with open(os.path.join(GOLD, "manifest.json"), "w") as fh:
    json.dump(manifest, fh, indent=1)
print(f"Wrote {len(manifest)} fixtures and golden outputs.")
