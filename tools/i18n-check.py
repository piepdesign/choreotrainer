# Übersetzungen prüfen (im Ordner app/ ausführen: python3 tools/i18n-check.py --check)
# Sammelt alle Schlüssel aus js/*.js: tr('…'), tn/plural(n, '…', '…'), block('…') in ui.js, unit-Paare in profile.js.
# Ohne --check: Liste der Schlüssel (JSON). Mit --check: js/lang/*.js auf fehlende/überzählige Schlüssel und
# Platzhalter ({name} …) prüfen; braucht node. Neuer Text im Code → in jeder Sprachdatei ergänzen.
import re, glob, sys, json, subprocess
LIT = r"'((?:[^'\\\n]|\\.)*)'"
def unesc(s): return s.replace("\\'", "'").replace('\\\\', '\\')
keys = []
def add(k):
    k = unesc(k)
    if k not in keys: keys.append(k)
for f in sorted(glob.glob('js/*.js')):
    if f.endswith('i18n.js'): continue
    s = open(f).read()
    for m in re.finditer(r"(?<![\w$.])tr\(\s*" + LIT, s): add(m.group(1))
    for m in re.finditer(r"(?<![\w$.])(?:tn|plural)\([^,()]*(?:\([^()]*\))?[^,()]*,\s*" + LIT + r"\s*,\s*" + LIT, s): add(m.group(1)); add(m.group(2))
    if f.endswith('ui.js'):
        for m in re.finditer(r"block\(" + LIT, s): add(m.group(1))
    if f.endswith('profile.js'):  # bars(…, { unit: ['Choreo', 'Choreos'] })
        for m in re.finditer(r"unit: \[" + LIT + r", " + LIT + r"\]", s): add(m.group(1)); add(m.group(2))
if '--check' not in sys.argv:
    print(json.dumps(keys, ensure_ascii=False, indent=1)); sys.exit()
ok = True
ph = lambda x: sorted(re.findall(r"\{\w+\}", x))
for lf in sorted(glob.glob('js/lang/*.js')):
    js = "import('./" + lf + "').then(m => process.stdout.write(JSON.stringify(m.default)))"
    d = json.loads(subprocess.run(['node', '--input-type=module', '-e', js], capture_output=True, text=True, check=True).stdout)
    miss = [k for k in keys if k not in d]
    extra = [k for k in d if k not in keys]
    badph = [k for k in keys if k in d and ph(k) != ph(d[k])]
    print(f"{lf}: {len(d)} Einträge, fehlend {len(miss)}, überzählig {len(extra)}, Platzhalter falsch {len(badph)}")
    for k in miss[:400]: print('  FEHLT', repr(k))
    for k in extra: print('  ÜBER ', repr(k))
    for k in badph: print('  PH   ', repr(k), '→', repr(d[k]))
    ok &= not (miss or badph)
sys.exit(0 if ok else 1)
