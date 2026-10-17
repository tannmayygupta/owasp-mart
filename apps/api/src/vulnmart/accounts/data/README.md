# Data files of the accounts module

## common-passwords-10k.txt
The 10,000 most common passwords, one per line, used by `accounts/passwords.py` to refuse a password that is on every attacker's list (FR-ACC-08).

- Source: SecLists, `Passwords/Common-Credentials/10k-most-common.txt` (https://github.com/danielmiessler/SecLists), last changed in commit `913b327317496d062bcc7cace524aaad8a693be2` (2026-09-08), downloaded 2026-10-17.
- Licence: MIT, copyright (c) 2018 Daniel Miessler (SecLists `LICENSE`).
- Content checked on download: 10,001 lines, all distinct when lower-cased, plain ASCII, no control characters, longest entry 18 characters. The file is stored unchanged (it already used LF line endings).
- SHA-256 of the file as downloaded and as stored: `68782D6A4A19A4768D5F15DD66BD534E7A33055CC755411E33F16D18C50FDCCE` (a checkout on Windows may convert line endings, which changes the hash but not the entries; the loader ignores line endings).
- It is data, never code: the loader reads it as text and compares lower-cased lines. Update it deliberately (a new download, the same checks, a new line in this file), never automatically.
