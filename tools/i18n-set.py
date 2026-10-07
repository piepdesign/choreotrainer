# Einträge in den Sprachdateien setzen oder ergänzen (im Ordner app/ ausführen):
#   python3 tools/i18n-set.py '<deutscher Schlüssel>' en='…' fr='…' es='…' it='…'
import sys, json, re
key, pairs = sys.argv[1], dict(a.split('=', 1) for a in sys.argv[2:])
for l, v in pairs.items():
    p = f'js/lang/{l}.js'; s = open(p).read()
    line = f'  {json.dumps(key, ensure_ascii=False)}: {json.dumps(v, ensure_ascii=False)},'
    pat = re.compile(r'^  ' + re.escape(json.dumps(key, ensure_ascii=False)) + r': .*,$', re.M)
    s = pat.sub(lambda m: line, s, 1) if pat.search(s) else s.replace('\n};\n', '\n' + line + '\n};\n', 1)
    open(p, 'w').write(s)
print('ok', key)
