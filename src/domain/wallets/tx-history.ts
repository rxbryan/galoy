import {
  MEMO_SHARING_CENTS_THRESHOLD,
  MEMO_SHARING_SATS_THRESHOLD,
  OnboardingEarn,
} from "@config"

import { toCents } from "@domain/fiat"
import { toSats } from "@domain/bitcoin"
import { WalletCurrency } from "@domain/shared"
import { AdminLedgerTransactionType, LedgerTransactionType } from "@domain/ledger"

import { TxStatus } from "./tx-status"
import { DepositFeeCalculator } from "./deposit-fee-calculator"
import { PaymentInitiationMethod, SettlementMethod } from "./tx-methods"

const filterPendingIncoming = ({
  pendingIncoming,
  addressesByWalletId,
  walletDetailsByWalletId,
  displayCurrencyPerSat,
}: AddPendingIncomingArgs): WalletOnChainTransaction[] => {
  const walletTransactions: WalletOnChainTransaction[] = []
  pendingIncoming.forEach(({ rawTx, createdAt }) => {
    rawTx.outs.forEach(({ sats, address }) => {
      if (address) {
        for (const walletIdString in addressesByWalletId) {
          const walletId = walletIdString as WalletId
          if (addressesByWalletId[walletId].includes(address)) {
            const fee = DepositFeeCalculator().onChainDepositFee({
              amount: sats,
              ratio: walletDetailsByWalletId[walletId].depositFeeRatio,
            })
            walletTransactions.push({
              id: rawTx.txHash,
              walletId,
              settlementAmount: toSats(sats - fee),
              settlementFee: fee,
              settlementCurrency: walletDetailsByWalletId[walletId].currency,
              displayCurrencyPerSettlementCurrencyUnit: displayCurrencyPerSat.price,
              status: TxStatus.Pending,
              memo: null,
              createdAt: createdAt,
              initiationVia: {
                type: PaymentInitiationMethod.OnChain,
                address,
              },
              settlementVia: {
                type: SettlementMethod.OnChain,
                transactionHash: rawTx.txHash,
              },
            })
          }
        }
      }
    })
  })
  return walletTransactions
}

const translateLedgerTxnToWalletTxn = <S extends WalletCurrency>(
  txn: LedgerTransaction<S>,
) => {
  const {
    type,
    credit,
    debit,
    currency,
    satsFee: satsFeeRaw,
    centsFee: centsFeeRaw,
    displayAmount: displayAmountRaw,
    displayFee: displayFeeRaw,
    lnMemo,
    memoFromPayer,
  } = txn

  const isAdmin = Object.values(AdminLedgerTransactionType).includes(
    type as AdminLedgerTransactionType,
  )

  let displayAmount: number
  let displayFee: number
  let satsFee: number
  let centsFee: number
  // Temp admin checks, to be removed when usd/feeUsd/fee fields are deprecated
  if (isAdmin) {
    displayAmount = txn.usd ? Math.round(txn.usd * 100) : 0
    displayFee = txn.feeUsd ? Math.round(txn.feeUsd * 100) : 0
    satsFee = txn.fee || 0
    centsFee = displayFee
  } else {
    displayAmount = displayAmountRaw || 0
    displayFee = displayFeeRaw || 0
    satsFee = satsFeeRaw || 0
    centsFee = centsFeeRaw || 0
  }

  const settlementAmount =
    currency === WalletCurrency.Btc ? toSats(credit - debit) : toCents(credit - debit)
  const settlementFee =
    currency === WalletCurrency.Btc ? toSats(satsFee) : toCents(centsFee)

  // 'displayAmount' is before fees. For total amount:
  // - send: displayAmount + displayFee
  // - recv: displayAmount
  const isSend = settlementAmount < 0
  const displayAmountAsNumber =
    isSend && !isAdmin ? displayAmount + displayFee : displayAmount

  const memo = translateMemo({
    memoFromPayer,
    lnMemo,
    credit,
    currency,
  })

  const status = txn.pendingConfirmation ? TxStatus.Pending : TxStatus.Success

  const baseTransaction = {
    id: txn.id,
    walletId: txn.walletId,
    settlementAmount,
    settlementFee,
    settlementCurrency: txn.currency,
    displayCurrencyPerSettlementCurrencyUnit: displayCurrencyPerBaseUnitFromAmounts({
      displayAmountAsNumber,
      settlementAmountInBaseAsNumber: settlementAmount,
    }),
    status,
    memo,
    createdAt: txn.timestamp,
  }

  let txType = txn.type
  if (txn.type == LedgerTransactionType.IntraLedger && txn.paymentHash) {
    txType = LedgerTransactionType.LnIntraLedger
  }

  const defaultOnChainAddress = "<no-address>" as OnChainAddress

  const { recipientWalletId, username, pubkey, paymentHash, txHash, address } = txn

  let walletTransaction: WalletTransaction
  switch (txType) {
    case LedgerTransactionType.IntraLedger:
    case LedgerTransactionType.WalletIdTradeIntraAccount:
      walletTransaction = {
        ...baseTransaction,
        initiationVia: {
          type: PaymentInitiationMethod.IntraLedger,
          counterPartyWalletId: recipientWalletId as WalletId,
          counterPartyUsername: username as Username,
        },
        settlementVia: {
          type: SettlementMethod.IntraLedger,
          counterPartyWalletId: recipientWalletId as WalletId,
          counterPartyUsername: username as Username,
        },
      }
      break

    case LedgerTransactionType.OnchainIntraLedger:
    case LedgerTransactionType.OnChainTradeIntraAccount:
      walletTransaction = {
        ...baseTransaction,
        initiationVia: {
          type: PaymentInitiationMethod.OnChain,
          address: address || defaultOnChainAddress,
        },
        settlementVia: {
          type: SettlementMethod.IntraLedger,
          counterPartyWalletId: recipientWalletId as WalletId,
          counterPartyUsername: username || null,
        },
      }
      break

    case LedgerTransactionType.OnchainPayment:
    case LedgerTransactionType.OnchainReceipt:
      walletTransaction = {
        ...baseTransaction,
        initiationVia: {
          type: PaymentInitiationMethod.OnChain,
          address: address || defaultOnChainAddress,
        },
        settlementVia: {
          type: SettlementMethod.OnChain,
          transactionHash: txHash as OnChainTxHash,
        },
      }
      break

    case LedgerTransactionType.LnIntraLedger:
    case LedgerTransactionType.LnTradeIntraAccount:
      walletTransaction = {
        ...baseTransaction,
        initiationVia: {
          type: PaymentInitiationMethod.Lightning,
          paymentHash: paymentHash as PaymentHash,
          pubkey: pubkey as Pubkey,
        },
        settlementVia: {
          type: SettlementMethod.IntraLedger,
          counterPartyWalletId: recipientWalletId as WalletId,
          counterPartyUsername: username || null,
        },
      }
      break

    case LedgerTransactionType.Payment:
    case LedgerTransactionType.Invoice:
      walletTransaction = {
        ...baseTransaction,
        initiationVia: {
          type: PaymentInitiationMethod.Lightning,
          paymentHash: paymentHash as PaymentHash,
          pubkey: pubkey as Pubkey,
        },
        settlementVia: {
          type: SettlementMethod.Lightning,
          revealedPreImage: undefined, // is added by dataloader in resolver
        },
      }
      break

    default:
      walletTransaction = {
        ...baseTransaction,
        initiationVia: {
          type: PaymentInitiationMethod.IntraLedger,
          counterPartyWalletId: recipientWalletId as WalletId,
          counterPartyUsername: username as Username,
        },
        settlementVia: {
          type: SettlementMethod.IntraLedger,
          counterPartyWalletId: recipientWalletId as WalletId,
          counterPartyUsername: username || null,
        },
      }
  }

  return walletTransaction
}

const fromLedger = (
  ledgerTransactions: LedgerTransaction<WalletCurrency>[],
): ConfirmedTransactionHistory => {
  const transactions = ledgerTransactions.map(translateLedgerTxnToWalletTxn)

  return {
    transactions,
    addPendingIncoming: (args) => ({
      transactions: [...filterPendingIncoming(args), ...transactions],
    }),
  }
}

const shouldDisplayMemo = ({
  memo,
  credit,
  currency,
}: {
  memo: string | undefined
  credit: CurrencyBaseAmount
  currency: WalletCurrency
}) => {
  if (isAuthorizedMemo(memo) || credit === 0) return true

  if (currency === WalletCurrency.Btc) return credit >= MEMO_SHARING_SATS_THRESHOLD

  return credit >= MEMO_SHARING_CENTS_THRESHOLD
}

const isAuthorizedMemo = (memo: string | undefined): boolean =>
  !!memo && Object.keys(OnboardingEarn).includes(memo)

export const translateMemo = ({
  memoFromPayer,
  lnMemo,
  credit,
  currency,
}: {
  memoFromPayer?: string
  lnMemo?: string
  credit: CurrencyBaseAmount
  currency: WalletCurrency
}): string | null => {
  const memo = memoFromPayer || lnMemo
  if (shouldDisplayMemo({ memo, credit, currency })) {
    return memo || null
  }

  return null
}

export const WalletTransactionHistory = {
  fromLedger,
} as const

// TODO: refactor this to use PriceRatio eventually instead after
// 'usd' property removal from db
const displayCurrencyPerBaseUnitFromAmounts = ({
  displayAmountAsNumber: displayAmountMinorUnit,
  settlementAmountInBaseAsNumber,
}: {
  displayAmountAsNumber: number
  settlementAmountInBaseAsNumber: number
}): number => {
  const displayAmountMajorUnit = Number((displayAmountMinorUnit / 100).toFixed(2))
  return settlementAmountInBaseAsNumber === 0
    ? 0
    : Math.abs(displayAmountMajorUnit / settlementAmountInBaseAsNumber)
}
