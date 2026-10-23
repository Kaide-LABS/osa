## Overall (30 queries, k=5)

| config | n | recall@5 (file) | recall@5 (strict) | MRR (file) | MRR (strict) | top-1 | wrong top | CONFIDENT-WRONG | abstain | recall when answered | tokens/query | median ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| grep | 30 | 43.3% | 20.0% | 0.311 | 0.183 | 23.3% | 76.7% | **76.7%** | 0.0% | 43.3% | 1730 | 2793 |
| lexical | 30 | 36.7% | 26.7% | 0.243 | 0.170 | 16.7% | 83.3% | **83.3%** | 0.0% | 36.7% | 525 | 622 |

### exact-name

| config | n | recall@5 (file) | recall@5 (strict) | MRR (file) | MRR (strict) | top-1 | wrong top | CONFIDENT-WRONG | abstain | recall when answered | tokens/query | median ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| grep | 5 | 100.0% | 100.0% | 1.000 | 1.000 | 100.0% | 0.0% | **0.0%** | 0.0% | 100.0% | 945 | 1548 |
| lexical | 5 | 100.0% | 100.0% | 0.900 | 0.900 | 80.0% | 20.0% | **20.0%** | 0.0% | 100.0% | 433 | 622 |

### paraphrase

| config | n | recall@5 (file) | recall@5 (strict) | MRR (file) | MRR (strict) | top-1 | wrong top | CONFIDENT-WRONG | abstain | recall when answered | tokens/query | median ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| grep | 8 | 25.0% | 0.0% | 0.167 | 0.000 | 12.5% | 87.5% | **87.5%** | 0.0% | 25.0% | 2256 | 3274 |
| lexical | 8 | 37.5% | 25.0% | 0.250 | 0.050 | 12.5% | 87.5% | **87.5%** | 0.0% | 37.5% | 547 | 628 |

### concept

| config | n | recall@5 (file) | recall@5 (strict) | MRR (file) | MRR (strict) | top-1 | wrong top | CONFIDENT-WRONG | abstain | recall when answered | tokens/query | median ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| grep | 6 | 0.0% | 0.0% | 0.000 | 0.000 | 0.0% | 100.0% | **100.0%** | 0.0% | 0.0% | 2490 | 3030 |
| lexical | 6 | 16.7% | 0.0% | 0.042 | 0.000 | 0.0% | 100.0% | **100.0%** | 0.0% | 16.7% | 556 | 631 |

### call-path

| config | n | recall@5 (file) | recall@5 (strict) | MRR (file) | MRR (strict) | top-1 | wrong top | CONFIDENT-WRONG | abstain | recall when answered | tokens/query | median ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| grep | 4 | 100.0% | 25.0% | 0.417 | 0.125 | 0.0% | 100.0% | **100.0%** | 0.0% | 100.0% | 1112 | 1719 |
| lexical | 4 | 25.0% | 25.0% | 0.050 | 0.050 | 0.0% | 100.0% | **100.0%** | 0.0% | 25.0% | 481 | 551 |

### cross-file

| config | n | recall@5 (file) | recall@5 (strict) | MRR (file) | MRR (strict) | top-1 | wrong top | CONFIDENT-WRONG | abstain | recall when answered | tokens/query | median ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| grep | 4 | 25.0% | 0.0% | 0.250 | 0.000 | 25.0% | 75.0% | **75.0%** | 0.0% | 25.0% | 1176 | 3247 |
| lexical | 4 | 25.0% | 0.0% | 0.083 | 0.000 | 0.0% | 100.0% | **100.0%** | 0.0% | 25.0% | 606 | 602 |

### spec-artifact

| config | n | recall@5 (file) | recall@5 (strict) | MRR (file) | MRR (strict) | top-1 | wrong top | CONFIDENT-WRONG | abstain | recall when answered | tokens/query | median ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| grep | 3 | 33.3% | 0.0% | 0.111 | 0.000 | 0.0% | 100.0% | **100.0%** | 0.0% | 33.3% | 1681 | 2743 |
| lexical | 3 | 0.0% | 0.0% | 0.000 | 0.000 | 0.0% | 100.0% | **100.0%** | 0.0% | 0.0% | 512 | 708 |

### repo: osa-clean

| config | n | recall@5 (file) | recall@5 (strict) | MRR (file) | MRR (strict) | top-1 | wrong top | CONFIDENT-WRONG | abstain | recall when answered | tokens/query | median ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| grep | 30 | 43.3% | 20.0% | 0.311 | 0.183 | 23.3% | 76.7% | **76.7%** | 0.0% | 43.3% | 1730 | 2793 |
| lexical | 30 | 36.7% | 26.7% | 0.243 | 0.170 | 16.7% | 83.3% | **83.3%** | 0.0% | 36.7% | 525 | 622 |
