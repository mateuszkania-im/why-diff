# csv

`parseCsv(text)` returns an array of rows, each an array of string fields.

- fields are separated by commas; rows by `\n` or `\r\n`
- a field may be wrapped in double quotes; a quoted field may contain commas and newlines
- inside a quoted field, a doubled quote (`""`) is a literal `"`
- a trailing newline at the end of the input does not create an empty row
