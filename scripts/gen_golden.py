# -*- coding: utf-8 -*-
"""用原 Python 实现（yanzheng.core.gates）重新生成门检金标。

TS 重构版的等价性测试加载 testdata/golden.json，以同一输入构造规则逐字段断言。
运行：python scripts/gen_golden.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ORIG_REPO = Path(r"D:\ZCode\2026年江苏省AI+科学与工程创新实践黑客松")
sys.path.insert(0, str(ORIG_REPO))

from yanzheng.core.gates import (  # noqa: E402
    check_format,
    check_warnings,
    count_words,
    duplication_rate,
)

DATA = Path(__file__).resolve().parents[1] / "testdata"


def read(p: Path) -> str:
    return p.read_text(encoding="utf-8", errors="ignore")


def main() -> None:
    demo = read(DATA / "demo_paper.txt")
    good = read(DATA / "paper_good.md")
    poor = read(DATA / "paper_poor.md")
    corpus = {
        "source1.txt": read(DATA / "corpus" / "source1.txt"),
        "source2.txt": read(DATA / "corpus" / "source2.txt"),
    }
    corpus_docs = list(corpus.values())
    # dupcase：source1 原文 + 一句扩展（与原金标注释同思路，扩展句由本脚本统一构造）
    dupcase = corpus["source1.txt"] + "\n扩展：本研究补充三组对照实验以验证方法的稳健性。\n"

    cases = {}
    for name, text in (("demo", demo), ("good", good), ("poor", poor), ("dupcase", dupcase)):
        cases[name] = {
            "word_count": count_words(text),
            "format_issues": check_format(text),
            "warnings": check_warnings(text),
            "dup_rate_vs_corpus": duplication_rate(text, corpus_docs),
        }

    out = {"corpus_names": sorted(corpus.keys()), "cases": cases}
    (DATA / "golden.json").write_text(
        json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8"
    )
    print("written:", DATA / "golden.json")
    for name, c in cases.items():
        print(name, c["word_count"], c["dup_rate_vs_corpus"])


if __name__ == "__main__":
    main()
