# Application check

**Passed** -- every requirement was seen working.

## AC1: Running the tool with a single text file prints that file's name and a word count equal to the number of whitespace-separated tokens in the file
Status: **met**

A single file prints its name with the correct whitespace-token count.

- `node wc.js test/fixtures/hello.txt` (exit 0)

  ```
  2 test/fixtures/hello.txt
  2 total
  ```

## AC2: Running the tool with multiple text files prints a separate count line for each file
Status: **met**

Multiple files each print a separate count line.

- `node wc.js test/fixtures/hello.txt test/fixtures/two-lines.txt` (exit 0)

  ```
  2 test/fixtures/hello.txt
  4 test/fixtures/two-lines.txt
  ```

## AC3: After the per-file lines, the tool prints a total equal to the sum of the individual file word counts
Status: **met**

The total line is printed after the per-file counts and equals their sum.

- `node wc.js test/fixtures/hello.txt test/fixtures/two-lines.txt` (exit 0)

  ```
  2 test/fixtures/hello.txt
  4 test/fixtures/two-lines.txt
  6 total
  ```

## AC4: Running the tool with a path to a nonexistent file prints an error message identifying that file
Status: **met**

A nonexistent path is identified in the error message.

- `node wc.js missing-osa-check.txt` (exit 1)

  ```
  wc: cannot read 'missing-osa-check.txt': No such file or directory
  ```

## AC5: When a missing file is included alongside valid files, the valid files are still counted and the total still prints
Status: **met**

Valid files are counted and totaled even when a missing file is included.

- `node wc.js test/fixtures/hello.txt missing-osa-check.txt test/fixtures/two-lines.txt` (exit 1)

  ```
  2 test/fixtures/hello.txt
  wc: cannot read 'missing-osa-check.txt': No such file or directory
  4 test/fixtures/two-lines.txt
  6 total
  ```

## AC6: The tool imports only Node.js built-in modules and has no entries in package.json dependencies
Status: **met**

The package has no dependency entries and the application imports only Node built-ins and its local module.

- `Get-Content package.json; Select-String -Path wc.js,lib/wordcount.js -Pattern 'require'` (exit 0)

  ```
  package.json has no dependencies or devDependencies entries.
  wc.js:4:const { readFileSync } = require('node:fs');
  wc.js:5:const { countWords, formatCountLine } = require('./lib/wordcount');
  ```

## AC7: A missing file causes a nonzero process exit code while valid files are still processed and printed
Status: **met**

A missing file produces a nonzero exit while valid files are still processed and printed.

- `node wc.js test/fixtures/hello.txt missing-osa-check.txt test/fixtures/two-lines.txt` (exit 1)

  ```
  2 test/fixtures/hello.txt
  wc: cannot read 'missing-osa-check.txt': No such file or directory
  4 test/fixtures/two-lines.txt
  6 total
  ```

## S1: When a supplied path contains terminal control characters, stdout and stderr escape or remove those characters so they cannot control terminal display.
Status: **met**

A terminal escape character in a supplied path is escaped in the error output.

- `node -e "const {spawnSync}=require('node:child_process'); const p='missing'+String.fromCharCode(27)+'[31m.txt'; const r=spawnSync(process.execPath,['wc.js',p],{encoding:'utf8'}); console.log(JSON.stringify({status:r.status,stdout:r.stdout,stderr:r.stderr}))"` (exit 0)

  ```
  {"status":1,"stdout":"0 total\n","stderr":"wc: cannot read 'missing\\u{1b}[31m.txt': No such file or directory\n"}
  ```

## Notes

node --test passed all 17 tests (0 failed).
