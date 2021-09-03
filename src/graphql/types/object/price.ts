import { GT } from "@graphql/index"
import SafeInt from "../scalar/safe-int"

import ExchangeCurrencyUnit from "../scalar/exchange-currency-unit"

const Price = new GT.Object({
  name: "Price",
  fields: () => ({
    base: { type: GT.NonNull(SafeInt) },
    offset: { type: GT.NonNull(GT.Int) },
    currencyUnit: { type: GT.NonNull(ExchangeCurrencyUnit) },
    formattedAmount: { type: GT.NonNull(GT.String) },
  }),
})

export default Price