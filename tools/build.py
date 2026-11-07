#!/usr/bin/env python3
"""
FF Cash Battle - speed build.   Run after EVERY edit:   python3 tools/build.py

What it does (UI and behaviour stay exactly the same):
  1. index.src.html  ->  index.html with all 32 HTML pieces (data-include) already inside  (32 requests less)
  2. all local CSS files -> ONE css/app.css                                                  (37 requests -> 1)
  3. every relative JS import gets ?v=<hash of your files>  -> files can be cached for a year
     (a new hash after each edit means users always get the new code)
  4. <link rel="modulepreload"> for the whole JS graph + Firebase SDK -> JS downloads in parallel, not one-after-another
  5. sw.js gets the same hash (cache name)
Edit the SOURCE files (index.src.html, css/*, js/*, pages/*, components/*) - never index.html / css/app.css by hand.
"""
import hashlib, os, re, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'index.src.html'
OUT = ROOT / 'index.html'
CSS_OUT = ROOT / 'css' / 'app.css'

# relative JS specifiers:  from './x.js'   import './x.js'   import('./x.js')   (query string replaced)
SPEC = re.compile(r"""(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.{1,2}/[^'"\s?]+?\.js)(\?[^'"]*)?\2""")
INCLUDE = re.compile(r'<div data-include="([^"]+)"></div>')

def read(p): return Path(p).read_text(encoding='utf-8')

def js_files():
    for p in sorted(ROOT.rglob('*.js')):
        rel = p.relative_to(ROOT).as_posix()
        if rel == 'sw.js' or rel.startswith('tools/') or 'node_modules' in rel: continue
        yield p

def fragments():
    for p in sorted(ROOT.rglob('*.html')):
        rel = p.relative_to(ROOT).as_posix()
        if rel in ('index.html', 'index.src.html') or rel == 'pages/game/coin.html' or rel.startswith('tools/'): continue
        yield p

def css_list(src):
    m = re.search(r'<!--BUILD:CSS-->(.*?)<!--/BUILD:CSS-->', src, re.S)
    return m, re.findall(r'<link rel="stylesheet" href="([^"?]+\.css)(?:\?[^"]*)?">', m.group(1))

def compute_version(src):
    h = hashlib.sha256()
    h.update(src.encode())
    for p in js_files():
        h.update(p.relative_to(ROOT).as_posix().encode()); h.update(SPEC.sub(lambda m: m.group(1) + m.group(2) + m.group(3) + m.group(2), read(p)).encode())
    for p in fragments():
        h.update(p.relative_to(ROOT).as_posix().encode()); h.update(read(p).encode())
    _, css = css_list(src)
    for c in css:
        h.update(c.encode()); h.update(read(ROOT / c).encode())
    return h.hexdigest()[:10]

def bundle_css(files):
    parts = []
    for rel in files:
        p = ROOT / rel
        txt = read(p)
        txt = re.sub(r'/\*.*?\*/', '', txt, flags=re.S)                       # comments out
        def fix(m):
            q, u = m.group(1), m.group(2).strip()
            if re.match(r'(data:|https?:|//|/|#)', u): return m.group(0)
            path, _, tail = u.partition('?')
            new = os.path.relpath((p.parent / path).resolve(), CSS_OUT.parent.resolve()).replace(os.sep, '/')
            return 'url(' + q + new + ('?' + tail if tail else '') + q + ')'
        txt = re.sub(r'url\((["\']?)([^)"\']+)\1\)', fix, txt)
        txt = '\n'.join(l.rstrip() for l in txt.split('\n') if l.strip())    # blank lines out
        parts.append('/* == ' + rel + ' == */\n' + txt)
    CSS_OUT.write_text('\n'.join(parts) + '\n', encoding='utf-8')

def rewrite_js(v):
    n = 0
    for p in js_files():
        s = read(p)
        t = SPEC.sub(lambda m: m.group(1) + m.group(2) + m.group(3) + '?v=' + v + m.group(2), s)
        if t != s: p.write_text(t, encoding='utf-8'); n += 1
    return n

def module_graph(entries):
    seen, order, q = set(), [], list(entries)
    while q:
        rel = q.pop(0)
        if rel in seen: continue
        seen.add(rel); order.append(rel)
        p = ROOT / rel
        if not p.exists(): sys.exit('MISSING import target: ' + rel)
        for m in SPEC.finditer(read(p)):
            q.append(os.path.normpath((p.parent / m.group(3)).relative_to(ROOT) if False else os.path.relpath((p.parent / m.group(3)).resolve(), ROOT.resolve())).replace(os.sep, '/'))
    return order

def main():
    src = read(SRC)
    v = compute_version(src)

    # 3. JS imports -> versioned
    changed = rewrite_js(v)

    # 2. CSS bundle
    m, css = css_list(src)
    bundle_css(css)
    html = src.replace(m.group(0), '<link rel="stylesheet" href="css/app.css?v=' + v + '">')

    # 1. inline every data-include piece
    count = 0
    def inc(mm):
        nonlocal count; count += 1
        return read(ROOT / mm.group(1)).rstrip('\n')
    while INCLUDE.search(html): html = INCLUDE.sub(inc, html)

    # versioned classic scripts + entry module
    html = re.sub(r'(<script[^>]*\bsrc=")(js/[^"?]+\.js)(\?[^"]*)?(")', lambda mm: mm.group(1) + mm.group(2) + '?v=' + v + mm.group(4), html)

    # 4. preload the module graph + Firebase SDK
    graph = module_graph(['js/main.js', 'js/modules.js'])
    firebase = re.findall(r'https://www\.gstatic\.com/firebasejs/[^"\']+\.js', read(ROOT / 'js/core/firebase.js'))
    pre = ['    <link rel="modulepreload" href="' + u + '" crossorigin>' for u in dict.fromkeys(firebase)]
    pre += ['    <link rel="modulepreload" href="' + g + '?v=' + v + '">' for g in graph]
    html = html.replace('<!--BUILD:PRELOAD-->', '\n'.join(pre))

    OUT.write_text(html, encoding='utf-8')

    # 5. service worker cache name
    sw = ROOT / 'sw.js'; s = read(sw)
    s = re.sub(r"const STATIC = '[^']*';", "const STATIC = 'ffcb-static-" + v + "';", s); sw.write_text(s, encoding='utf-8')

    print('build', v, '| includes inlined:', count, '| css files bundled:', len(css), '| js modules versioned/preloaded:', len(graph),
          '| index.html %.0f KB, app.css %.0f KB' % (OUT.stat().st_size / 1024, CSS_OUT.stat().st_size / 1024))

if __name__ == '__main__':
    main()
