#!/usr/bin/env python3
"""Builds ../../crates/gb-core/assets/trivia.tsv: the extra Good Boy trivia questions.

Two kinds of question go in:
  * generated from the tables here (countries, elements, US states, maths), so the answers are checked by construction;
  * hand-written ones in the hand-*.txt files, one per line:  category|question|right answer|wrong|wrong|wrong
Every question is checked (four different answers, lengths that fit the picture, no repeats) and anything bad stops the build.
Run:  python3 make-trivia.py
"""
import glob, os, random, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', '..', 'crates', 'gb-core', 'assets', 'trivia.tsv')
rng = random.Random(20261116)
rows = []  # (category, question, right, w1, w2, w3)

def table(name):
    out = []
    for line in open(os.path.join(HERE, name), encoding='utf8'):
        line = line.strip()
        if line and not line.startswith('#'):
            out.append(line.split('|'))
    return out

def pick(pool, right, n=3, near=None):
    """n different wrong answers from pool (preferring `near` ones first)."""
    cand = [p for p in dict.fromkeys(pool) if p != right]
    first = [p for p in (near or []) if p != right and p in cand]
    rng.shuffle(first); rest = [p for p in cand if p not in first]; rng.shuffle(rest)
    return (first + rest)[:n]

def add(cat, q, right, wrong):
    rows.append((cat, q, right, *wrong))

# ---------------------------------------------------------------- geography
C = table('countries.txt')
caps = [c[1] for c in C]
by_cont = {}
for c in C: by_cont.setdefault(c[2], []).append(c)
for name, cap, cont, cur in C:
    near = [x[1] for x in by_cont[cont]]
    add('geography', f'What is the capital of {name}?', cap, pick(caps, cap, near=near))
unique_cap = {}
for name, cap, cont, cur in C: unique_cap.setdefault(cap, []).append(name)
names = [c[0] for c in C]
for name, cap, cont, cur in C:
    if len(unique_cap[cap]) == 1 and cap != name and name in {c[0] for c in C[::2]}:
        near = [x[0] for x in by_cont[cont]]
        add('geography', f'{cap} is the capital of which country?', name, pick(names, name, near=near))
CONTS = ['Africa', 'Asia', 'Europe', 'North America', 'South America', 'Oceania']
for name, cap, cont, cur in C[::2]:
    add('geography', f'Which continent is {name} in?', cont, pick(CONTS, cont))
curs = [c[3] for c in C]
shared = {'Euro', 'US dollar', 'CFA franc', 'Australian dollar', 'East Caribbean dollar'}
for name, cap, cont, cur in C:
    if cur not in shared and curs.count(cur) == 1 and cur not in ('Som',):
        add('geography', f'What currency does {name} use?', cur, pick([x for x in curs if x not in shared], cur))
S = table('states.txt')
scaps = [s[1] for s in S]; snames = [s[0] for s in S]; nicks = [s[2] for s in S]
for st, cap, nick in S:
    add('geography', f'What is the capital of {st}, USA?', cap, pick(scaps, cap))
    add('geography', f'Which US state is nicknamed the "{nick}"?', st, pick(snames, st))

# ---------------------------------------------------------------- science: the elements
E = table('elements.txt')
easy = E[:92]
syms = [e[1] for e in E]; enames = [e[2] for e in E]
for n, sym, name in E[:94]:
    if name in ('Carbon', 'Oxygen', 'Gold', 'Silver', 'Iron', 'Hydrogen'):  # kept: v3 already asks the famous ones, these are fine too
        pass
    add('science', f'What is the chemical symbol for {name}?', sym, pick(syms[:94], sym))
for n, sym, name in E[:80]:
    add('science', f'Which element has the symbol {sym}?', name, pick(enames[:94], name))
for n, sym, name in E[:36]:
    add('science', f'Which element has the atomic number {n}?', name, pick(enames[:40], name))
for n, sym, name in E[:36:2]:
    add('science', f'What is the atomic number of {name}?', str(n), [str(x) for x in pick([str(i) for i in range(1, 41)], str(n))])

# ---------------------------------------------------------------- maths
def nums(right, lo=None, hi=None, spread=None):
    r = int(right); s = spread or max(3, abs(r) // 8)
    out = set()
    while len(out) < 3:
        d = rng.choice([-1, 1]) * rng.randint(1, s)
        if r + d != r and r + d > 0: out.add(r + d)
    return [str(x) for x in out]
for n in range(11, 31):
    add('math', f'What is {n} squared?', str(n * n), nums(n * n))
for n in (6, 7, 8, 9, 11, 12, 13, 14, 15, 16):
    add('math', f'What is the square root of {n * n}?', str(n), nums(n, spread=4))
ROM = {4: 'IV', 9: 'IX', 14: 'XIV', 19: 'XIX', 24: 'XXIV', 29: 'XXIX', 40: 'XL', 49: 'XLIX', 50: 'L', 90: 'XC', 99: 'XCIX', 100: 'C', 400: 'CD', 500: 'D', 900: 'CM', 1000: 'M', 1999: 'MCMXCIX', 2024: 'MMXXIV', 44: 'XLIV', 64: 'LXIV', 88: 'LXXXVIII', 1994: 'MCMXCIV'}
for k, v in ROM.items():
    add('math', f'What number is the Roman numeral {v}?', str(k), nums(k, spread=max(5, k // 6)))
for a, b in [(12, 13), (14, 15), (16, 17), (18, 19), (21, 22), (23, 24), (25, 12), (35, 4), (45, 6), (15, 15), (99, 9), (11, 111), (125, 8), (36, 25), (17, 6), (19, 7), (24, 15), (48, 5), (64, 3), (72, 11)]:
    add('math', f'What is {a} x {b}?', str(a * b), nums(a * b))
for p, n in [(10, 250), (25, 80), (50, 36), (20, 150), (75, 120), (5, 400), (30, 90), (15, 200), (40, 65), (60, 45), (12, 50), (80, 35), (90, 70), (35, 40), (45, 60), (2, 500), (8, 250), (22, 50), (18, 100), (95, 20)]:
    v = p * n / 100; right = str(int(v)) if v == int(v) else str(v)
    wrong = []
    while len(wrong) < 3:
        d = rng.choice([-1, 1]) * rng.choice([1, 2, 3, 5, 10]) * max(1, int(v) // 10)
        w = v + d
        if w > 0 and w != v:
            s = str(int(w)) if w == int(w) else str(w)
            if s not in wrong: wrong.append(s)
    add('math', f'What is {p}% of {n}?', right, wrong)
PRIMES = [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71, 73, 79, 83, 89, 97]
COMP = [4, 6, 8, 9, 15, 21, 25, 27, 33, 35, 39, 45, 49, 51, 55, 57, 63, 65, 69, 77, 81, 85, 87, 91, 93, 95, 99]
for p in PRIMES[3:]:
    dec = p // 10 * 10
    # a clue (the decade and the last digit) makes every question different, and only one answer is ever prime
    pool = [c for c in COMP if c != p]
    add('math', f'Which of these is prime? Clue: it is in the {dec}s and ends in {p % 10}.', str(p), [str(x) for x in rng.sample(pool, 3)])
for start, step in [(2, 3), (5, 4), (1, 7), (10, 6), (3, 9), (4, 5), (7, 8), (6, 11), (9, 4), (12, 7), (20, 15), (100, 25)]:
    seq = [start + step * i for i in range(5)]; right = start + step * 5
    add('math', f'What comes next: {", ".join(map(str, seq))}, ...?', str(right), nums(right, spread=6))
for first, second in [(1, 1), (1, 2), (2, 1), (3, 2), (2, 5), (4, 3)]:
    seq = [first, second]
    for _ in range(4): seq.append(seq[-1] + seq[-2])
    right = seq[-1] + seq[-2]
    add('math', f'What comes next: {", ".join(map(str, seq))}, ...?', str(right), nums(right, spread=7))
for base in (2, 3, 4, 5):
    seq = [base ** i for i in range(1, 6)]
    right = base ** 6
    add('math', f'What comes next: {", ".join(map(str, seq))}, ...?', str(right), nums(right, spread=max(4, right // 5)))

# ---------------------------------------------------------------- hand-written
for path in sorted(glob.glob(os.path.join(HERE, 'hand-*.txt'))):
    for n, line in enumerate(open(path, encoding='utf8'), 1):
        line = line.strip()
        if not line or line.startswith('#'): continue
        parts = [p.strip() for p in line.split('|')]
        if len(parts) != 6:
            sys.exit(f'{os.path.basename(path)} line {n}: needs category|question|right|wrong|wrong|wrong, got {len(parts)} parts')
        rows.append(tuple(parts))

# ---------------------------------------------------------------- checks
bad, seen = [], set()
CATS = {'general', 'science', 'geography', 'games', 'anime', 'history', 'animals', 'food', 'tech', 'sports', 'music', 'movies', 'language', 'math'}
final = []
for r in rows:
    cat, q, right, *wrong = r
    why = None
    if cat not in CATS: why = f'unknown category {cat}'
    elif len(set(a.lower() for a in [right, *wrong])) != 4: why = 'answers are not four different ones'
    elif len(q) > 110: why = f'question too long ({len(q)})'
    elif any(len(a) > 30 or not a for a in [right, *wrong]): why = 'an answer is empty or longer than 30 characters'
    elif '|' in q or '\t' in q: why = 'bad character'
    elif q.lower() in seen: why = 'repeated question'
    if why: bad.append((why, r)); continue
    seen.add(q.lower()); final.append(r)
if bad:
    for why, r in bad[:40]: print('BAD:', why, '|', r[:3])
    print(len(bad), 'bad entries'); sys.exit(1)
os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, 'w', encoding='utf8', newline='\n') as f:
    f.write('# Extra trivia for Good Boy 4. Made by v4/tools/trivia/make-trivia.py. category<TAB>question<TAB>right<TAB>wrong<TAB>wrong<TAB>wrong\n')
    for r in final: f.write('\t'.join(r) + '\n')
per = {}
for r in final: per[r[0]] = per.get(r[0], 0) + 1
print(len(final), 'questions:', ', '.join(f'{k} {v}' for k, v in sorted(per.items())))
