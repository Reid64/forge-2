---
id: multi-currency
name: Multi-Currency Money Handling
domain: business
tags: [billing, payments]
applicablePromptTypes: [feature, api]
---

SMALLEST UNIT STORAGE: Store every monetary amount in the smallest unit of its currency (cents for USD/EUR, yen for JPY — zero-decimal currencies are never multiplied by 100). Never store a decimal/float dollar amount.

CURRENCY CODE WITH EVERY AMOUNT: Every amount column/field travels with its ISO 4217 currency code (e.g. amount_cents + currency: 'usd'). Never assume a global default currency once more than one is supported.

INTEGER MATH ONLY: All arithmetic on amounts (totals, discounts, tax, splits) uses integer math on the smallest-unit value. Never perform addition/multiplication/division on a floating-point representation of an amount — floating point cannot represent money exactly and produces off-by-one-cent bugs.

DISPLAY FORMATTING: Convert to a display string only at the presentation layer via Intl.NumberFormat(locale, { style: 'currency', currency }). Never hand-build currency strings by dividing by 100 and concatenating a symbol.

REFUND CEILING: A refund (partial or full) must never exceed the original charged amount in the original currency. Validate refund_amount_cents <= original_amount_cents - already_refunded_cents before issuing.

CONVERSION BOUNDARY: If displaying a converted estimate in another currency, label it clearly as an estimate and never use a converted value for an actual charge, refund, or ledger entry — the ledger's currency is always the currency it was charged in.
