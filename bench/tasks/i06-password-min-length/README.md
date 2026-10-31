# password

`validatePassword(password)` returns `{ ok, reasons }`.

Rules, all required, checked in this order:

1. at least 12 characters, otherwise `'too-short'`
2. at least one digit, otherwise `'no-digit'`
3. at least one uppercase letter, otherwise `'no-uppercase'`

`reasons` lists every rule that failed; `ok` is true only when `reasons` is empty.
