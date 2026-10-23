# Baby PRD -- Building a dependency-free Node.js CLI for word counting with resilient per-file error handling

## TL;DR
- A small command-line program you run in a terminal to count words in text files.
- You give it one or more files and it prints how many words each file has.
- At the end it prints a combined total across all the files.
- If a file is missing, it shows an error for that file but keeps going with the rest.
- You'll know it works when the counts match the files and a missing file doesn't stop the others.

## Baby PRD

### Problem
Counting words across one or more text files by hand is tedious and error-prone, and a missing file should not abort the whole job.

### Users / who it's for
Developers or technical users who want a quick, dependency-free way to count words in text files from the command line.

### In scope
- A Node.js CLI that accepts one or more file path arguments
- Printing a word count for each file provided
- Printing a combined total word count across all successfully read files
- Printing an error message for each missing or unreadable file while continuing with the remaining files
- Using only the Node.js standard library (no third-party dependencies)

### Out of scope
- Counting lines or characters
- Recursive directory traversal or glob expansion
- Reading from standard input (stdin) instead of files
- Support for non-UTF-8 encodings
- Internationalized or locale-aware word segmentation
- Installation/publishing to a package registry

### Acceptance criteria
1. Running the tool with a single text file prints that file's name and a word count equal to the number of whitespace-separated tokens in the file
2. Running the tool with multiple text files prints a separate count line for each file
3. After the per-file lines, the tool prints a total equal to the sum of the individual file word counts
4. Running the tool with a path to a nonexistent file prints an error message identifying that file
5. When a missing file is included alongside valid files, the valid files are still counted and the total still prints
6. The tool imports only Node.js built-in modules and has no entries in package.json dependencies
7. A missing file causes a nonzero process exit code while valid files are still processed and printed

### Constraints
- Language/runtime: Node.js
- Only the Node.js standard library may be used (no external npm packages)
- Delivered as a command-line tool

### Research plan
- Topic: Building a dependency-free Node.js CLI for word counting with resilient per-file error handling
- Time range: last 3 years
- Items:
  1. node-fs-cli-args | Reading files and CLI arguments with the Node standard library | How to read process arguments, read file contents, and distinguish a missing-file error (ENOENT) from other read errors using only built-in modules | modules: general-web, stackoverflow
  2. resilient-error-exit-codes | Per-file error handling and process exit codes in Node CLIs | How to continue processing remaining files after one fails and set an appropriate exit code to signal partial failure | modules: general-web, github-debug
- Official docs to read:
  - Node.js
- Academic searches:
  - (none)
- Prior-art searches:
  - node.js word count cli standard library
  - node cli count words per file total

## Assumptions
- [risky] A 'word' is defined as a run of non-whitespace characters separated by whitespace (whitespace-delimited tokens).
- [safe] Files are UTF-8 encoded plain text.
- [safe] File paths are passed as command-line arguments (e.g. 'node wc.js a.txt b.txt'), not via stdin or a config file.
- [safe] Each file's count is printed on its own line in the format 'count<whitespace>filename', similar to the Unix 'wc' tool.
- [safe] Per-file error messages are printed to stderr and the counts to stdout.
- [safe] The total line is printed once after all per-file lines, labeled as a total.
- [safe] The tool exits with a nonzero status code if any file could not be read, and zero otherwise.
- [safe] Files are read synchronously and fully into memory (files are assumed small enough to fit comfortably).
- [safe] Running the tool with no file arguments prints a brief usage message.
- [safe] The tool targets a reasonably current Node.js LTS version (18 or later).
