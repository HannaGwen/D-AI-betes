"""Build a single self-contained HTML preview (demo data) from the real app code.
Needs the esbuild binary: set ESBUILD=/path/to/esbuild or have `npx esbuild` available.
Usage: python3 tools/build_preview.py out.html"""
import os, subprocess, sys, tempfile
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
out = sys.argv[1] if len(sys.argv) > 1 else "t1d-log-preview.html"
esbuild = os.environ.get("ESBUILD") or "esbuild"
with tempfile.TemporaryDirectory() as td:
    bundle = os.path.join(td, "bundle.js")
    subprocess.run([esbuild, os.path.join(ROOT, "preview", "entry.js"), "--bundle", "--minify", "--format=iife", "--target=safari15", f"--outfile={bundle}"], check=True)
    js = open(bundle, encoding="utf8").read().replace("</script", "<\\/script")
css = open(os.path.join(ROOT, "styles.css"), encoding="utf8").read()
css += "\n.demo-ribbon { background: #fde68a; color: #422006; font-size: 13px; padding: 6px 10px; text-align: center; }\n"
html = f"""<!doctype html>
<html lang="en-GB"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>T1D Log (demo preview)</title><style>{css}</style></head>
<body><div id="app"><p class="center muted">Loading demo…</p></div><script>{js}</script></body></html>"""
open(out, "w", encoding="utf8").write(html)
print(out, len(html), "bytes")
