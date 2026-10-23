## Overall (30 queries, k=5)

| config | n | recall@5 (file) | recall@5 (strict) | MRR (file) | MRR (strict) | top-1 | wrong top | CONFIDENT-WRONG | abstain | recall when answered | tokens/query | median ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| B0 control: default weights, unguarded, no rewrite | 30 | 56.7% | 40.0% | 0.421 | 0.319 | 33.3% | 66.7% | **66.7%** | 0.0% | 56.7% | 639 | 1295 |
| B1 base mix, no rewrite | 30 | 53.3% | 36.7% | 0.440 | 0.333 | 36.7% | 63.3% | **63.3%** | 0.0% | 53.3% | 777 | 1317 |
| B2 base mix + rewrite (plain) | 30 | 73.3% | 56.7% | 0.517 | 0.359 | 40.0% | 60.0% | **60.0%** | 0.0% | 73.3% | 644 | 2043 |
| B3 base mix + rewrite (with file paths) | 30 | 66.7% | 46.7% | 0.500 | 0.383 | 40.0% | 60.0% | **60.0%** | 0.0% | 66.7% | 631 | 1651 |
| B4 code channel only + rewrite (paths) | 30 | 53.3% | 33.3% | 0.353 | 0.214 | 23.3% | 76.7% | **76.7%** | 0.0% | 53.3% | 801 | 17 |
| B5 code 3 + bm25 2 + rewrite (paths), no semantic | 30 | 66.7% | 46.7% | 0.500 | 0.383 | 40.0% | 60.0% | **60.0%** | 0.0% | 66.7% | 636 | 16 |
| B6 code 3 + bm25 2 + lexical 1 + rewrite (paths) | 30 | 80.0% | 56.7% | 0.559 | 0.447 | 43.3% | 56.7% | **56.7%** | 0.0% | 80.0% | 565 | 15 |

### exact-name

| config | n | recall@5 (file) | recall@5 (strict) | MRR (file) | MRR (strict) | top-1 | wrong top | CONFIDENT-WRONG | abstain | recall when answered | tokens/query | median ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| B0 control: default weights, unguarded, no rewrite | 5 | 100.0% | 100.0% | 1.000 | 1.000 | 100.0% | 0.0% | **0.0%** | 0.0% | 100.0% | 634 | 887 |
| B1 base mix, no rewrite | 5 | 100.0% | 100.0% | 1.000 | 1.000 | 100.0% | 0.0% | **0.0%** | 0.0% | 100.0% | 739 | 1054 |
| B2 base mix + rewrite (plain) | 5 | 100.0% | 100.0% | 0.800 | 0.800 | 60.0% | 40.0% | **40.0%** | 0.0% | 100.0% | 520 | 1772 |
| B3 base mix + rewrite (with file paths) | 5 | 100.0% | 100.0% | 1.000 | 1.000 | 100.0% | 0.0% | **0.0%** | 0.0% | 100.0% | 556 | 1645 |
| B4 code channel only + rewrite (paths) | 5 | 80.0% | 40.0% | 0.433 | 0.167 | 20.0% | 80.0% | **80.0%** | 0.0% | 80.0% | 829 | 14 |
| B5 code 3 + bm25 2 + rewrite (paths), no semantic | 5 | 100.0% | 100.0% | 1.000 | 1.000 | 100.0% | 0.0% | **0.0%** | 0.0% | 100.0% | 556 | 15 |
| B6 code 3 + bm25 2 + lexical 1 + rewrite (paths) | 5 | 100.0% | 100.0% | 1.000 | 1.000 | 100.0% | 0.0% | **0.0%** | 0.0% | 100.0% | 511 | 15 |

### paraphrase

| config | n | recall@5 (file) | recall@5 (strict) | MRR (file) | MRR (strict) | top-1 | wrong top | CONFIDENT-WRONG | abstain | recall when answered | tokens/query | median ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| B0 control: default weights, unguarded, no rewrite | 8 | 50.0% | 12.5% | 0.417 | 0.125 | 37.5% | 62.5% | **62.5%** | 0.0% | 50.0% | 676 | 1114 |
| B1 base mix, no rewrite | 8 | 50.0% | 12.5% | 0.375 | 0.125 | 25.0% | 75.0% | **75.0%** | 0.0% | 50.0% | 771 | 1126 |
| B2 base mix + rewrite (plain) | 8 | 87.5% | 37.5% | 0.719 | 0.188 | 62.5% | 37.5% | **37.5%** | 0.0% | 87.5% | 725 | 1913 |
| B3 base mix + rewrite (with file paths) | 8 | 62.5% | 25.0% | 0.302 | 0.188 | 12.5% | 87.5% | **87.5%** | 0.0% | 62.5% | 744 | 1568 |
| B4 code channel only + rewrite (paths) | 8 | 37.5% | 0.0% | 0.198 | 0.000 | 12.5% | 87.5% | **87.5%** | 0.0% | 37.5% | 812 | 20 |
| B5 code 3 + bm25 2 + rewrite (paths), no semantic | 8 | 62.5% | 25.0% | 0.302 | 0.188 | 12.5% | 87.5% | **87.5%** | 0.0% | 62.5% | 744 | 15 |
| B6 code 3 + bm25 2 + lexical 1 + rewrite (paths) | 8 | 87.5% | 50.0% | 0.552 | 0.354 | 37.5% | 62.5% | **62.5%** | 0.0% | 87.5% | 591 | 14 |

### concept

| config | n | recall@5 (file) | recall@5 (strict) | MRR (file) | MRR (strict) | top-1 | wrong top | CONFIDENT-WRONG | abstain | recall when answered | tokens/query | median ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| B0 control: default weights, unguarded, no rewrite | 6 | 33.3% | 16.7% | 0.075 | 0.042 | 0.0% | 100.0% | **100.0%** | 0.0% | 33.3% | 701 | 1869 |
| B1 base mix, no rewrite | 6 | 16.7% | 16.7% | 0.167 | 0.167 | 16.7% | 83.3% | **83.3%** | 0.0% | 16.7% | 802 | 2299 |
| B2 base mix + rewrite (plain) | 6 | 33.3% | 33.3% | 0.111 | 0.111 | 0.0% | 100.0% | **100.0%** | 0.0% | 33.3% | 580 | 2477 |
| B3 base mix + rewrite (with file paths) | 6 | 33.3% | 16.7% | 0.250 | 0.083 | 16.7% | 83.3% | **83.3%** | 0.0% | 33.3% | 679 | 1747 |
| B4 code channel only + rewrite (paths) | 6 | 33.3% | 33.3% | 0.167 | 0.167 | 0.0% | 100.0% | **100.0%** | 0.0% | 33.3% | 845 | 17 |
| B5 code 3 + bm25 2 + rewrite (paths), no semantic | 6 | 33.3% | 16.7% | 0.250 | 0.083 | 16.7% | 83.3% | **83.3%** | 0.0% | 33.3% | 704 | 16 |
| B6 code 3 + bm25 2 + lexical 1 + rewrite (paths) | 6 | 66.7% | 33.3% | 0.264 | 0.167 | 0.0% | 100.0% | **100.0%** | 0.0% | 66.7% | 644 | 12 |

### call-path

| config | n | recall@5 (file) | recall@5 (strict) | MRR (file) | MRR (strict) | top-1 | wrong top | CONFIDENT-WRONG | abstain | recall when answered | tokens/query | median ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| B0 control: default weights, unguarded, no rewrite | 4 | 100.0% | 100.0% | 0.708 | 0.708 | 50.0% | 50.0% | **50.0%** | 0.0% | 100.0% | 711 | 1671 |
| B1 base mix, no rewrite | 4 | 100.0% | 75.0% | 0.875 | 0.625 | 75.0% | 25.0% | **25.0%** | 0.0% | 100.0% | 749 | 1586 |
| B2 base mix + rewrite (plain) | 4 | 100.0% | 75.0% | 0.675 | 0.550 | 50.0% | 50.0% | **50.0%** | 0.0% | 100.0% | 706 | 2195 |
| B3 base mix + rewrite (with file paths) | 4 | 100.0% | 75.0% | 0.708 | 0.563 | 50.0% | 50.0% | **50.0%** | 0.0% | 100.0% | 680 | 1320 |
| B4 code channel only + rewrite (paths) | 4 | 100.0% | 75.0% | 1.000 | 0.750 | 100.0% | 0.0% | **0.0%** | 0.0% | 100.0% | 767 | 16 |
| B5 code 3 + bm25 2 + rewrite (paths), no semantic | 4 | 100.0% | 75.0% | 0.708 | 0.563 | 50.0% | 50.0% | **50.0%** | 0.0% | 100.0% | 680 | 17 |
| B6 code 3 + bm25 2 + lexical 1 + rewrite (paths) | 4 | 100.0% | 75.0% | 0.613 | 0.563 | 50.0% | 50.0% | **50.0%** | 0.0% | 100.0% | 637 | 16 |

### cross-file

| config | n | recall@5 (file) | recall@5 (strict) | MRR (file) | MRR (strict) | top-1 | wrong top | CONFIDENT-WRONG | abstain | recall when answered | tokens/query | median ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| B0 control: default weights, unguarded, no rewrite | 4 | 25.0% | 0.0% | 0.125 | 0.000 | 0.0% | 100.0% | **100.0%** | 0.0% | 25.0% | 475 | 1153 |
| B1 base mix, no rewrite | 4 | 50.0% | 25.0% | 0.175 | 0.125 | 0.0% | 100.0% | **100.0%** | 0.0% | 50.0% | 801 | 1532 |
| B2 base mix + rewrite (plain) | 4 | 75.0% | 75.0% | 0.550 | 0.550 | 50.0% | 50.0% | **50.0%** | 0.0% | 75.0% | 630 | 1749 |
| B3 base mix + rewrite (with file paths) | 4 | 75.0% | 50.0% | 0.750 | 0.500 | 75.0% | 25.0% | **25.0%** | 0.0% | 75.0% | 545 | 1906 |
| B4 code channel only + rewrite (paths) | 4 | 75.0% | 75.0% | 0.458 | 0.396 | 25.0% | 75.0% | **75.0%** | 0.0% | 75.0% | 738 | 17 |
| B5 code 3 + bm25 2 + rewrite (paths), no semantic | 4 | 75.0% | 50.0% | 0.750 | 0.500 | 75.0% | 25.0% | **25.0%** | 0.0% | 75.0% | 545 | 19 |
| B6 code 3 + bm25 2 + lexical 1 + rewrite (paths) | 4 | 75.0% | 50.0% | 0.750 | 0.500 | 75.0% | 25.0% | **25.0%** | 0.0% | 75.0% | 510 | 19 |

### spec-artifact

| config | n | recall@5 (file) | recall@5 (strict) | MRR (file) | MRR (strict) | top-1 | wrong top | CONFIDENT-WRONG | abstain | recall when answered | tokens/query | median ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| B0 control: default weights, unguarded, no rewrite | 3 | 33.3% | 33.3% | 0.167 | 0.167 | 0.0% | 100.0% | **100.0%** | 0.0% | 33.3% | 547 | 895 |
| B1 base mix, no rewrite | 3 | 0.0% | 0.0% | 0.000 | 0.000 | 0.0% | 100.0% | **100.0%** | 0.0% | 0.0% | 812 | 1381 |
| B2 base mix + rewrite (plain) | 3 | 33.3% | 33.3% | 0.067 | 0.067 | 0.0% | 100.0% | **100.0%** | 0.0% | 33.3% | 697 | 2033 |
| B3 base mix + rewrite (with file paths) | 3 | 33.3% | 33.3% | 0.083 | 0.083 | 0.0% | 100.0% | **100.0%** | 0.0% | 33.3% | 408 | 1503 |
| B4 code channel only + rewrite (paths) | 3 | 0.0% | 0.0% | 0.000 | 0.000 | 0.0% | 100.0% | **100.0%** | 0.0% | 0.0% | 766 | 18 |
| B5 code 3 + bm25 2 + rewrite (paths), no semantic | 3 | 33.3% | 33.3% | 0.083 | 0.083 | 0.0% | 100.0% | **100.0%** | 0.0% | 33.3% | 408 | 14 |
| B6 code 3 + bm25 2 + lexical 1 + rewrite (paths) | 3 | 33.3% | 33.3% | 0.111 | 0.111 | 0.0% | 100.0% | **100.0%** | 0.0% | 33.3% | 408 | 15 |

### repo: osa-clean

| config | n | recall@5 (file) | recall@5 (strict) | MRR (file) | MRR (strict) | top-1 | wrong top | CONFIDENT-WRONG | abstain | recall when answered | tokens/query | median ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| B0 control: default weights, unguarded, no rewrite | 30 | 56.7% | 40.0% | 0.421 | 0.319 | 33.3% | 66.7% | **66.7%** | 0.0% | 56.7% | 639 | 1295 |
| B1 base mix, no rewrite | 30 | 53.3% | 36.7% | 0.440 | 0.333 | 36.7% | 63.3% | **63.3%** | 0.0% | 53.3% | 777 | 1317 |
| B2 base mix + rewrite (plain) | 30 | 73.3% | 56.7% | 0.517 | 0.359 | 40.0% | 60.0% | **60.0%** | 0.0% | 73.3% | 644 | 2043 |
| B3 base mix + rewrite (with file paths) | 30 | 66.7% | 46.7% | 0.500 | 0.383 | 40.0% | 60.0% | **60.0%** | 0.0% | 66.7% | 631 | 1651 |
| B4 code channel only + rewrite (paths) | 30 | 53.3% | 33.3% | 0.353 | 0.214 | 23.3% | 76.7% | **76.7%** | 0.0% | 53.3% | 801 | 17 |
| B5 code 3 + bm25 2 + rewrite (paths), no semantic | 30 | 66.7% | 46.7% | 0.500 | 0.383 | 40.0% | 60.0% | **60.0%** | 0.0% | 66.7% | 636 | 16 |
| B6 code 3 + bm25 2 + lexical 1 + rewrite (paths) | 30 | 80.0% | 56.7% | 0.559 | 0.447 | 43.3% | 56.7% | **56.7%** | 0.0% | 80.0% | 565 | 15 |
