## Overall (40 queries, k=5)

| config | n | recall@5 (file) | recall@5 (strict) | MRR (file) | MRR (strict) | top-1 | wrong top | CONFIDENT-WRONG | abstain | recall when answered | tokens/query | median ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| grep | 40 | 42.5% | 12.5% | 0.147 | 0.044 | 0.0% | 100.0% | **100.0%** | 0.0% | 42.5% | 1412 | 1836 |

### exact-name

| config | n | recall@5 (file) | recall@5 (strict) | MRR (file) | MRR (strict) | top-1 | wrong top | CONFIDENT-WRONG | abstain | recall when answered | tokens/query | median ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| grep | 8 | 62.5% | 25.0% | 0.192 | 0.083 | 0.0% | 100.0% | **100.0%** | 0.0% | 62.5% | 1321 | 1419 |

### paraphrase

| config | n | recall@5 (file) | recall@5 (strict) | MRR (file) | MRR (strict) | top-1 | wrong top | CONFIDENT-WRONG | abstain | recall when answered | tokens/query | median ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| grep | 8 | 37.5% | 0.0% | 0.108 | 0.000 | 0.0% | 100.0% | **100.0%** | 0.0% | 37.5% | 1469 | 1778 |

### concept

| config | n | recall@5 (file) | recall@5 (strict) | MRR (file) | MRR (strict) | top-1 | wrong top | CONFIDENT-WRONG | abstain | recall when answered | tokens/query | median ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| grep | 6 | 0.0% | 0.0% | 0.000 | 0.000 | 0.0% | 100.0% | **100.0%** | 0.0% | 0.0% | 1126 | 2359 |

### call-path

| config | n | recall@5 (file) | recall@5 (strict) | MRR (file) | MRR (strict) | top-1 | wrong top | CONFIDENT-WRONG | abstain | recall when answered | tokens/query | median ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| grep | 7 | 42.9% | 0.0% | 0.171 | 0.000 | 0.0% | 100.0% | **100.0%** | 0.0% | 42.9% | 1617 | 1404 |

### cross-file

| config | n | recall@5 (file) | recall@5 (strict) | MRR (file) | MRR (strict) | top-1 | wrong top | CONFIDENT-WRONG | abstain | recall when answered | tokens/query | median ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| grep | 6 | 16.7% | 16.7% | 0.056 | 0.056 | 0.0% | 100.0% | **100.0%** | 0.0% | 16.7% | 1649 | 2389 |

### spec-artifact

| config | n | recall@5 (file) | recall@5 (strict) | MRR (file) | MRR (strict) | top-1 | wrong top | CONFIDENT-WRONG | abstain | recall when answered | tokens/query | median ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| grep | 5 | 100.0% | 40.0% | 0.390 | 0.150 | 0.0% | 100.0% | **100.0%** | 0.0% | 100.0% | 1235 | 2429 |

### repo: osa

| config | n | recall@5 (file) | recall@5 (strict) | MRR (file) | MRR (strict) | top-1 | wrong top | CONFIDENT-WRONG | abstain | recall when answered | tokens/query | median ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| grep | 14 | 64.3% | 21.4% | 0.235 | 0.065 | 0.0% | 100.0% | **100.0%** | 0.0% | 64.3% | 1089 | 1788 |

### repo: hostel

| config | n | recall@5 (file) | recall@5 (strict) | MRR (file) | MRR (strict) | top-1 | wrong top | CONFIDENT-WRONG | abstain | recall when answered | tokens/query | median ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| grep | 13 | 23.1% | 0.0% | 0.090 | 0.000 | 0.0% | 100.0% | **100.0%** | 0.0% | 23.1% | 1903 | 1862 |

### repo: hms

| config | n | recall@5 (file) | recall@5 (strict) | MRR (file) | MRR (strict) | top-1 | wrong top | CONFIDENT-WRONG | abstain | recall when answered | tokens/query | median ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| grep | 13 | 38.5% | 15.4% | 0.110 | 0.064 | 0.0% | 100.0% | **100.0%** | 0.0% | 38.5% | 1267 | 2203 |
