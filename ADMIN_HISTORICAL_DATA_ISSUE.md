# PrintBit Admin Historical Data Audit, September 16-20, 2026

I checked the SQLite database again, specifically the period **September 16, 2026 through September 20, 2026**.

The important conclusion is:

> **PrintBit did not completely fail to record activity during September 16-20. It recorded a substantial amount of operational data, but the financial transaction layer and the Admin Overview layer were not synchronized with that data.**

This is why the dates can appear empty or show `₱0` / `0 transactions` in Admin even though the database contains many jobs.

---

# 1. What actually happened

The database currently has multiple separate storage systems for PrintBit activity:

```text
print_jobs
    ↓
Printer/job execution history

coin_bridge_events
    ↓
Raw coin acceptance events

receipt_records
    ↓
Customer-facing transaction receipts

accepted_coin_events
    ↓
Coins attributed to a specific transaction

cash_actions
    ↓
Change/hopper operations

deferred_transactions
    ↓
Authoritative transaction lifecycle

runtime_state
    ↓
Current Admin Overview/cache/state
```

The problem is that **these layers are not being committed as one transactionally consistent unit**.

During September 16-18, the system was clearly creating `print_jobs`, but the corresponding financial transaction records were absent.

During September 19, the newer receipt system started recording transactions, but the Admin runtime counters were still not updated.

---

# 2. What exists from September 16-20

## September 16

```text
Completed print jobs: 38
Required amounts in job metadata: ₱327
Receipts: 0
Accepted-coin transaction events: 0
Cash-action records: 0
Deferred transactions: 0
```

However, there were also:

```text
84 coin bridge events
₱347 total raw coin input
```

So PrintBit **did receive and persist coin activity**, but those coins were not converted into authoritative transaction records.

The system therefore has evidence like:

```text
Coin inserted
    ↓
coin_bridge_events ✅

Job printed
    ↓
print_jobs ✅

Financial transaction
    ↓
missing ❌
```

---

# 3. September 17

There were:

```text
30 completed print jobs
₱215 required amount in job metadata
```

There were also:

```text
78 coin bridge events
₱327 raw coin input
```

But there were still no proper receipt records or transaction records.

There is one special case:

```text
copy-job-hist-1
₱35
```

was manually reconstructed from an Admin log.

Unfortunately, it was inserted **twice** into `runtime_state.financialLedger`.

So the ledger contains:

```text
₱35
₱35
----
₱70
```

even though both entries refer to:

```text
copy-job-hist-1
```

This is a historical-reconciliation bug.

---

# 4. September 18

There were:

```text
47 completed print jobs
₱210 required amount in job metadata
```

and:

```text
75 coin bridge events
₱268 raw coin input
```

Again:

```text
print_jobs ✅
coin_bridge_events ✅

receipt_records ❌
accepted_coin_events ❌
cash_actions ❌
deferred_transactions ❌
```

So September 18 contains a lot of operational history, but not a reliable financial transaction trail.

---

# 5. September 19 is where the newer transaction system appears

September 19 has:

```text
12 completed print jobs
7 receipt records
₱63 receipt charges
```

This is a major difference from September 16-18.

The seven receipts are real database records and are internally consistent.

For example:

```text
Receipt revenue     ₱63
Change dispensed    ₱19
```

But there are still problems.

The 12 `print_jobs` have total pricing metadata that does not perfectly reconcile with the seven receipts.

More importantly:

```text
print_jobs                 12
receipt_records              7
```

So five jobs do not have corresponding receipts, depending on which records are being reconciled and how the transaction pipeline is interpreted.

Additionally:

```text
coin_bridge_events = 23
raw coin input     = ₱187
```

but:

```text
receipt charges    = ₱63
change dispensed   = ₱19
```

The raw coin events therefore cannot simply be interpreted as earnings. They include money that cannot currently be safely attributed to finalized transactions.

---

# 6. September 20 did not lose the historical jobs

September 20 itself has no completed jobs.

However, Admin activity occurred normally:

```text
admin login attempts
settings changes
receipt cleanup
upload sessions
report issue updates
trusted time synchronization
hopper self-test
```

So the application was functioning and writing to SQLite.

This is important because it makes **"SQLite stopped working" unlikely**.

The database itself reports:

```text
integrity_check = ok
journal_mode   = wal
synchronous    = FULL
```

So there is no evidence here of database corruption causing the missing Admin statistics.

---

# 7. Why Admin displays zero

This is the most important discovery.

The database has:

```text
print_jobs = 127
receipt_records = 7
```

but `runtime_state` contains:

```json
{
  "earnings": 100,
  "jobStats": {
    "total": 0,
    "print": 0,
    "copy": 0,
    "scan": 0
  },
  "coinStats": {
    "one": 0,
    "five": 0,
    "ten": 0,
    "twenty": 0
  },
  "receiptRecords": []
}
```

This is a direct data inconsistency.

The most likely architectural explanation is:

```text
                  ┌───────────────────┐
                  │ SQLite tables     │
                  │                   │
                  │ print_jobs = 127  │
                  │ receipts = 7      │
                  └─────────┬─────────┘
                            │
                            │ NOT RECOMPUTED
                            ▼
                  ┌───────────────────┐
                  │ runtime_state    │
                  │                   │
                  │ jobs = 0          │
                  │ earnings = 100    │
                  │ receipts = []     │
                  └─────────┬─────────┘
                            │
                            ▼
                    Admin Overview
```

In other words, **your relational database has historical records, but your Admin Overview is still relying on stale runtime state or a stale aggregate rather than deriving its values from authoritative historical records.**

I cannot identify the exact TypeScript/Node.js function responsible without your PrintBit source code, but the database evidence strongly points to this synchronization/design problem.

---

# 8. There are actually two different problems

## Problem A: Data was not fully recorded

September 16-18 have:

```text
print_jobs ✅
coin_bridge_events ✅
```

but:

```text
deferred_transactions ❌
accepted_coin_events ❌
cash_actions ❌
receipt_records ❌
```

Therefore a completed job does not automatically have a completed financial transaction record.

That is a **backend persistence problem**.

---

## Problem B: Data exists but Admin does not use it

For September 19:

```text
receipt_records = 7
```

but:

```text
runtime_state.receiptRecords = []
runtime_state.jobStats.total = 0
```

This means even when newer records exist, the Overview still has stale state.

That is an **aggregation/read-model problem**.

---

# 9. Why you should not simply set Earnings to the sum of `print_jobs`

This is extremely important.

For September 16:

```text
print_jobs required amount = ₱327
coin input                = ₱347
```

These are not necessarily both revenue.

A job's:

```text
requiredAmount
```

means what the transaction was supposed to cost.

It does **not necessarily prove that the customer successfully paid that amount**.

Similarly:

```text
coin_bridge_events
```

proves that coins were detected, but without transaction attribution and change records it does not prove how much should be recognized as revenue.

Therefore:

```text
print_jobs → revenue
```

is unsafe.

And:

```text
coin_bridge_events → revenue
```

is also unsafe.

---

# 10. The correct source of truth

You should define a single authoritative financial transaction.

A completed transaction should conceptually be:

```text
Transaction
├── transaction_id
├── created_at
├── mode
├── required_amount
├── tendered_amount
├── change_requested
├── change_dispensed
├── final_amount
├── status
├── completed_at
└── reconciliation_status
```

Then events belong to that transaction:

```text
transaction
   │
   ├── accepted coins
   ├── print job
   ├── worker events
   ├── change/hopper actions
   └── receipt
```

The relationship should be:

```text
transaction_id
     │
     ├── print_jobs.transaction_id
     ├── accepted_coin_events.target_transaction_id
     ├── cash_actions.transaction_id
     ├── worker_print_events.transaction_id
     ├── receipt_records.transaction_id
     └── student_transaction_attributions.transaction_id
```

That is much safer than having several independent counters.

---

# 11. What Admin Overview should do

Do **not** let Admin Overview depend directly on:

```text
runtime_state.earnings
runtime_state.jobStats
runtime_state.coinStats
```

as permanent historical truth.

Instead:

```text
Admin Overview
       ↓
Financial reporting queries
       ↓
Authoritative transaction ledger
```

For example:

```sql
SELECT
    COUNT(*) AS transaction_count,
    COALESCE(SUM(final_amount), 0) AS earnings
FROM transactions
WHERE status = 'completed';
```

And:

```sql
SELECT
    mode,
    COUNT(*) AS count,
    COALESCE(SUM(final_amount), 0) AS revenue
FROM transactions
WHERE status = 'completed'
GROUP BY mode;
```

Then the Admin UI automatically works for:

```text
Today
Yesterday
September 16
September 17
September 18
September 19
This month
Last month
Any historical month
```

without maintaining a separate manually updated counter.

---

# 12. How to repair September 16-20

Do **not** simply edit:

```text
earnings = 100
```

to another number.

That would hide the underlying problem.

Instead, create a **historical reconciliation process**.

## Step 1 - Preserve the original database

Before modifying anything:

```text
printbit.sqlite
        ↓
printbit-before-reconciliation.sqlite
```

Never perform the repair against your only copy.

---

## Step 2 - Build a reconciliation report

For every `print_job` from September 16-20:

```text
transaction_id
job_id
mode
created_at
required_amount
state
```

Then attempt to match it against:

```text
receipt_records
deferred_transactions
accepted_coin_events
cash_actions
worker_print_events
coin_bridge_events
```

Matching should primarily use:

```text
transaction_id
```

and only use time/session/correlation identifiers as secondary evidence.

---

# 13. Classify each historical transaction

Every historical job should end up in one of these categories:

### `RECONCILED_COMPLETED`

Enough evidence exists to prove:

```text
job completed
+
payment completed
+
amount known
```

This can be included in revenue.

### `RECONCILED_REFUNDED`

The transaction completed but the money was refunded.

Revenue should be adjusted accordingly.

### `FAILED_NO_CHARGE`

The job failed and no payment was retained.

Do not count it as revenue.

### `PAID_BUT_UNRESOLVED`

Payment evidence exists, but the final job/cash outcome is incomplete.

This should be shown to Admin as unresolved, not silently included as revenue.

### `JOB_ONLY`

A printed job exists but there is insufficient evidence about payment.

This is exactly the situation many September 16-18 records appear to be in.

Do not invent a payment amount.

---

# 14. What you can safely recover from September 16-18

You can recover:

```text
number of print jobs
job modes
job timestamps
required prices
document/session identifiers
consumable usage
raw coin events
```

But you **cannot safely reconstruct exact earnings for every transaction solely from these records**.

That distinction needs to be visible in Admin.

For example:

```text
September 16

Completed jobs:          38
Quoted/required value: ₱327
Verified revenue:        Unknown
Unreconciled jobs:       38
```

That is much more honest than:

```text
Revenue: ₱327
```

when the database cannot prove that amount was actually collected.

---

# 15. September 19 can be partially reconciled

September 19 has the strongest financial evidence because the receipt table exists.

Those receipts should become the basis for the **verified revenue** for that date.

Something such as:

```text
Verified transactions: 7
Verified revenue:      ₱63
Verified change:       ₱19
Unreconciled jobs:     remaining jobs without financial records
```

The raw `₱187` from `coin_bridge_events` should **not** be displayed as revenue.

Instead it can be a separate diagnostic field:

```text
Raw coin input detected: ₱187
```

provided you clearly label it as raw input and not earnings.

---

# 16. Fix the duplicate financial ledger entry

The historical entries:

```text
copy-job-hist-1
₱35
```

appear twice.

The proper fix is not:

```text
delete one row and move on
```

Instead, mark the duplicate as something like:

```text
reconciliation_status = duplicate
duplicate_of = <canonical ledger entry>
```

or migrate it into a proper transaction/reconciliation table.

That preserves the audit trail.

---

# 17. Fix all other Admin data the same way

The same principle should apply beyond earnings.

### Earnings

Source:

```text
completed financial transactions
```

### Transaction count

Source:

```text
completed financial transactions
```

### Print count

Source:

```text
completed transactions WHERE mode='print'
```

### Copy count

Source:

```text
completed transactions WHERE mode='copy'
```

### Scan count

Source:

```text
completed transactions WHERE mode='scan'
```

### Cash inserted

Source:

```text
accepted_coin_events
```

but only when correctly attributed to a transaction.

### Change dispensed

Source:

```text
cash_actions
```

### Failed jobs

Source:

```text
print_jobs
+
transaction status
```

### Printer incidents

Source:

```text
admin_logs
+
anomaly incidents
```

### Consumables

Source:

```text
consumable_usage_events
consumable_ink_snapshots
```

### User/student attribution

Source:

```text
student_transaction_attributions
```

This creates a consistent reporting architecture.

---

# 18. Do not use `runtime_state` as a historical database

This is probably the biggest architectural change I would make.

`runtime_state` is appropriate for:

```text
current balance
current settings
current hopper status
current alerts
current active state
current UI/runtime configuration
```

It is not ideal as the permanent source of:

```text
lifetime earnings
historical transaction counts
historical receipts
monthly revenue
daily revenue
```

Those should come from persistent transactional tables.

---

# 19. What should happen after the fix

The system should follow this pipeline:

```text
Customer starts transaction
        ↓
Create transaction
        ↓
Assign transaction_id
        ↓
Accept coins
        ↓
Record accepted_coin_events
        ↓
Payment settled
        ↓
Print/copy/scan execution
        ↓
Record worker/job events
        ↓
Output confirmed
        ↓
Dispense change
        ↓
Record cash_actions
        ↓
Complete transaction
        ↓
Create permanent transaction ledger entry
        ↓
Create customer receipt
        ↓
Admin queries transaction ledger
```

The crucial property is:

> **Every financial event must reference the same transaction ID.**

---

# 20. Add idempotency protection

Your database already has some useful infrastructure for this, including:

```text
idempotency_key
transaction_id
spooler_correlation_key
```

Use them aggressively.

A transaction should not be capable of creating:

```text
₱35
₱35
```

because the request was processed twice.

There should be a uniqueness constraint such as:

```sql
UNIQUE(idempotency_key)
```

and the financial completion operation should be idempotent.

This directly addresses the duplicate `copy-job-hist-1` problem.

---

# 21. Keep receipts separate from permanent transactions

Your current receipts expire after approximately 24 hours.

That is reasonable for:

```text
QR receipt access
temporary receipt retrieval
receipt download
```

But it should not mean:

```text
financial history deleted after 24h
```

The architecture should be:

```text
Permanent transaction
        ↓
kept indefinitely

Temporary receipt/token
        ↓
expires after configured period
```

Therefore historical Admin reports should continue to work in:

```text
September 2026
August 2026
July 2026
etc.
```

even when customer QR receipts have expired.

---

# 22. Create a proper Admin reconciliation page

For deployment, I strongly recommend adding something like:

```text
Admin
└── Reports
    ├── Overview
    ├── Transactions
    ├── Revenue
    └── Reconciliation
```

The Reconciliation page could show:

```text
Date                 Status
--------------------------------------------
Sep 16, 2026          38 unresolved
Sep 17, 2026          30 unresolved
Sep 18, 2026          47 unresolved
Sep 19, 2026           7 verified
```

Then Admin can inspect:

```text
transaction ID
job ID
amount
payment evidence
print result
change
receipt
reconciliation status
```

This is much safer than silently backfilling numbers.

---

# 23. Historical repair strategy for all months

Do not make the migration specific to September.

Build a reusable reconciliation command, for example:

```text
pnpm reconcile:transactions
```

or:

```text
node scripts/reconcile-transactions.js
```

Conceptually:

```text
Read every historical job
        ↓
Find matching transaction
        ↓
Find payment evidence
        ↓
Find change evidence
        ↓
Find receipt
        ↓
Determine final status
        ↓
Create/update canonical transaction
        ↓
Flag unresolved records
        ↓
Rebuild reporting indexes
```

Then run it across:

```text
all historical dates
```

not just:

```text
September 16-20
```

This prevents the same problem from appearing in August, July, etc.

---

# 24. Add a database integrity check for Admin

Every startup or scheduled maintenance cycle could verify:

```text
Completed transaction count
        vs
Receipt count

Completed transaction count
        vs
Job count

Payment records
        vs
Cash records

Ledger total
        vs
Transaction total
```

For example:

```text
FINANCIAL RECONCILIATION

Transactions:           127
Jobs:                   127
Receipts:                 7
Unreconciled:           120

Verified Revenue:      ₱63
Raw Coin Input:        ₱829
Ledger Discrepancy:     YES
```

That would immediately tell the administrator that the historical data is incomplete instead of showing:

```text
Earnings: ₱100
Transactions: 0
```

which looks valid but is misleading.

---

# 25. The September 16-20 situation in one diagram

Current state:

```text
                 SEPT 16-18
                     │
          ┌──────────┴──────────┐
          │                     │
     print_jobs ✅       coin_bridge_events ✅
          │                     │
          └──────────┬──────────┘
                     │
               financial txn ❌
                     │
              Admin Overview ❌


                 SEPT 19
                     │
          ┌──────────┼──────────┐
          │          │          │
     print_jobs ✅ receipts ✅ coin bridge ✅
          │          │          │
          └──────────┼──────────┘
                     │
             runtime_state ❌
                     │
              Admin Overview ❌


                 SEPT 20
                     │
               Admin activity ✅
                     │
               no new jobs ✅
```

So this is **not primarily a corrupted SQLite database**.

It is a **transaction persistence + reconciliation + reporting architecture problem**.

---

# 26. What I would do first

### Phase 1 - Protect the existing evidence

```text
Backup SQLite
↓
Never delete historical rows
↓
Never overwrite raw events
```

### Phase 2 - Build the canonical transaction model

```text
transactions
transaction_events
transaction_reconciliation
```

### Phase 3 - Fix the live transaction pipeline

Every transaction must create its financial record and link:

```text
coins
job
worker
cash
receipt
```

through the same `transaction_id`.

### Phase 4 - Fix Admin reporting

Admin Overview must query the canonical transaction data rather than `runtime_state.earnings` and `runtime_state.jobStats`.

### Phase 5 - Historical reconciliation

Run the migration against:

```text
September 16-20
```

then:

```text
all previous months
```

### Phase 6 - Show unresolved historical records

Do **not** fabricate missing revenue.

Use:

```text
Verified
Unverified
Failed
Refunded
Duplicate
Unreconciled
```

statuses.

---

# Final conclusion

The September 16-20 data is **not simply "missing."**

A better description is:

> **PrintBit recorded the underlying operational activity, but the application failed to promote that activity consistently into its authoritative financial transaction records, and the Admin Overview is using stale runtime aggregates instead of reconstructing its statistics from persistent historical transactions.**

The evidence is particularly strong because:

```text
Sep 16-18:
127 print jobs exist
but 0 receipt records exist

Sep 19:
7 receipt records exist
but runtime_state still says 0 jobs / 0 receipts

Current:
runtime_state.earnings = ₱100
financialLedger = ₱70
Sep 19 verified receipts = ₱63
```

Those numbers cannot all represent the same accounting truth.

**The correct fix is therefore not merely "make the Admin page display the old records." The transaction pipeline itself needs one authoritative financial ledger, and Admin should derive its historical statistics from that ledger.**

For the historical September 16-20 records, **preserve everything, reconcile what can be proven, mark what cannot be proven as unresolved, and never infer revenue solely from `print_jobs` or raw coin events.**
