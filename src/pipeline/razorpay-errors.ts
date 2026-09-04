// The real Razorpay error taxonomy, transcribed from their public docs.
//
//   https://razorpay.com/docs/errors/payments/list/
//   https://razorpay.com/docs/errors/payments/upi/
//   https://razorpay.com/docs/payments/subscriptions/payment-retries/
//
// Two things this file exists to get right.
//
// FIRST, the shape. `source` is one of exactly four values — customer,
// business, gateway, razorpay. An earlier version of this project used
// `internal` and `issuer_bank`, which Razorpay's API never emits. Every case in
// the old seed file carried a source value that does not exist.
//
// SECOND, and the reason the model earns its place: **the error code is not a
// cause.** The docs themselves publish the same code against different sources
// and, on the UPI page, against different causes with only the description to
// separate them. `credit_failed` is either "the customer selected a different
// bank account than the one used at registration" — which only the customer can
// fix — or "partner bank downtime", which wants a retry. Same code. Opposite
// actions. A lookup table on the code cannot tell them apart; reading the
// description can, and that is a documented fact rather than a convenient
// assumption.

/** BLUEPRINT §3, corrected against the real API. */
export type ErrorSource = 'customer' | 'business' | 'gateway' | 'razorpay'

/** The payment step the failure occurred at. */
export type ErrorStep =
  | 'payment_initiation'
  | 'payment_authentication'
  | 'payment_authorization'
  | 'payment_capture'

/**
 * What actually went wrong. Wider than the error code set, because several
 * codes collapse to one cause and — the interesting direction — several causes
 * hide behind one code.
 */
export type Cause =
  // The money wasn't there, or a ceiling was hit.
  | 'insufficient_funds'
  | 'limit_exceeded'
  // The instrument itself is unusable.
  | 'card_expired'
  | 'instrument_blocked'
  | 'instrument_inactive'
  // Something upstream was down. Transient.
  | 'issuer_downtime'
  | 'gateway_downtime'
  | 'psp_downtime'
  // Mandate state.
  | 'mandate_cancelled_by_customer'
  | 'mandate_paused_by_customer'
  | 'mandate_not_authorised'
  | 'amount_exceeds_mandate_max'
  // The customer did something only they can undo.
  | 'wrong_account_selected'
  | 'customer_abandoned'
  // The merchant's own configuration is wrong.
  | 'merchant_config_error'
  // Declined on risk grounds — a human has to look.
  | 'risk_declined'
  // Might still settle on its own.
  | 'late_auth_pending'
  // Honestly undeterminable from what we were given.
  | 'unknown'

export const ALL_CAUSES: readonly Cause[] = [
  'insufficient_funds',
  'limit_exceeded',
  'card_expired',
  'instrument_blocked',
  'instrument_inactive',
  'issuer_downtime',
  'gateway_downtime',
  'psp_downtime',
  'mandate_cancelled_by_customer',
  'mandate_paused_by_customer',
  'mandate_not_authorised',
  'amount_exceeds_mandate_max',
  'wrong_account_selected',
  'customer_abandoned',
  'merchant_config_error',
  'risk_declined',
  'late_auth_pending',
  'unknown',
] as const

export type ErrorDef = {
  code: string
  source: ErrorSource
  step: ErrorStep
  /** The issuer/gateway description text, as the docs word it. */
  description: string
  /** What this really means. */
  cause: Cause
  /** Which rails this code can appear on. */
  methods: ('card' | 'upi' | 'emandate')[]
}

/**
 * The catalogue. Codes are verbatim from the docs; descriptions follow their
 * wording closely enough to be recognisable while reading as issuer text.
 *
 * Entries flagged `ambiguous` are where the interesting work is. Note that they
 * are not vague — several are highly specific. They are ambiguous *to a lookup
 * table keyed on the code*, which is a different and more honest claim.
 */
export const ERROR_CATALOGUE: ErrorDef[] = [
  // ── Funds and limits ────────────────────────────────────────────────────
  {
    code: 'insufficient_funds',
    source: 'customer',
    step: 'payment_authorization',
    description: "The customer's bank account did not have enough funds to cover the amount presented.",
    cause: 'insufficient_funds',
    methods: ['card', 'upi', 'emandate'],
  },
  {
    code: 'transaction_limit_exceeded',
    source: 'customer',
    step: 'payment_authorization',
    description: 'The amount presented exceeds the credit or debit limit set on this instrument.',
    cause: 'limit_exceeded',
    methods: ['card'],
  },
  {
    code: 'transaction_daily_limit_exceeded',
    source: 'customer',
    step: 'payment_authorization',
    description: 'The daily transaction limit on this card has already been exhausted.',
    cause: 'limit_exceeded',
    methods: ['card', 'upi'],
  },
  {
    code: 'credit_limit_exceeded',
    source: 'customer',
    step: 'payment_authorization',
    description: "The customer's available credit limit has been exceeded.",
    cause: 'limit_exceeded',
    methods: ['card'],
  },

  // ── Instrument broken ───────────────────────────────────────────────────
  {
    code: 'card_expired',
    source: 'customer',
    step: 'payment_authentication',
    description: 'The card stored against this mandate has expired.',
    cause: 'card_expired',
    methods: ['card'],
  },
  {
    // Appears in the docs under BOTH source: customer and source: gateway,
    // and the customer-sourced description says "blocked by issuer OR
    // customer" — two different situations behind one code.
    code: 'debit_instrument_blocked',
    source: 'customer',
    step: 'payment_authorization',
    description: 'The card has been blocked. This may have been done by the issuing bank or by the customer themselves.',
    cause: 'instrument_blocked',
    methods: ['card'],
  },
  {
    code: 'debit_instrument_blocked',
    source: 'gateway',
    step: 'payment_authorization',
    description: 'The issuing bank has blocked this card for recurring online debits.',
    cause: 'instrument_blocked',
    methods: ['card'],
  },
  {
    code: 'debit_instrument_inactive',
    source: 'gateway',
    step: 'payment_authorization',
    description: 'The debit instrument is inactive and cannot be charged.',
    cause: 'instrument_inactive',
    methods: ['card', 'emandate'],
  },

  // ── Upstream downtime. Transient — the holdout arm recovers a lot of it. ─
  {
    code: 'bank_not_available',
    source: 'gateway',
    step: 'payment_authorization',
    description: "The customer's bank was unavailable due to downtime when the debit was presented.",
    cause: 'issuer_downtime',
    methods: ['card', 'upi', 'emandate'],
  },
  {
    code: 'bank_technical_error',
    source: 'gateway',
    step: 'payment_authorization',
    description: "The bank's Core Banking System encountered a technical error while processing the debit.",
    cause: 'issuer_downtime',
    methods: ['card', 'emandate'],
  },
  {
    code: 'bank_cutoff_in_progress',
    source: 'gateway',
    step: 'payment_authorization',
    description: 'The bank CBS cutoff was in progress when the debit was presented.',
    cause: 'issuer_downtime',
    methods: ['emandate'],
  },
  {
    code: 'issuer_technical_error',
    source: 'gateway',
    step: 'payment_authorization',
    description: 'A technical error occurred at the card issuer.',
    cause: 'issuer_downtime',
    methods: ['card'],
  },
  {
    // The UPI docs list this code under two distinct causes: "technical issues
    // from the partner bank" and "partner bank downtime". Different remedies.
    code: 'gateway_technical_error',
    source: 'gateway',
    step: 'payment_initiation',
    description: 'The transaction could not be completed because of a technical fault in the payment gateway itself.',
    cause: 'gateway_downtime',
    methods: ['upi', 'emandate'],
  },
  {
    code: 'payment_declined_due_to_high_traffic',
    source: 'gateway',
    step: 'payment_initiation',
    description: 'The payment was declined because of high traffic at the gateway.',
    cause: 'gateway_downtime',
    methods: ['card', 'upi'],
  },
  {
    code: 'psp_app_not_available',
    source: 'gateway',
    step: 'payment_authorization',
    description: "The customer's UPI app was unavailable due to downtime.",
    cause: 'psp_downtime',
    methods: ['upi'],
  },
  {
    code: 'upi_app_technical_error',
    source: 'gateway',
    step: 'payment_authorization',
    description: "A technical error occurred at the customer's PSP.",
    cause: 'psp_downtime',
    methods: ['upi'],
  },

  // ── Mandate state ───────────────────────────────────────────────────────
  {
    code: 'mandate_revoked',
    source: 'customer',
    step: 'payment_authorization',
    description: 'The customer has revoked this mandate with their bank.',
    cause: 'mandate_cancelled_by_customer',
    methods: ['card', 'upi', 'emandate'],
  },
  {
    code: 'mandate_paused',
    source: 'customer',
    step: 'payment_authorization',
    description: 'The mandate has been paused by the customer and cannot be debited until they resume it.',
    cause: 'mandate_paused_by_customer',
    methods: ['upi', 'emandate'],
  },
  {
    code: 'reqauth_mandate_not_acknowledged',
    source: 'gateway',
    step: 'payment_authorization',
    description: 'The pre-debit notification for this mandate was not acknowledged before the debit was presented.',
    cause: 'mandate_not_authorised',
    methods: ['upi', 'emandate'],
  },
  {
    code: 'funds_blocked_by_mandate',
    source: 'gateway',
    step: 'payment_authorization',
    description: 'The funds are already blocked against an existing mandate on this account.',
    cause: 'mandate_not_authorised',
    methods: ['upi'],
  },
  {
    code: 'upi_autopay_not_supported_on_psp',
    source: 'gateway',
    step: 'payment_initiation',
    description: "UPI Autopay is not supported on the customer's PSP app.",
    cause: 'mandate_not_authorised',
    methods: ['upi'],
  },
  {
    code: 'mcc_amount_limit_exceeded',
    source: 'business',
    step: 'payment_authorization',
    description: 'The amount presented exceeds the limit configured for this merchant category code.',
    cause: 'amount_exceeds_mandate_max',
    methods: ['card', 'upi', 'emandate'],
  },

  // ── Merchant configuration — the merchant's problem, not the customer's ──
  {
    code: 'recurring_payment_not_enabled',
    source: 'business',
    step: 'payment_initiation',
    description: 'Recurring payments are not enabled on this account for the method presented.',
    cause: 'merchant_config_error',
    methods: ['card', 'upi', 'emandate'],
  },
  {
    code: 'international_transaction_not_allowed',
    source: 'customer',
    step: 'payment_authorization',
    description: 'International transactions are not permitted on this instrument.',
    cause: 'merchant_config_error',
    methods: ['card'],
  },

  // ── Risk ────────────────────────────────────────────────────────────────
  {
    code: 'payment_risk_check_failed',
    source: 'gateway',
    step: 'payment_authorization',
    description: 'The payment was declined by risk checks.',
    cause: 'risk_declined',
    methods: ['card', 'upi'],
  },

  // ── Might still settle ──────────────────────────────────────────────────
  {
    code: 'payment_pending',
    source: 'gateway',
    step: 'payment_authorization',
    description: 'The payment is pending and has not yet completed. Confirmation may take more than 24 hours.',
    cause: 'late_auth_pending',
    methods: ['card', 'upi', 'emandate'],
  },
  {
    code: 'verification_failed',
    source: 'razorpay',
    step: 'payment_authorization',
    description: 'Verification of the payment via a status check did not complete. This is usually temporary.',
    cause: 'late_auth_pending',
    methods: ['card', 'upi', 'emandate'],
  },

  // ── The genuinely ambiguous tail ────────────────────────────────────────
  // These are where the model earns its keep. Each is a code the docs give
  // more than one meaning, separated only by the description text.
  {
    code: 'credit_failed',
    source: 'gateway',
    step: 'payment_authorization',
    description:
      'The customer selected a bank account different from the one registered against this mandate, so the debit could not be applied.',
    cause: 'wrong_account_selected',
    methods: ['upi'],
  },
  {
    code: 'credit_failed',
    source: 'gateway',
    step: 'payment_authorization',
    description: 'The debit could not be applied because the sponsor bank routing this payment was in an outage.',
    cause: 'gateway_downtime',
    methods: ['upi'],
  },
  {
    code: 'payment_timed_out',
    source: 'customer',
    step: 'payment_authentication',
    description: 'The customer did not complete the authorisation within the permitted time.',
    cause: 'customer_abandoned',
    methods: ['upi', 'card'],
  },
  {
    code: 'payment_timed_out',
    source: 'gateway',
    step: 'payment_authorization',
    description: 'The request timed out waiting on the partner bank, which was not responding.',
    cause: 'issuer_downtime',
    methods: ['upi', 'card'],
  },
  {
    // The UPI page gives gateway_technical_error two readings: a technical
    // fault at the partner bank, and a full outage. Different remedies —
    // one is worth an immediate reschedule, the other wants a different rail.
    code: 'gateway_technical_error',
    source: 'gateway',
    step: 'payment_initiation',
    description: "The request could not be placed because the customer's UPI application is currently unreachable.",
    cause: 'psp_downtime',
    methods: ['upi', 'emandate'],
  },

  // Generic codes. The code says nothing; the issuer's advice text sometimes
  // says everything. This is the realistic case for a model over a lookup
  // table — and note the last of each group really is undeterminable, so the
  // confidence floor is exercised rather than assumed.
  {
    code: 'payment_declined',
    source: 'gateway',
    step: 'payment_authorization',
    description:
      'Funds could not be debited: the issuer reported the balance available was below the amount presented.',
    cause: 'insufficient_funds',
    methods: ['card', 'upi', 'emandate'],
  },
  {
    code: 'payment_declined',
    source: 'gateway',
    step: 'payment_authorization',
    description:
      'Funds could not be debited: the issuer reported the instrument is restricted for recurring debits.',
    cause: 'instrument_blocked',
    methods: ['card', 'emandate'],
  },
  {
    code: 'payment_declined',
    source: 'gateway',
    step: 'payment_authorization',
    description: 'Funds could not be debited from the account. The issuer returned no further advice.',
    cause: 'unknown',
    methods: ['card', 'upi', 'emandate'],
  },
  {
    code: 'payment_failed',
    source: 'gateway',
    step: 'payment_authorization',
    description:
      "The payment failed. The customer's issuing bank did not respond within the authorisation window and the request was abandoned.",
    cause: 'issuer_downtime',
    methods: ['card', 'upi', 'emandate'],
  },
  {
    code: 'payment_failed',
    source: 'gateway',
    step: 'payment_authorization',
    description:
      'The payment failed at the gateway. The mandate registered for this subscription was not found at the bank.',
    cause: 'mandate_not_authorised',
    methods: ['upi', 'emandate'],
  },
  {
    code: 'payment_failed',
    source: 'gateway',
    step: 'payment_authorization',
    description: 'The payment failed at the gateway. No additional detail was returned.',
    cause: 'unknown',
    methods: ['card', 'upi', 'emandate'],
  },
  {
    code: 'card_declined',
    source: 'gateway',
    step: 'payment_authorization',
    description:
      'The card was declined by the issuer. The advice code indicates the stored credential is past its validity date.',
    cause: 'card_expired',
    methods: ['card'],
  },
  {
    code: 'card_declined',
    source: 'gateway',
    step: 'payment_authorization',
    description: 'The card was declined by the issuer without a specific decline reason.',
    cause: 'unknown',
    methods: ['card'],
  },
  {
    code: 'server_error',
    source: 'razorpay',
    step: 'payment_initiation',
    description: 'A technical error occurred while the request was being processed.',
    cause: 'unknown',
    methods: ['card', 'upi', 'emandate'],
  },
]

const key = (source: string, code: string) => `${source}|${code}`

/**
 * The `(source, code)` pairs that do NOT determine a cause — the same pair
 * appears in the catalogue with two or more different meanings.
 *
 * Derived from the table rather than hand-flagged, so it cannot drift out of
 * step with the data. `rules.ts` refuses to resolve anything in this set and
 * hands it to the model; `tests/errors.test.ts` asserts the set is non-empty
 * and that the rules table honours it.
 *
 * This is the honest version of "the ambiguous slice". These cases are not
 * vague — several carry very specific issuer advice. They are ambiguous *to a
 * lookup table keyed on the error code*, which is a narrower and far more
 * defensible claim than "the error was uninformative".
 */
export const AMBIGUOUS_KEYS: ReadonlySet<string> = new Set(
  [...new Set(ERROR_CATALOGUE.map((e) => key(e.source, e.code)))].filter((k) => {
    const causes = new Set(
      ERROR_CATALOGUE.filter((e) => key(e.source, e.code) === k).map((e) => e.cause),
    )
    return causes.size > 1
  }),
)

export function isAmbiguous(source: string, code: string): boolean {
  return AMBIGUOUS_KEYS.has(key(source, code))
}

/** Entries a rules table can safely resolve on `(source, code)` alone. */
export const DETERMINISTIC_ENTRIES = ERROR_CATALOGUE.filter((e) => !isAmbiguous(e.source, e.code))

/** Entries only the model can separate, because the code alone is not enough. */
export const AMBIGUOUS_ENTRIES = ERROR_CATALOGUE.filter((e) => isAmbiguous(e.source, e.code))

/** Every distinct code in the catalogue. */
export const ALL_CODES: readonly string[] = [...new Set(ERROR_CATALOGUE.map((e) => e.code))]
