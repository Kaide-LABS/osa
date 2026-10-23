## Overall (30 queries, k=5)

| config | n | recall@5 (file) | recall@5 (strict) | MRR (file) | MRR (strict) | top-1 | wrong top | CONFIDENT-WRONG | abstain | recall when answered | tokens/query | median ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| C6p code 3 + bm25 2 + lexical 1 + rewrite (plain) | 30 | 73.3% | 50.0% | 0.519 | 0.343 | 40.0% | 60.0% | **60.0%** | 0.0% | 73.3% | 620 | 2717 |
| C6q same, lexical 2 | 30 | 70.0% | 56.7% | 0.529 | 0.356 | 40.0% | 60.0% | **60.0%** | 0.0% | 70.0% | 524 | 30 |

### exact-name

| config | n | recall@5 (file) | recall@5 (strict) | MRR (file) | MRR (strict) | top-1 | wrong top | CONFIDENT-WRONG | abstain | recall when answered | tokens/query | median ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| C6p code 3 + bm25 2 + lexical 1 + rewrite (plain) | 5 | 100.0% | 100.0% | 0.800 | 0.800 | 60.0% | 40.0% | **40.0%** | 0.0% | 100.0% | 506 | 2819 |
| C6q same, lexical 2 | 5 | 100.0% | 100.0% | 0.900 | 0.900 | 80.0% | 20.0% | **20.0%** | 0.0% | 100.0% | 395 | 19 |

### paraphrase

| config | n | recall@5 (file) | recall@5 (strict) | MRR (file) | MRR (strict) | top-1 | wrong top | CONFIDENT-WRONG | abstain | recall when answered | tokens/query | median ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| C6p code 3 + bm25 2 + lexical 1 + rewrite (plain) | 8 | 87.5% | 25.0% | 0.698 | 0.167 | 62.5% | 37.5% | **37.5%** | 0.0% | 87.5% | 686 | 2849 |
| C6q same, lexical 2 | 8 | 87.5% | 50.0% | 0.729 | 0.237 | 62.5% | 37.5% | **37.5%** | 0.0% | 87.5% | 605 | 24 |

### concept

| config | n | recall@5 (file) | recall@5 (strict) | MRR (file) | MRR (strict) | top-1 | wrong top | CONFIDENT-WRONG | abstain | recall when answered | tokens/query | median ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| C6p code 3 + bm25 2 + lexical 1 + rewrite (plain) | 6 | 33.3% | 33.3% | 0.167 | 0.167 | 0.0% | 100.0% | **100.0%** | 0.0% | 33.3% | 594 | 3044 |
| C6q same, lexical 2 | 6 | 33.3% | 33.3% | 0.167 | 0.167 | 0.0% | 100.0% | **100.0%** | 0.0% | 33.3% | 450 | 44 |

### call-path

| config | n | recall@5 (file) | recall@5 (strict) | MRR (file) | MRR (strict) | top-1 | wrong top | CONFIDENT-WRONG | abstain | recall when answered | tokens/query | median ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| C6p code 3 + bm25 2 + lexical 1 + rewrite (plain) | 4 | 100.0% | 75.0% | 0.613 | 0.563 | 50.0% | 50.0% | **50.0%** | 0.0% | 100.0% | 764 | 2587 |
| C6q same, lexical 2 | 4 | 75.0% | 75.0% | 0.458 | 0.458 | 25.0% | 75.0% | **75.0%** | 0.0% | 75.0% | 682 | 30 |

### cross-file

| config | n | recall@5 (file) | recall@5 (strict) | MRR (file) | MRR (strict) | top-1 | wrong top | CONFIDENT-WRONG | abstain | recall when answered | tokens/query | median ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| C6p code 3 + bm25 2 + lexical 1 + rewrite (plain) | 4 | 75.0% | 50.0% | 0.583 | 0.375 | 50.0% | 50.0% | **50.0%** | 0.0% | 75.0% | 468 | 2309 |
| C6q same, lexical 2 | 4 | 75.0% | 50.0% | 0.625 | 0.313 | 50.0% | 50.0% | **50.0%** | 0.0% | 75.0% | 414 | 38 |

### spec-artifact

| config | n | recall@5 (file) | recall@5 (strict) | MRR (file) | MRR (strict) | top-1 | wrong top | CONFIDENT-WRONG | abstain | recall when answered | tokens/query | median ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| C6p code 3 + bm25 2 + lexical 1 + rewrite (plain) | 3 | 33.3% | 33.3% | 0.067 | 0.067 | 0.0% | 100.0% | **100.0%** | 0.0% | 33.3% | 697 | 2124 |
| C6q same, lexical 2 | 3 | 33.3% | 33.3% | 0.067 | 0.067 | 0.0% | 100.0% | **100.0%** | 0.0% | 33.3% | 604 | 35 |

### repo: osa-clean

| config | n | recall@5 (file) | recall@5 (strict) | MRR (file) | MRR (strict) | top-1 | wrong top | CONFIDENT-WRONG | abstain | recall when answered | tokens/query | median ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| C6p code 3 + bm25 2 + lexical 1 + rewrite (plain) | 30 | 73.3% | 50.0% | 0.519 | 0.343 | 40.0% | 60.0% | **60.0%** | 0.0% | 73.3% | 620 | 2717 |
| C6q same, lexical 2 | 30 | 70.0% | 56.7% | 0.529 | 0.356 | 40.0% | 60.0% | **60.0%** | 0.0% | 70.0% | 524 | 30 |
