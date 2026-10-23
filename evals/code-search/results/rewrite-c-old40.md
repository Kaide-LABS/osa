## Overall (40 queries, k=5)

| config | n | recall@5 (file) | recall@5 (strict) | MRR (file) | MRR (strict) | top-1 | wrong top | CONFIDENT-WRONG | abstain | recall when answered | tokens/query | median ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| C6p code 3 + bm25 2 + lexical 1 + rewrite (plain) | 40 | 82.5% | 67.5% | 0.681 | 0.450 | 60.0% | 40.0% | **40.0%** | 0.0% | 82.5% | 604 | 1437 |
| C6q same, lexical 2 | 40 | 82.5% | 62.5% | 0.657 | 0.434 | 57.5% | 42.5% | **42.5%** | 0.0% | 82.5% | 562 | 23 |

### exact-name

| config | n | recall@5 (file) | recall@5 (strict) | MRR (file) | MRR (strict) | top-1 | wrong top | CONFIDENT-WRONG | abstain | recall when answered | tokens/query | median ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| C6p code 3 + bm25 2 + lexical 1 + rewrite (plain) | 8 | 100.0% | 100.0% | 1.000 | 1.000 | 100.0% | 0.0% | **0.0%** | 0.0% | 100.0% | 636 | 1485 |
| C6q same, lexical 2 | 8 | 100.0% | 100.0% | 1.000 | 1.000 | 100.0% | 0.0% | **0.0%** | 0.0% | 100.0% | 592 | 19 |

### paraphrase

| config | n | recall@5 (file) | recall@5 (strict) | MRR (file) | MRR (strict) | top-1 | wrong top | CONFIDENT-WRONG | abstain | recall when answered | tokens/query | median ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| C6p code 3 + bm25 2 + lexical 1 + rewrite (plain) | 8 | 75.0% | 50.0% | 0.650 | 0.244 | 62.5% | 37.5% | **37.5%** | 0.0% | 75.0% | 498 | 1425 |
| C6q same, lexical 2 | 8 | 87.5% | 50.0% | 0.629 | 0.317 | 50.0% | 50.0% | **50.0%** | 0.0% | 87.5% | 498 | 19 |

### concept

| config | n | recall@5 (file) | recall@5 (strict) | MRR (file) | MRR (strict) | top-1 | wrong top | CONFIDENT-WRONG | abstain | recall when answered | tokens/query | median ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| C6p code 3 + bm25 2 + lexical 1 + rewrite (plain) | 6 | 83.3% | 83.3% | 0.556 | 0.431 | 33.3% | 66.7% | **66.7%** | 0.0% | 83.3% | 540 | 1486 |
| C6q same, lexical 2 | 6 | 83.3% | 83.3% | 0.528 | 0.403 | 33.3% | 66.7% | **66.7%** | 0.0% | 83.3% | 522 | 44 |

### call-path

| config | n | recall@5 (file) | recall@5 (strict) | MRR (file) | MRR (strict) | top-1 | wrong top | CONFIDENT-WRONG | abstain | recall when answered | tokens/query | median ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| C6p code 3 + bm25 2 + lexical 1 + rewrite (plain) | 7 | 85.7% | 57.1% | 0.600 | 0.314 | 42.9% | 57.1% | **57.1%** | 0.0% | 85.7% | 609 | 1371 |
| C6q same, lexical 2 | 7 | 71.4% | 57.1% | 0.529 | 0.314 | 42.9% | 57.1% | **57.1%** | 0.0% | 71.4% | 518 | 22 |

### cross-file

| config | n | recall@5 (file) | recall@5 (strict) | MRR (file) | MRR (strict) | top-1 | wrong top | CONFIDENT-WRONG | abstain | recall when answered | tokens/query | median ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| C6p code 3 + bm25 2 + lexical 1 + rewrite (plain) | 6 | 100.0% | 83.3% | 0.750 | 0.381 | 66.7% | 33.3% | **33.3%** | 0.0% | 100.0% | 621 | 1236 |
| C6q same, lexical 2 | 6 | 83.3% | 50.0% | 0.700 | 0.200 | 66.7% | 33.3% | **33.3%** | 0.0% | 83.3% | 585 | 26 |

### spec-artifact

| config | n | recall@5 (file) | recall@5 (strict) | MRR (file) | MRR (strict) | top-1 | wrong top | CONFIDENT-WRONG | abstain | recall when answered | tokens/query | median ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| C6p code 3 + bm25 2 + lexical 1 + rewrite (plain) | 5 | 40.0% | 20.0% | 0.400 | 0.200 | 40.0% | 60.0% | **60.0%** | 0.0% | 40.0% | 772 | 1644 |
| C6q same, lexical 2 | 5 | 60.0% | 20.0% | 0.440 | 0.200 | 40.0% | 60.0% | **60.0%** | 0.0% | 60.0% | 700 | 31 |

### repo: osa

| config | n | recall@5 (file) | recall@5 (strict) | MRR (file) | MRR (strict) | top-1 | wrong top | CONFIDENT-WRONG | abstain | recall when answered | tokens/query | median ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| C6p code 3 + bm25 2 + lexical 1 + rewrite (plain) | 14 | 78.6% | 71.4% | 0.729 | 0.431 | 71.4% | 28.6% | **28.6%** | 0.0% | 78.6% | 479 | 1437 |
| C6q same, lexical 2 | 14 | 85.7% | 71.4% | 0.743 | 0.427 | 71.4% | 28.6% | **28.6%** | 0.0% | 85.7% | 443 | 18 |

### repo: hostel

| config | n | recall@5 (file) | recall@5 (strict) | MRR (file) | MRR (strict) | top-1 | wrong top | CONFIDENT-WRONG | abstain | recall when answered | tokens/query | median ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| C6p code 3 + bm25 2 + lexical 1 + rewrite (plain) | 13 | 84.6% | 69.2% | 0.699 | 0.503 | 61.5% | 38.5% | **38.5%** | 0.0% | 84.6% | 551 | 794 |
| C6q same, lexical 2 | 13 | 84.6% | 61.5% | 0.644 | 0.526 | 53.8% | 46.2% | **46.2%** | 0.0% | 84.6% | 530 | 20 |

### repo: hms

| config | n | recall@5 (file) | recall@5 (strict) | MRR (file) | MRR (strict) | top-1 | wrong top | CONFIDENT-WRONG | abstain | recall when answered | tokens/query | median ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| C6p code 3 + bm25 2 + lexical 1 + rewrite (plain) | 13 | 84.6% | 61.5% | 0.612 | 0.419 | 46.2% | 53.8% | **53.8%** | 0.0% | 84.6% | 792 | 2879 |
| C6q same, lexical 2 | 13 | 76.9% | 53.8% | 0.579 | 0.349 | 46.2% | 53.8% | **53.8%** | 0.0% | 76.9% | 723 | 31 |
