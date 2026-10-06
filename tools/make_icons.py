"""Generate simple PNG app icons (a drop on teal) with no dependencies."""
import math, struct, zlib, os
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def drop_coverage(px, py, s):
    cx = s / 2
    cy_circle = s * 0.60
    r = s * 0.22
    tip = (cx, s * 0.20)
    d = cy_circle - tip[1]
    theta = math.asin(r / d)
    inside_circle = (px - cx) ** 2 + (py - cy_circle) ** 2 <= r * r
    y_tangent = tip[1] + math.sqrt(d * d - r * r) * math.cos(theta)   # cone stops where it touches the circle
    inside_cone = tip[1] <= py <= y_tangent and abs(px - cx) <= (py - tip[1]) * math.tan(theta)
    return inside_circle or inside_cone

def make(size, path):
    bg, fg = (15, 118, 110), (255, 255, 255)
    rows = []
    ss = 3
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            hit = sum(drop_coverage(x + (i + 0.5) / ss, y + (j + 0.5) / ss, size) for i in range(ss) for j in range(ss)) / (ss * ss)
            row += bytes(int(bg[k] * (1 - hit) + fg[k] * hit) for k in range(3)) + b"\xff"
        rows.append(bytes(row))
    raw = b"".join(rows)
    def chunk(t, d):
        c = struct.pack(">I", len(d)) + t + d
        return c + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    with open(path, "wb") as fh:
        fh.write(png)

for size in (180, 192, 512):
    make(size, os.path.join(ROOT, "assets", f"icon-{size}.png"))
print("icons written")
