# dates

`parseIsoDate('YYYY-MM-DD')` returns `{ year, month, day }` (month is 1-12).

Strict parsing: the string must match the format exactly and name a real calendar day (leap years
are respected). Anything else throws a `RangeError`. There is no rollover: `'2023-02-30'` is an
error, not March 2.
