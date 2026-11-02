# Zostaví samostatné demo (jeden HTML súbor so simulovaným serverom)
import base64, re, pathlib
root = pathlib.Path(__file__).resolve().parent.parent
pub = root / 'public'
css = (pub / 'kros.css').read_text()
for f in ['Light', 'Medium', 'SemiBold']:
    b64 = base64.b64encode((pub / 'fonty' / f'Poppins-{f}.ttf').read_bytes()).decode()
    css = css.replace(f"url('fonty/Poppins-{f}.ttf')", f"url(data:font/ttf;base64,{b64})")
html = (pub / 'index.html').read_text()
fav = base64.b64encode((pub / 'favicon.svg').read_bytes()).decode()
html = html.replace('href="favicon.svg"', f'href="data:image/svg+xml;base64,{fav}"')
html = html.replace('<title>Vajíčka</title>', '<title>Vajíčka – demo</title>')
html = html.replace('<link rel="stylesheet" href="kros.css">', f'<style>{css}</style>')
html = html.replace('<link rel="stylesheet" href="app.css">', '<style>' + (pub / 'app.css').read_text() +
    '\n.demo{background:var(--kros-doplnkova-bezova);color:var(--kros-modra);text-align:center;font-size:.75rem;font-weight:500;padding:4px}</style>')
html = html.replace('<header class="top">', '<div class="demo">Demo – objednávky sú vymyslené, nič sa neukladá</div>\n<header class="top">')
people = root / 'people.json'
seed = f"<script>window.DEMO_PEOPLE={people.read_text()};</script>\n" if people.exists() else ''
html = html.replace('<script src="app.js"></script>', seed +
    '<script>' + (root / 'demo' / 'mock.js').read_text() + '</script>\n<script>' + (pub / 'app.js').read_text() + '</script>')
(root / 'demo' / 'vajicka-demo.html').write_text(html)
print('ok', len(html))
