"""Exact fixture token counts, not provider billing or bytes/4 estimates.

Install tiktoken 0.14.0 locally, then run from the repository root:
PYTHONPATH=data/beeline-audit-agent-lifecycle/.tokenizer python data/beeline-audit-agent-lifecycle/count.py
"""
import json
import os
from pathlib import Path

root = Path(__file__).resolve().parent
os.environ["TIKTOKEN_CACHE_DIR"] = str(root / ".tokenizer-cache")
import tiktoken

encoding = tiktoken.get_encoding("o200k_base")
before = json.loads((root / "before.json").read_text())
after = json.loads((root / "after.json").read_text())
for fixtures in (before, after):
    fixtures["review-session-and-target"] = (
        fixtures["code-corner-reviewer"] + "\n\n" + fixtures["review-target"]
    )
rows = []
for name, text in after.items():
    old = len(encoding.encode(before[name]))
    new = len(encoding.encode(text))
    rows.append({"surface": name, "before": old, "after": new, "saved": old - new})
(root / "tokens.json").write_text(json.dumps({
    "tokenizer": "tiktoken 0.14.0 / o200k_base", "rows": rows,
}, indent=2) + "\n")
print("| Prompt fixture | Before | After | Saved |")
print("| --- | ---: | ---: | ---: |")
for row in rows:
    print(f"| {row['surface']} | {row['before']} | {row['after']} | {row['saved']} |")
