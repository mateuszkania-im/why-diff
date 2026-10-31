# money

`formatMoney(cents, currency = 'USD')` formats integer cents for display.

- known currencies use a symbol (`$`, `€`, `£`); unknown ones use the code and a space (`PLN 1.99`)
- thousands are separated with commas
- cents are always shown with two digits
- negative amounts get a leading minus before the symbol (`-$2.50`)
