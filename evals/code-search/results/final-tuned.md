## Overall (40 queries, k=5)

| config | n | recall@5 (file) | recall@5 (strict) | MRR (file) | MRR (strict) | top-1 | wrong top | CONFIDENT-WRONG | abstain | recall when answered | tokens/query | median ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| cbm-guarded | 40 | 47.5% | 40.0% | 0.384 | 0.317 | 32.5% | 67.5% | **10.0%** | 65.0% | 78.6% | 643 | 963 |

### exact-name

| config | n | recall@5 (file) | recall@5 (strict) | MRR (file) | MRR (strict) | top-1 | wrong top | CONFIDENT-WRONG | abstain | recall when answered | tokens/query | median ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| cbm-guarded | 8 | 100.0% | 100.0% | 1.000 | 1.000 | 100.0% | 0.0% | **0.0%** | 0.0% | 100.0% | 707 | 803 |

### paraphrase

| config | n | recall@5 (file) | recall@5 (strict) | MRR (file) | MRR (strict) | top-1 | wrong top | CONFIDENT-WRONG | abstain | recall when answered | tokens/query | median ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| cbm-guarded | 8 | 25.0% | 12.5% | 0.104 | 0.042 | 0.0% | 100.0% | **12.5%** | 87.5% | 100.0% | 562 | 963 |

### concept

| config | n | recall@5 (file) | recall@5 (strict) | MRR (file) | MRR (strict) | top-1 | wrong top | CONFIDENT-WRONG | abstain | recall when answered | tokens/query | median ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| cbm-guarded | 6 | 16.7% | 16.7% | 0.056 | 0.056 | 0.0% | 100.0% | **33.3%** | 66.7% | 0.0% | 743 | 832 |

### call-path

| config | n | recall@5 (file) | recall@5 (strict) | MRR (file) | MRR (strict) | top-1 | wrong top | CONFIDENT-WRONG | abstain | recall when answered | tokens/query | median ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| cbm-guarded | 7 | 28.6% | 28.6% | 0.286 | 0.214 | 28.6% | 71.4% | **14.3%** | 57.1% | 66.7% | 623 | 859 |

### cross-file

| config | n | recall@5 (file) | recall@5 (strict) | MRR (file) | MRR (strict) | top-1 | wrong top | CONFIDENT-WRONG | abstain | recall when answered | tokens/query | median ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| cbm-guarded | 6 | 33.3% | 16.7% | 0.333 | 0.167 | 33.3% | 66.7% | **0.0%** | 100.0% | n/a | 632 | 1096 |

### spec-artifact

| config | n | recall@5 (file) | recall@5 (strict) | MRR (file) | MRR (strict) | top-1 | wrong top | CONFIDENT-WRONG | abstain | recall when answered | tokens/query | median ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| cbm-guarded | 5 | 80.0% | 60.0% | 0.440 | 0.300 | 20.0% | 80.0% | **0.0%** | 100.0% | n/a | 590 | 1128 |

### repo: osa

| config | n | recall@5 (file) | recall@5 (strict) | MRR (file) | MRR (strict) | top-1 | wrong top | CONFIDENT-WRONG | abstain | recall when answered | tokens/query | median ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| cbm-guarded | 14 | 64.3% | 57.1% | 0.571 | 0.464 | 50.0% | 50.0% | **7.1%** | 57.1% | 83.3% | 532 | 1002 |

### repo: hostel

| config | n | recall@5 (file) | recall@5 (strict) | MRR (file) | MRR (strict) | top-1 | wrong top | CONFIDENT-WRONG | abstain | recall when answered | tokens/query | median ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| cbm-guarded | 13 | 38.5% | 30.8% | 0.295 | 0.256 | 23.1% | 76.9% | **23.1%** | 53.8% | 66.7% | 706 | 638 |

### repo: hms

| config | n | recall@5 (file) | recall@5 (strict) | MRR (file) | MRR (strict) | top-1 | wrong top | CONFIDENT-WRONG | abstain | recall when answered | tokens/query | median ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| cbm-guarded | 13 | 38.5% | 30.8% | 0.272 | 0.218 | 23.1% | 76.9% | **0.0%** | 84.6% | 100.0% | 699 | 1634 |
