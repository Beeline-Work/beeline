"""Build video-full/src/fullTimeline.json for the full song (seed 808).

Verses/bridge: forced-alignment starts (snapped to vocal attacks, align_full.py).
Intro, pre-choruses, choruses: hand-verified from the syllable track, pitch track and
per-window transcription (the aligner collapses on the overlapping lead/echo hooks).
Chorus 2 is the same performance as chorus 1 (+43.92 s, every attack within 30 ms);
the final chorus's first four lines are chorus 1 +81.565 s.
Words marked verify=True still need a pass before the full render.
"""

import json

W = json.load(open('words_full.json'))
M = json.load(open('music_full.json'))


def sec(name):
    return [(w['text'], w['start']) for w in W if w['section'] == name]


# Verse 1's last line from the pitch-change syllable track (aligner scored it < 0.35).
V1_LAST = [('I', 28.46), ('FOUND', 28.68), ('THE', 28.86), ('PATTERN', 29.08), ('LIKE', 29.62), ('I', 29.96), ('KNEW', 30.22), ('I', 30.40), ('COULD', 30.57)]
INTRO = [('TEST', 0.56), ('ATLAS', 1.20), ('HEY', 1.94), ('TEST', 2.74), ('ATLAS', 3.42), ('HEY', 5.08)]
# Pre-chorus 1 as sung: no "Assess! Diagnose!" — "reassess" is held 36.35–39.5, then
# "drill it, reassess, here we go".
PRE1 = [("IT'S", 30.82), ('NOT', 31.00), ('A', 31.26), ('READING', 31.40), ('TEST', 31.70), ('NO', 32.21), ("IT'S", 32.58), ('A', 32.80),
        ('PATTERN', 32.95), ('TEST', 33.18), ('YES', 33.45), ('FIND', 34.16), ('THE', 34.30), ('ONE', 34.54), ("THAT'S", 34.68), ('COSTING', 34.90),
        ('ME', 35.14), ('DRILL', 35.65), ('IT', 35.88), ('THEN', 36.12), ('REASSESS', 36.35), ('DRILL', 39.96), ('IT', 40.20), ('REASSESS', 40.44),
        ('HERE', 42.03), ('WE', 42.20), ('GO', 42.37)]
CH1 = [('I', 44.16), ('GOT', 44.36), ('THE', 44.54), ('MAP', 44.70), ('HEY', 45.07), ('I', 45.51), ('KNOW', 45.71), ('THE', 46.11), ('WAY', 46.30),
       ('HEY', 46.63), ('EVERY', 47.09), ('TRAP', 47.43), ('THEY', 47.67), ('SET', 47.93), ('I', 48.08), ('SEE', 48.24), ('IT', 48.46), ('FROM', 48.67),
       ('A', 48.88), ('MILE', 49.02), ('AWAY', 49.30),
       # "run it back, run it back, run — run it back again" (an extra "run" is sung)
       ('RUN', 49.86), ('IT', 50.05), ('BACK', 50.24), ('RUN', 50.62), ('IT', 50.82), ('BACK', 51.03), ('RUN', 51.42), ('RUN', 51.80), ('IT', 52.00),
       ('BACK', 52.19), ('AGAIN', 52.42),
       ('WATCH', 53.36), ('MY', 53.57), ('SCORE', 53.78), ('CLIMB', 53.93), ('HIGHER', 54.20), ('THAN', 54.83), ("IT'S", 55.42), ('EVER', 55.78),
       ('BEEN', 56.12), ('TEST', 57.24), ('ATLAS', 57.67), ('TEST', 58.88), ('ATLAS', 59.25), ('PATTERN', 59.64), ('TEST', 60.42), ('I', 60.90),
       ('CRACKED', 61.14), ('IT', 61.58), ('AT', 62.04), ('LAST', 62.28), ('TEST', 63.52), ('ATLAS', 63.95), ('TEST', 65.15), ('ATLAS', 65.52),
       ('I', 67.08), ('CRACKED', 67.41), ('IT', 67.83), ('AT', 68.20), ('LAST', 68.58)]
CH2 = [(t, round(s + 43.92, 3)) for t, s in CH1]
PRE2 = [('ASSESS', 81.40), ('HEY', 81.94), ('DIAGNOSE', 82.74), ('HEY', 83.44), ('DRILL', 83.90), ('IT', 84.10), ('REASSESS', 84.36),
        ('HERE', 85.96), ('WE', 86.12), ('GO', 86.34)]
FINAL = [(t, round(s + 81.565, 3)) for t, s in CH1 if s < 49.5] + [
    ('TEST', 133.58), ('ATLAS', 133.96), ('TEST', 134.16), ('ATLAS', 134.56), ('PATTERN', 134.94), ('TEST', 135.70), ('I', 136.18),
    ('CRACKED', 136.42), ('IT', 136.88), ('AT', 137.30), ('LAST', 137.56)]
OUTRO = [('TEST', 139.19), ('ATLAS', 139.99), ('TEST', 142.33), ('TEST', 145.46)]
BRIDGE = [('SHOW', 113.02), ("'EM", 113.20), ('THE', 113.36), ('RECEIPT', 113.56), ('SHOW', 114.04), ("'EM", 114.36), ('SHOW', 114.76), ("'EM", 115.10),
          ('SHOW', 115.60), ('YOUR', 115.80), ('MOM', 116.02), ('THE', 116.30), ('RECEIPT', 116.54), ('SHOW', 117.18), ("'EM", 117.50), ('SHOW', 117.92),
          ("'EM", 118.24), ('BEFORE', 119.04), ('AND', 119.74), ('AFTER', 120.00), ('BLACK', 120.80), ('AND', 121.18), ('WHITE', 121.50),
          ('MISTAKE', 121.98), ('FIXED', 122.62), ('YEAH', 122.98), ('THE', 123.76), ("PROOF'S", 123.90), ('IN', 124.44), ('SIGHT', 124.72)]
# Verse words the aligner scored low, re-placed on syllable events (syllables.json).
V_FIX = {('Verse 1', 'CROSS'): 20.80, ('Verse 1', 'OUT'): 21.18, ('Verse 1', 'MATCH'): 21.94, ('Verse 1', "THERE'S"): 23.56, ('Verse 1', 'ROOM'): 23.98,
         ('Verse 1', 'FOR'): 24.18, ('Verse 1', 'DOUBT'): 24.32, ('Verse 1', 'THEY'): 25.10, ('Verse 1', 'READ@25'): 25.52, ('Verse 1', 'HARDER'): 25.70,
         ('Verse 1', 'NAH'): 26.80, ("Verse 1", "I'M"): 27.40, ('Verse 1', 'GOOD'): 27.56, ('Verse 2', 'WHOLE'): 73.66, ('Verse 2', 'AND'): 79.46,
         ('Verse 2', 'LOOK'): 80.46, ('Verse 2', 'RIGHT'): 80.70}
V_FIX_AT = {('Verse 1', 'IT', 21.1): 21.00, ('Verse 1', 'IT', 22.2): 22.16, ('Verse 1', 'SAID', 25.5): 25.32, ('Verse 1', 'I', 26.3): 26.12,
            ('Verse 1', 'SAID', 26.5): 26.48, ('Verse 1', 'THE', 22.6): 22.58, ('Verse 2', 'IT', 77.2): 77.10, ('Verse 2', 'THE', 79.8): 79.84}


def fixed(name, ws):
    out = []
    for text, start in ws:
        key = (name, 'READ@25') if text == 'READ' and 25 < start < 26 else (name, text)
        if key in V_FIX and not (text in ('IT', 'SAID', 'I', 'THE')):
            start = V_FIX[key]
        for (sn, st, near), v in V_FIX_AT.items():
            if sn == name and st == text and abs(start - near) < 0.15:
                start = v
        out.append((text, start))
    return out

VERIFY = {'Verse 1', 'Verse 2', 'Bridge', 'pre2', 'final-hook', 'outro'}
parts = [('intro', INTRO, False), ('Verse 1', fixed('Verse 1', sec('Verse 1')[:-9]), False), ('verse1-last', V1_LAST, False), ('pre1', PRE1, False), ('chorus1', CH1, False), ('Verse 2', fixed('Verse 2', [('QUICK', 69.21)] + sec('Verse 2')[1:]), False),
         ('pre2', PRE2, False), ('chorus2', CH2, False), ('Bridge', BRIDGE, False), ('final', FINAL, False), ('outro', OUTRO, False)]
words = []
for name, ws, verify in parts:
    for text, start in ws:
        words.append({'text': text, 'start': round(start, 3), 'part': name, 'verify': verify})
words.sort(key=lambda w: w['start'])
for i in range(1, len(words)):  # provisional (verify) words only: keep order and spacing
    if words[i]['verify'] and words[i]['start'] < words[i - 1]['start'] + 0.08:
        words[i]['start'] = round(words[i - 1]['start'] + 0.08, 3)
for i, w in enumerate(words):
    nxt = words[i + 1]['start'] if i + 1 < len(words) else 150.0
    w['end'] = round(min(nxt, w['start'] + 0.9), 3)
    if w['text'] == 'REASSESS' and abs(w['start'] - 36.35) < 0.01:
        w['end'] = 39.5  # held note: the word stays up for the whole hold
    assert i == 0 or w['start'] > words[i - 1]['start'] + 0.04, (words[i - 1], w)

off = M['grid_offset']  # librosa's grid runs ~20 ms late vs the drums
beats = [round(b + off, 3) for b in M['beats']]
tl = {
    'duration': 150.0,
    'bpm': 152,
    'beats': beats,
    'hits': M['hits'],
    'gaps': [[round(a, 2), round(b, 2)] for a, b in M['gaps']],
    'words': words,
    'sections': {'intro': 0.0, 'verse1': 5.8, 'verse1b': 18.47, 'pre1': 30.44, 'chorus1': 44.16, 'drop': 47.09, 'verse2': 69.4, 'pre2': 81.38,
                 'chorus2': 88.08, 'drop2': 91.01, 'bridge': 113.37, 'final': 125.73, 'outro': 138.07, 'end': 150.0},
}
json.dump(tl, open('../video-full/src/fullTimeline.json', 'w'), indent=1)
print(len(words), 'words;', sum(w['verify'] for w in words), 'still to verify before full render;', len(beats), 'beats')
