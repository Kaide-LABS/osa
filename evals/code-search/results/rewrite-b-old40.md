## Overall (40 queries, k=5)

| config | n | recall@5 (file) | recall@5 (strict) | MRR (file) | MRR (strict) | top-1 | wrong top | CONFIDENT-WRONG | abstain | recall when answered | tokens/query | median ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| B0 control: default weights, unguarded, no rewrite | 40 | 57.5% | 50.0% | 0.428 | 0.382 | 35.0% | 65.0% | **65.0%** | 0.0% | 57.5% | 614 | 907 |
| B1 base mix, no rewrite | 40 | 72.5% | 65.0% | 0.564 | 0.475 | 47.5% | 52.5% | **52.5%** | 0.0% | 72.5% | 705 | 803 |
| B2 base mix + rewrite (plain) | 40 | 85.0% | 67.5% | 0.700 | 0.492 | 62.5% | 37.5% | **37.5%** | 0.0% | 85.0% | 641 | 1048 |
| B3 base mix + rewrite (with file paths) | 40 | 87.5% | 70.0% | 0.716 | 0.559 | 62.5% | 37.5% | **37.5%** | 0.0% | 87.5% | 608 | 1045 |
| B4 code channel only + rewrite (paths) | 40 | 70.0% | 52.5% | 0.517 | 0.360 | 42.5% | 57.5% | **57.5%** | 0.0% | 70.0% | 760 | 24 |
| B5 code 3 + bm25 2 + rewrite (paths), no semantic | 40 | 87.5% | 70.0% | 0.714 | 0.567 | 62.5% | 37.5% | **37.5%** | 0.0% | 87.5% | 613 | 22 |
| B6 code 3 + bm25 2 + lexical 1 + rewrite (paths) | 40 | 85.0% | 70.0% | 0.711 | 0.554 | 62.5% | 37.5% | **37.5%** | 0.0% | 85.0% | 605 | 18 |

### exact-name

| config | n | recall@5 (file) | recall@5 (strict) | MRR (file) | MRR (strict) | top-1 | wrong top | CONFIDENT-WRONG | abstain | recall when answered | tokens/query | median ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| B0 control: default weights, unguarded, no rewrite | 8 | 100.0% | 100.0% | 1.000 | 1.000 | 100.0% | 0.0% | **0.0%** | 0.0% | 100.0% | 608 | 953 |
| B1 base mix, no rewrite | 8 | 100.0% | 100.0% | 1.000 | 1.000 | 100.0% | 0.0% | **0.0%** | 0.0% | 100.0% | 683 | 732 |
| B2 base mix + rewrite (plain) | 8 | 100.0% | 100.0% | 1.000 | 1.000 | 100.0% | 0.0% | **0.0%** | 0.0% | 100.0% | 672 | 1029 |
| B3 base mix + rewrite (with file paths) | 8 | 100.0% | 100.0% | 0.854 | 0.817 | 75.0% | 25.0% | **25.0%** | 0.0% | 100.0% | 612 | 932 |
| B4 code channel only + rewrite (paths) | 8 | 87.5% | 75.0% | 0.456 | 0.369 | 25.0% | 75.0% | **75.0%** | 0.0% | 87.5% | 782 | 22 |
| B5 code 3 + bm25 2 + rewrite (paths), no semantic | 8 | 100.0% | 100.0% | 0.844 | 0.838 | 75.0% | 25.0% | **25.0%** | 0.0% | 100.0% | 625 | 20 |
| B6 code 3 + bm25 2 + lexical 1 + rewrite (paths) | 8 | 100.0% | 100.0% | 0.854 | 0.854 | 75.0% | 25.0% | **25.0%** | 0.0% | 100.0% | 630 | 33 |

### paraphrase

| config | n | recall@5 (file) | recall@5 (strict) | MRR (file) | MRR (strict) | top-1 | wrong top | CONFIDENT-WRONG | abstain | recall when answered | tokens/query | median ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| B0 control: default weights, unguarded, no rewrite | 8 | 50.0% | 37.5% | 0.160 | 0.098 | 0.0% | 100.0% | **100.0%** | 0.0% | 50.0% | 634 | 870 |
| B1 base mix, no rewrite | 8 | 50.0% | 50.0% | 0.254 | 0.150 | 12.5% | 87.5% | **87.5%** | 0.0% | 50.0% | 751 | 730 |
| B2 base mix + rewrite (plain) | 8 | 75.0% | 50.0% | 0.650 | 0.338 | 62.5% | 37.5% | **37.5%** | 0.0% | 75.0% | 532 | 1061 |
| B3 base mix + rewrite (with file paths) | 8 | 87.5% | 75.0% | 0.713 | 0.588 | 62.5% | 37.5% | **37.5%** | 0.0% | 87.5% | 535 | 829 |
| B4 code channel only + rewrite (paths) | 8 | 62.5% | 37.5% | 0.463 | 0.281 | 37.5% | 62.5% | **62.5%** | 0.0% | 62.5% | 802 | 28 |
| B5 code 3 + bm25 2 + rewrite (paths), no semantic | 8 | 87.5% | 75.0% | 0.713 | 0.588 | 62.5% | 37.5% | **37.5%** | 0.0% | 87.5% | 535 | 23 |
| B6 code 3 + bm25 2 + lexical 1 + rewrite (paths) | 8 | 75.0% | 75.0% | 0.688 | 0.588 | 62.5% | 37.5% | **37.5%** | 0.0% | 75.0% | 527 | 20 |

### concept

| config | n | recall@5 (file) | recall@5 (strict) | MRR (file) | MRR (strict) | top-1 | wrong top | CONFIDENT-WRONG | abstain | recall when answered | tokens/query | median ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| B0 control: default weights, unguarded, no rewrite | 6 | 33.3% | 33.3% | 0.250 | 0.250 | 16.7% | 83.3% | **83.3%** | 0.0% | 33.3% | 568 | 838 |
| B1 base mix, no rewrite | 6 | 66.7% | 33.3% | 0.458 | 0.250 | 33.3% | 66.7% | **66.7%** | 0.0% | 66.7% | 761 | 757 |
| B2 base mix + rewrite (plain) | 6 | 83.3% | 83.3% | 0.556 | 0.431 | 33.3% | 66.7% | **66.7%** | 0.0% | 83.3% | 632 | 1088 |
| B3 base mix + rewrite (with file paths) | 6 | 100.0% | 50.0% | 0.700 | 0.375 | 50.0% | 50.0% | **50.0%** | 0.0% | 100.0% | 635 | 1131 |
| B4 code channel only + rewrite (paths) | 6 | 66.7% | 33.3% | 0.431 | 0.200 | 33.3% | 66.7% | **66.7%** | 0.0% | 66.7% | 794 | 22 |
| B5 code 3 + bm25 2 + rewrite (paths), no semantic | 6 | 100.0% | 50.0% | 0.700 | 0.375 | 50.0% | 50.0% | **50.0%** | 0.0% | 100.0% | 664 | 34 |
| B6 code 3 + bm25 2 + lexical 1 + rewrite (paths) | 6 | 100.0% | 50.0% | 0.700 | 0.389 | 50.0% | 50.0% | **50.0%** | 0.0% | 100.0% | 642 | 23 |

### call-path

| config | n | recall@5 (file) | recall@5 (strict) | MRR (file) | MRR (strict) | top-1 | wrong top | CONFIDENT-WRONG | abstain | recall when answered | tokens/query | median ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| B0 control: default weights, unguarded, no rewrite | 7 | 42.9% | 42.9% | 0.429 | 0.429 | 42.9% | 57.1% | **57.1%** | 0.0% | 42.9% | 617 | 997 |
| B1 base mix, no rewrite | 7 | 85.7% | 71.4% | 0.619 | 0.476 | 42.9% | 57.1% | **57.1%** | 0.0% | 85.7% | 622 | 978 |
| B2 base mix + rewrite (plain) | 7 | 100.0% | 57.1% | 0.707 | 0.386 | 57.1% | 42.9% | **42.9%** | 0.0% | 100.0% | 654 | 1010 |
| B3 base mix + rewrite (with file paths) | 7 | 85.7% | 57.1% | 0.560 | 0.476 | 42.9% | 57.1% | **57.1%** | 0.0% | 85.7% | 662 | 1271 |
| B4 code channel only + rewrite (paths) | 7 | 85.7% | 57.1% | 0.750 | 0.393 | 71.4% | 28.6% | **28.6%** | 0.0% | 85.7% | 695 | 32 |
| B5 code 3 + bm25 2 + rewrite (paths), no semantic | 7 | 85.7% | 57.1% | 0.560 | 0.476 | 42.9% | 57.1% | **57.1%** | 0.0% | 85.7% | 661 | 18 |
| B6 code 3 + bm25 2 + lexical 1 + rewrite (paths) | 7 | 85.7% | 57.1% | 0.560 | 0.476 | 42.9% | 57.1% | **57.1%** | 0.0% | 85.7% | 664 | 15 |

### cross-file

| config | n | recall@5 (file) | recall@5 (strict) | MRR (file) | MRR (strict) | top-1 | wrong top | CONFIDENT-WRONG | abstain | recall when answered | tokens/query | median ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| B0 control: default weights, unguarded, no rewrite | 6 | 50.0% | 50.0% | 0.278 | 0.278 | 16.7% | 83.3% | **83.3%** | 0.0% | 50.0% | 616 | 985 |
| B1 base mix, no rewrite | 6 | 100.0% | 100.0% | 0.742 | 0.742 | 66.7% | 33.3% | **33.3%** | 0.0% | 100.0% | 660 | 819 |
| B2 base mix + rewrite (plain) | 6 | 100.0% | 83.3% | 0.750 | 0.450 | 66.7% | 33.3% | **33.3%** | 0.0% | 100.0% | 631 | 819 |
| B3 base mix + rewrite (with file paths) | 6 | 100.0% | 100.0% | 1.000 | 0.756 | 100.0% | 0.0% | **0.0%** | 0.0% | 100.0% | 556 | 1278 |
| B4 code channel only + rewrite (paths) | 6 | 100.0% | 100.0% | 0.917 | 0.875 | 83.3% | 16.7% | **16.7%** | 0.0% | 100.0% | 719 | 28 |
| B5 code 3 + bm25 2 + rewrite (paths), no semantic | 6 | 100.0% | 100.0% | 1.000 | 0.783 | 100.0% | 0.0% | **0.0%** | 0.0% | 100.0% | 538 | 21 |
| B6 code 3 + bm25 2 + lexical 1 + rewrite (paths) | 6 | 100.0% | 100.0% | 1.000 | 0.658 | 100.0% | 0.0% | **0.0%** | 0.0% | 100.0% | 526 | 18 |

### spec-artifact

| config | n | recall@5 (file) | recall@5 (strict) | MRR (file) | MRR (strict) | top-1 | wrong top | CONFIDENT-WRONG | abstain | recall when answered | tokens/query | median ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| B0 control: default weights, unguarded, no rewrite | 5 | 60.0% | 20.0% | 0.333 | 0.067 | 20.0% | 80.0% | **80.0%** | 0.0% | 60.0% | 643 | 852 |
| B1 base mix, no rewrite | 5 | 20.0% | 20.0% | 0.200 | 0.100 | 20.0% | 80.0% | **80.0%** | 0.0% | 20.0% | 773 | 1247 |
| B2 base mix + rewrite (plain) | 5 | 40.0% | 20.0% | 0.400 | 0.200 | 40.0% | 60.0% | **60.0%** | 0.0% | 40.0% | 774 | 1263 |
| B3 base mix + rewrite (with file paths) | 5 | 40.0% | 20.0% | 0.400 | 0.200 | 40.0% | 60.0% | **60.0%** | 0.0% | 40.0% | 675 | 1765 |
| B4 code channel only + rewrite (paths) | 5 | 0.0% | 0.0% | 0.000 | 0.000 | 0.0% | 100.0% | **100.0%** | 0.0% | 0.0% | 756 | 22 |
| B5 code 3 + bm25 2 + rewrite (paths), no semantic | 5 | 40.0% | 20.0% | 0.400 | 0.200 | 40.0% | 60.0% | **60.0%** | 0.0% | 40.0% | 677 | 17 |
| B6 code 3 + bm25 2 + lexical 1 + rewrite (paths) | 5 | 40.0% | 20.0% | 0.400 | 0.200 | 40.0% | 60.0% | **60.0%** | 0.0% | 40.0% | 660 | 22 |

### repo: osa

| config | n | recall@5 (file) | recall@5 (strict) | MRR (file) | MRR (strict) | top-1 | wrong top | CONFIDENT-WRONG | abstain | recall when answered | tokens/query | median ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| B0 control: default weights, unguarded, no rewrite | 14 | 85.7% | 71.4% | 0.621 | 0.562 | 50.0% | 50.0% | **50.0%** | 0.0% | 85.7% | 509 | 904 |
| B1 base mix, no rewrite | 14 | 71.4% | 71.4% | 0.657 | 0.574 | 64.3% | 35.7% | **35.7%** | 0.0% | 71.4% | 642 | 803 |
| B2 base mix + rewrite (plain) | 14 | 78.6% | 71.4% | 0.729 | 0.514 | 71.4% | 28.6% | **28.6%** | 0.0% | 78.6% | 498 | 1048 |
| B3 base mix + rewrite (with file paths) | 14 | 85.7% | 64.3% | 0.660 | 0.538 | 57.1% | 42.9% | **42.9%** | 0.0% | 85.7% | 495 | 1045 |
| B4 code channel only + rewrite (paths) | 14 | 57.1% | 50.0% | 0.482 | 0.429 | 42.9% | 57.1% | **57.1%** | 0.0% | 57.1% | 690 | 68 |
| B5 code 3 + bm25 2 + rewrite (paths), no semantic | 14 | 85.7% | 64.3% | 0.671 | 0.550 | 57.1% | 42.9% | **42.9%** | 0.0% | 85.7% | 502 | 119 |
| B6 code 3 + bm25 2 + lexical 1 + rewrite (paths) | 14 | 78.6% | 64.3% | 0.657 | 0.514 | 57.1% | 42.9% | **42.9%** | 0.0% | 78.6% | 488 | 42 |

### repo: hostel

| config | n | recall@5 (file) | recall@5 (strict) | MRR (file) | MRR (strict) | top-1 | wrong top | CONFIDENT-WRONG | abstain | recall when answered | tokens/query | median ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| B0 control: default weights, unguarded, no rewrite | 13 | 53.8% | 53.8% | 0.378 | 0.378 | 30.8% | 69.2% | **69.2%** | 0.0% | 53.8% | 624 | 616 |
| B1 base mix, no rewrite | 13 | 76.9% | 69.2% | 0.513 | 0.481 | 38.5% | 61.5% | **61.5%** | 0.0% | 76.9% | 696 | 536 |
| B2 base mix + rewrite (plain) | 13 | 92.3% | 69.2% | 0.756 | 0.541 | 69.2% | 30.8% | **30.8%** | 0.0% | 92.3% | 630 | 538 |
| B3 base mix + rewrite (with file paths) | 13 | 76.9% | 76.9% | 0.692 | 0.599 | 61.5% | 38.5% | **38.5%** | 0.0% | 76.9% | 596 | 555 |
| B4 code channel only + rewrite (paths) | 13 | 84.6% | 69.2% | 0.456 | 0.396 | 30.8% | 69.2% | **69.2%** | 0.0% | 84.6% | 777 | 22 |
| B5 code 3 + bm25 2 + rewrite (paths), no semantic | 13 | 76.9% | 76.9% | 0.673 | 0.612 | 61.5% | 38.5% | **38.5%** | 0.0% | 76.9% | 598 | 20 |
| B6 code 3 + bm25 2 + lexical 1 + rewrite (paths) | 13 | 76.9% | 76.9% | 0.718 | 0.609 | 69.2% | 30.8% | **30.8%** | 0.0% | 76.9% | 598 | 16 |

### repo: hms

| config | n | recall@5 (file) | recall@5 (strict) | MRR (file) | MRR (strict) | top-1 | wrong top | CONFIDENT-WRONG | abstain | recall when answered | tokens/query | median ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| B0 control: default weights, unguarded, no rewrite | 13 | 30.8% | 23.1% | 0.269 | 0.192 | 23.1% | 76.9% | **76.9%** | 0.0% | 30.8% | 718 | 1569 |
| B1 base mix, no rewrite | 13 | 69.2% | 53.8% | 0.515 | 0.362 | 38.5% | 61.5% | **61.5%** | 0.0% | 69.2% | 783 | 1352 |
| B2 base mix + rewrite (plain) | 13 | 84.6% | 61.5% | 0.612 | 0.419 | 46.2% | 53.8% | **53.8%** | 0.0% | 84.6% | 807 | 1393 |
| B3 base mix + rewrite (with file paths) | 13 | 100.0% | 69.2% | 0.801 | 0.541 | 69.2% | 30.8% | **30.8%** | 0.0% | 100.0% | 742 | 1670 |
| B4 code channel only + rewrite (paths) | 13 | 69.2% | 38.5% | 0.615 | 0.250 | 53.8% | 46.2% | **46.2%** | 0.0% | 69.2% | 818 | 25 |
| B5 code 3 + bm25 2 + rewrite (paths), no semantic | 13 | 100.0% | 69.2% | 0.801 | 0.541 | 69.2% | 30.8% | **30.8%** | 0.0% | 100.0% | 746 | 17 |
| B6 code 3 + bm25 2 + lexical 1 + rewrite (paths) | 13 | 100.0% | 69.2% | 0.763 | 0.541 | 61.5% | 38.5% | **38.5%** | 0.0% | 100.0% | 739 | 13 |
